import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  adminAuthError,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  isLoopbackHost,
  jsonResponse,
  parseUnknownRequestBody,
  queryRecord,
  readBody,
  readInteger,
  readTrimmedString,
  RequestBodyTooLargeError,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";
import {
  SLACK_CHANNEL_ID_RULE,
  SLACK_SEND_TARGET_ID_RULE,
  SLACK_TS_RULE,
  SLACK_USER_ID_RULE,
} from "../providers/slack-ids.js";
import {
  recordCommittedServerEvent,
  recordServerEvent,
  type ServerEventObserver,
} from "./recorder.js";
import {
  postWebhookRequestWithResponse,
  validateWebhookTarget,
  type WebhookAddress,
  type WebhookResponse,
  type WebhookTargetError,
} from "./webhook-target.js";

const SLACK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const SLACK_EVENT_MAX_RETRIES = 3;
const SLACK_EVENT_MAX_REDIRECTS = 2;
const SLACK_EVENT_RETRY_DELAYS_MS = [0, 60_000, 5 * 60_000] as const;

type SlackMessage = {
  attachments?: unknown;
  blocks?: unknown;
  bot_id?: string;
  channel: string;
  metadata?: unknown;
  reply_broadcast?: boolean;
  text: string;
  thread_ts?: string;
  ts: string;
  type: "message";
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  user: string;
};

type SlackServerState = {
  activeEventDeliveries: Set<Promise<void>>;
  adminToken: string;
  allowLoopbackHttpEvents: boolean;
  botId: string;
  botToken: string;
  botUserId: string;
  chatPostMessageRateLimit:
    | {
        remaining: number;
        retryAfterSeconds: number;
      }
    | undefined;
  closing: boolean;
  deliveryAbortController: AbortController;
  eventsRequestUrl: string | undefined;
  nextDmIndex: number;
  nextMpimIndex: number;
  nextTsIndex: number;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
  restrictEventTargets: boolean;
  signingSecret: string;
  userDmChannels: Map<string, string>;
  userMpimChannels: Map<string, { id: string; users: string[] }>;
  messagesByChannel: Map<string, SlackMessage[]>;
};
type SlackRecorderEvent = ServerRequestEvent & {
  accepted?: boolean | undefined;
};

type SlackRetryReason =
  | "connection_failed"
  | "http_error"
  | "http_timeout"
  | "ssl_error"
  | "too_many_redirects"
  | "unknown_error";

type SlackCursorKind = "history" | "replies";

class SlackEventTargetError extends Error {
  constructor(
    readonly retryReason: SlackRetryReason,
    targetError: WebhookTargetError,
  ) {
    super(`Slack Events API target rejected: ${targetError}`);
    this.name = "SlackEventTargetError";
  }
}

export type SlackServerManifest = {
  adminToken: string;
  baseUrl: string;
  botToken: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    eventsUrl: string;
  };
  env: {
    SLACK_API_URL: string;
    SLACK_BOT_TOKEN: string;
    SLACK_SIGNING_SECRET: string;
  };
  provider: "slack";
  recorderPath: string;
  signingSecret: string;
  version: 1;
};

export type StartedSlackServer = {
  close(): Promise<void>;
  manifest: SlackServerManifest;
};

export type StartSlackServerParams = {
  adminToken?: string | undefined;
  botId?: string | undefined;
  botToken?: string | undefined;
  botUserId?: string | undefined;
  chatPostMessageRateLimit?:
    | {
        remaining: number;
        retryAfterSeconds: number;
      }
    | undefined;
  eventsRequestUrl?: string | undefined;
  host?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  signingSecret?: string | undefined;
};

function slackOk(result: Record<string, unknown> = {}): Response {
  return jsonResponse({ ok: true, ...result });
}

function slackError(error: string, status = 200): Response {
  return jsonResponse({ error, ok: false }, status);
}

function slackRateLimited(retryAfterSeconds = 1): Response {
  return new Response(JSON.stringify({ error: "ratelimited", ok: false }), {
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
    status: 429,
  });
}

function resolveChatPostMessageRateLimit(
  value: StartSlackServerParams["chatPostMessageRateLimit"],
): SlackServerState["chatPostMessageRateLimit"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.remaining) || value.remaining < 0) {
    throw new Error("chatPostMessageRateLimit.remaining must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(value.retryAfterSeconds) || value.retryAfterSeconds < 1) {
    throw new Error("chatPostMessageRateLimit.retryAfterSeconds must be a positive safe integer.");
  }
  return { ...value };
}

function requireSlackToken(
  request: IncomingMessage,
  body: Record<string, unknown>,
  state: SlackServerState,
): Response | undefined {
  const authorization = request.headers.authorization;
  const tokenFromHeader =
    typeof authorization === "string"
      ? /^Bearer\s+(.+)$/iu.exec(authorization.trim())?.[1]?.trim()
      : undefined;
  const token = tokenFromHeader ?? readTrimmedString(body.token);
  if (!token) {
    return slackError("not_authed");
  }
  if (token !== state.botToken) {
    return slackError("invalid_auth");
  }
  return undefined;
}

function requireSlackChannelId(value: unknown): string | Response {
  const stringValue = readTrimmedString(value);
  if (!stringValue || !SLACK_CHANNEL_ID_RULE.pattern.test(stringValue)) {
    return slackError("channel_not_found");
  }
  return stringValue;
}

function requireSlackSendTargetId(value: unknown): string | Response {
  const stringValue = readTrimmedString(value);
  if (!stringValue || !SLACK_SEND_TARGET_ID_RULE.pattern.test(stringValue)) {
    return slackError("channel_not_found");
  }
  return stringValue;
}

function requireSlackUserId(value: unknown): string | Response {
  const stringValue = readTrimmedString(value);
  if (!stringValue || !SLACK_USER_ID_RULE.pattern.test(stringValue)) {
    return slackError("invalid_users");
  }
  return stringValue;
}

function requireSlackThreadTs(value: unknown): string | Response | undefined {
  const stringValue = readTrimmedString(value);
  if (!stringValue) {
    return undefined;
  }
  if (!SLACK_TS_RULE.pattern.test(stringValue)) {
    return slackError("invalid_ts");
  }
  return stringValue;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const stringValue = readTrimmedString(value)?.toLowerCase();
  if (stringValue === "true" || stringValue === "1") {
    return true;
  }
  if (stringValue === "false" || stringValue === "0") {
    return false;
  }
  return undefined;
}

function readSlackText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStructuredValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const stringValue = value.trim();
  if (!stringValue) {
    return undefined;
  }
  try {
    return JSON.parse(stringValue) as unknown;
  } catch {
    return value;
  }
}

function readStructuredArray(value: unknown, error: string): unknown[] | Response | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = readStructuredValue(value);
  return Array.isArray(parsed) ? parsed : slackError(error);
}

function readSlackMetadata(value: unknown): Record<string, unknown> | Response | undefined {
  if (value === undefined) {
    return undefined;
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return slackError("invalid_metadata_format");
    }
  }
  if (!isJsonObject(parsed)) {
    return slackError("invalid_metadata_format");
  }
  if (!readTrimmedString(parsed.event_type) || !isJsonObject(parsed.event_payload)) {
    return slackError("invalid_metadata_schema");
  }
  return parsed;
}

function hasStructuredMessageContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value && typeof value === "object");
}

function messagesForChannel(state: SlackServerState, channel: string): SlackMessage[] {
  return state.messagesByChannel.get(channel) ?? [];
}

function hasThreadParent(
  state: SlackServerState,
  params: {
    channel: string;
    threadTs: string;
  },
): boolean {
  return messagesForChannel(state, params.channel).some(
    (message) => message.ts === params.threadTs && message.thread_ts === undefined,
  );
}

function resolveThreadTs(
  state: SlackServerState,
  params: {
    channel: string;
    ts: string;
  },
): string | undefined {
  const message = messagesForChannel(state, params.channel).find(
    (candidate) => candidate.ts === params.ts,
  );
  return message?.thread_ts ?? message?.ts;
}

function nextSlackTs(state: SlackServerState): string {
  const index = state.nextTsIndex++;
  return `${1_700_000_000 + Math.floor(index / 1_000_000)}.${String(index % 1_000_000).padStart(6, "0")}`;
}

function randomDecimalDigits(length: number): string {
  return Array.from({ length }, () => randomInt(10)).join("");
}

function nextDmChannelId(state: SlackServerState): string {
  const index = state.nextDmIndex++;
  return `D${String(index).padStart(9, "0")}`;
}

function nextMpimChannelId(state: SlackServerState): string {
  const index = state.nextMpimIndex++;
  return `G${String(index).padStart(9, "0")}`;
}

function dmChannelForUser(state: SlackServerState, userId: string): string {
  const existing = state.userDmChannels.get(userId);
  if (existing) {
    return existing;
  }
  const channelId = nextDmChannelId(state);
  state.userDmChannels.set(userId, channelId);
  return channelId;
}

function mpimChannelForUsers(
  state: SlackServerState,
  users: string[],
): { id: string; users: string[] } {
  const key = [...users].sort().join(",");
  const existing = state.userMpimChannels.get(key);
  if (existing) {
    return existing;
  }
  const channel = { id: nextMpimChannelId(state), users: [...users] };
  state.userMpimChannels.set(key, channel);
  return channel;
}

function requireSlackUsers(value: unknown, botUserId: string): string[] | Response {
  const rawUsers = readTrimmedString(value);
  if (!rawUsers) {
    return slackError("users_list_not_supplied");
  }
  const users = rawUsers.split(",").map((user) => user.trim());
  if (users.length > 8) {
    return slackError("too_many_users");
  }
  if (users.some((user) => !SLACK_USER_ID_RULE.pattern.test(user))) {
    return slackError("user_not_found");
  }
  if (new Set(users).size !== users.length) {
    return slackError("invalid_user_combination");
  }
  if (users.includes(botUserId)) {
    return slackError("invalid_user_combination");
  }
  return users;
}

function requireSlackLimit(value: unknown): number | Response {
  const limit = value === undefined ? 100 : readInteger(value);
  if (limit === undefined || limit < 1 || limit > 1_000) {
    return slackError("invalid_limit");
  }
  return limit;
}

function decodeSlackCursor(value: unknown, kind: SlackCursorKind): string | Response | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return slackError("invalid_cursor");
  }
  const cursor = value;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const prefix = `${kind}:`;
    if (!decoded.startsWith(prefix)) {
      return slackError("invalid_cursor");
    }
    const boundary = decoded.slice(prefix.length);
    return SLACK_TS_RULE.pattern.test(boundary) && encodeSlackCursor(kind, boundary) === cursor
      ? boundary
      : slackError("invalid_cursor");
  } catch {
    return slackError("invalid_cursor");
  }
}

function encodeSlackCursor(kind: SlackCursorKind, boundary: string): string {
  return Buffer.from(`${kind}:${boundary}`, "utf8").toString("base64url");
}

function appendMessage(state: SlackServerState, message: SlackMessage): SlackMessage {
  const messages = state.messagesByChannel.get(message.channel) ?? [];
  messages.push(message);
  state.messagesByChannel.set(message.channel, messages);
  return message;
}

async function appendEvent(state: SlackServerState, event: ServerRequestEvent, committed = false) {
  const params = { event, onEvent: state.onEvent, recorderPath: state.recorderPath };
  await (committed ? recordCommittedServerEvent(params) : recordServerEvent(params));
}

function redactSlackAuthFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key.toLowerCase() === "token" ? "[redacted]" : entry,
    ]),
  );
}

function redactSlackAuthQuery(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key.toLowerCase() === "token" ? "[redacted]" : entry,
    ]),
  );
}

function createSlackMessage(
  state: SlackServerState,
  params: {
    channel: string;
    text: string;
    threadTs?: string | undefined;
    user?: string | undefined;
    bot?: boolean | undefined;
    ts?: string | undefined;
    attachments?: unknown;
    blocks?: unknown;
    metadata?: unknown;
    replyBroadcast?: boolean | undefined;
    unfurlLinks?: boolean | undefined;
    unfurlMedia?: boolean | undefined;
  },
): SlackMessage {
  const ts = params.ts ?? nextSlackTs(state);
  return {
    ...(params.attachments ? { attachments: params.attachments } : {}),
    ...(params.blocks ? { blocks: params.blocks } : {}),
    ...(params.bot ? { bot_id: state.botId } : {}),
    channel: params.channel,
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.replyBroadcast === undefined ? {} : { reply_broadcast: params.replyBroadcast }),
    text: params.text,
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    ts,
    type: "message",
    ...(params.unfurlLinks === undefined ? {} : { unfurl_links: params.unfurlLinks }),
    ...(params.unfurlMedia === undefined ? {} : { unfurl_media: params.unfurlMedia }),
    user: params.user ?? (params.bot ? state.botUserId : "UCRABUSER"),
  };
}

function asSlackEventCallback(state: SlackServerState, message: SlackMessage) {
  return {
    api_app_id: "ACRABLINE",
    authorizations: [
      {
        enterprise_id: null,
        is_bot: true,
        is_enterprise_install: false,
        team_id: "TCRABLINE",
        user_id: state.botUserId,
      },
    ],
    event: message,
    event_id: `Ev${message.ts.replace(".", "")}`,
    event_time: Number(message.ts.slice(0, 10)),
    team_id: "TCRABLINE",
    token: "crabline-event-token",
    type: "event_callback",
  };
}

function slackRequestSignature(signingSecret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${digest}`;
}

function authenticateSlackEventsRequest(
  request: IncomingMessage,
  state: SlackServerState,
  rawBody: string,
): Response | undefined {
  const timestampHeader = request.headers["x-slack-request-timestamp"];
  const signatureHeader = request.headers["x-slack-signature"];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const timestampSeconds = timestamp ? Number(timestamp) : Number.NaN;
  if (
    !timestamp ||
    !signature ||
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > SLACK_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return new Response("unauthorized", { status: 401 });
  }
  const expected = Buffer.from(slackRequestSignature(state.signingSecret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  return undefined;
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  while (current && typeof current === "object" && chain.length < 4) {
    const entry = current as Record<string, unknown>;
    chain.push(entry);
    current = entry.cause;
  }
  return chain;
}

/** @internal */
export function classifySlackRetryReason(error: unknown): SlackRetryReason {
  if (error instanceof SlackEventTargetError) {
    return error.retryReason;
  }
  const chain = errorChain(error);
  const names = chain.map((entry) => String(entry.name ?? ""));
  const codes = chain.map((entry) => String(entry.code ?? "").toUpperCase());
  const messages = chain.map((entry) => String(entry.message ?? "").toLowerCase());
  if (
    codes.includes("UND_ERR_REDIRECT") ||
    messages.some((message) => message.includes("redirect count exceeded"))
  ) {
    return "too_many_redirects";
  }
  if (
    names.some((name) => name === "AbortError" || name === "TimeoutError") ||
    codes.some((code) =>
      ["ETIMEDOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code),
    )
  ) {
    return "http_timeout";
  }
  if (
    codes.some(
      (code) =>
        code.includes("CERT") ||
        code.includes("SSL") ||
        code.includes("TLS") ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    )
  ) {
    return "ssl_error";
  }
  if (
    codes.some((code) =>
      [
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ENOTFOUND",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(code),
    )
  ) {
    return "connection_failed";
  }
  return "unknown_error";
}

function slackResponseHeader(response: WebhookResponse, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function slackTargetRetryReason(error: WebhookTargetError): SlackRetryReason {
  return error === "https-required" ? "ssl_error" : "connection_failed";
}

async function postSlackEventRequest(params: {
  body: string;
  headerEntries: ReadonlyArray<readonly [string, string]>;
  signal: AbortSignal;
  state: SlackServerState;
  timeoutAt: number;
  url: URL;
}): Promise<WebhookResponse> {
  const target = await validateWebhookTarget({
    allowLoopbackHttp: params.state.allowLoopbackHttpEvents,
    restrictPrivateAddresses: params.state.restrictEventTargets,
    signal: params.signal,
    url: params.url,
  });
  if ("error" in target) {
    throw new SlackEventTargetError(slackTargetRetryReason(target.error), target.error);
  }

  const addresses: Array<WebhookAddress | undefined> =
    target.addresses && target.addresses.length > 0 ? target.addresses : [undefined];
  let lastError: unknown;
  for (const [index, address] of addresses.entries()) {
    const remainingMs = params.timeoutAt - Date.now();
    if (remainingMs <= 0) {
      throw new DOMException("Slack Events API delivery timed out", "TimeoutError");
    }
    try {
      return await postWebhookRequestWithResponse({
        address,
        body: params.body,
        headerEntries: params.headerEntries,
        signal: params.signal,
        timeoutMs: Math.max(1, Math.floor(remainingMs / (addresses.length - index))),
        url: params.url,
      });
    } catch (error) {
      lastError = error;
      if (params.signal.aborted) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function waitForSlackRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function deliverSlackEvent(
  state: SlackServerState,
  event: ReturnType<typeof asSlackEventCallback>,
  lifecycleSignal: AbortSignal,
): Promise<void> {
  if (!state.eventsRequestUrl) {
    return undefined;
  }
  const body = JSON.stringify(event);
  let retryReason: SlackRetryReason | undefined;
  for (let attempt = 0; attempt <= SLACK_EVENT_MAX_RETRIES; attempt += 1) {
    if (lifecycleSignal.aborted) {
      return;
    }
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const headerEntries = [
        ["content-type", "application/json"],
        ...(attempt > 0
          ? ([
              ["x-slack-retry-num", String(attempt)],
              ["x-slack-retry-reason", retryReason ?? "unknown_error"],
            ] as const)
          : []),
        ["x-slack-request-timestamp", timestamp],
        ["x-slack-signature", slackRequestSignature(state.signingSecret, timestamp, body)],
      ] as const;
      const signal = AbortSignal.any([lifecycleSignal, AbortSignal.timeout(3_000)]);
      const timeoutAt = Date.now() + 3_000;
      let requestUrl = new URL(state.eventsRequestUrl);
      let response: WebhookResponse | undefined;
      for (let redirectCount = 0; ; redirectCount += 1) {
        response = await postSlackEventRequest({
          body,
          headerEntries,
          signal,
          state,
          timeoutAt,
          url: requestUrl,
        });
        const noRetry = slackResponseHeader(response, "x-slack-no-retry") === "1";
        if (noRetry) {
          return;
        }
        const location = slackResponseHeader(response, "location");
        if (![301, 302].includes(response.status) || !location) {
          break;
        }
        if (redirectCount >= SLACK_EVENT_MAX_REDIRECTS) {
          response = undefined;
          retryReason = "too_many_redirects";
          break;
        }
        requestUrl = new URL(location, requestUrl);
      }
      if (response) {
        if (response.status >= 200 && response.status < 300) {
          return;
        }
        retryReason = "http_error";
      }
    } catch (error) {
      if (lifecycleSignal.aborted) {
        return;
      }
      retryReason = classifySlackRetryReason(error);
    }
    const retryDelay = SLACK_EVENT_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined && !(await waitForSlackRetry(retryDelay, lifecycleSignal))) {
      return;
    }
  }
}

function scheduleSlackEventDelivery(
  state: SlackServerState,
  event: ReturnType<typeof asSlackEventCallback>,
): void {
  if (!state.eventsRequestUrl || state.closing) {
    return;
  }
  const delivery = deliverSlackEvent(state, event, state.deliveryAbortController.signal).finally(
    () => {
      state.activeEventDeliveries.delete(delivery);
    },
  );
  state.activeEventDeliveries.add(delivery);
}

async function handleSlackApi(params: {
  body: Record<string, unknown>;
  method: string;
  state: SlackServerState;
}): Promise<Response> {
  switch (params.method) {
    case "auth.test":
      return slackOk({
        bot_id: params.state.botId,
        response_metadata: {
          scopes: [
            "chat:write",
            "channels:history",
            "groups:history",
            "im:history",
            "mpim:history",
          ],
        },
        team: "Crabline",
        team_id: "TCRABLINE",
        url: "https://crabline.slack.test/",
        user: "crabline",
        user_id: params.state.botUserId,
      });
    case "chat.postMessage": {
      const rateLimit = params.state.chatPostMessageRateLimit;
      if (rateLimit && rateLimit.remaining <= 0) {
        return slackRateLimited(rateLimit.retryAfterSeconds);
      }
      if (rateLimit) {
        rateLimit.remaining -= 1;
      }
      const channel = requireSlackSendTargetId(params.body.channel);
      if (channel instanceof Response) {
        return channel;
      }
      const text = readSlackText(params.body.text) ?? "";
      const attachments = readStructuredArray(params.body.attachments, "invalid_attachments");
      if (attachments instanceof Response) {
        return attachments;
      }
      const blocks = readStructuredArray(params.body.blocks, "invalid_blocks");
      if (blocks instanceof Response) {
        return blocks;
      }
      const metadata = readSlackMetadata(params.body.metadata);
      if (metadata instanceof Response) {
        return metadata;
      }
      if (
        !text &&
        !hasStructuredMessageContent(blocks) &&
        !hasStructuredMessageContent(attachments)
      ) {
        return slackError("no_text");
      }
      if (text.length > 40_000) {
        return slackError("msg_too_long");
      }
      const threadTs = requireSlackThreadTs(params.body.thread_ts);
      if (threadTs instanceof Response) {
        return threadTs;
      }
      if (threadTs && !hasThreadParent(params.state, { channel, threadTs })) {
        return slackError("thread_not_found");
      }
      const message = appendMessage(
        params.state,
        createSlackMessage(params.state, {
          attachments,
          blocks,
          bot: true,
          channel,
          metadata,
          replyBroadcast: readBoolean(params.body.reply_broadcast),
          text,
          threadTs,
          unfurlLinks: readBoolean(params.body.unfurl_links),
          unfurlMedia: readBoolean(params.body.unfurl_media),
        }),
      );
      return slackOk({ channel, message, ts: message.ts });
    }
    case "conversations.open": {
      const users = requireSlackUsers(params.body.users, params.state.botUserId);
      if (users instanceof Response) {
        return users;
      }
      if (users.length > 1) {
        const channel = mpimChannelForUsers(params.state, users);
        return slackOk({
          channel: {
            id: channel.id,
            is_group: false,
            is_mpim: true,
            is_private: true,
            members: [params.state.botUserId, ...channel.users],
          },
        });
      }
      const user = users[0]!;
      return slackOk({
        channel: {
          id: dmChannelForUser(params.state, user),
          is_im: true,
          user,
        },
      });
    }
    case "conversations.info": {
      const channel = requireSlackChannelId(params.body.channel);
      if (channel instanceof Response) {
        return channel;
      }
      const mpim = [...params.state.userMpimChannels.values()].find(
        (candidate) => candidate.id === channel,
      );
      return slackOk({
        channel: {
          id: channel,
          is_channel: channel.startsWith("C"),
          is_group: mpim ? false : channel.startsWith("G"),
          is_im: channel.startsWith("D"),
          ...(mpim
            ? {
                is_mpim: true,
                is_private: true,
                members: [params.state.botUserId, ...mpim.users],
              }
            : {}),
          name: "crabline",
        },
      });
    }
    case "conversations.history": {
      const channel = requireSlackChannelId(params.body.channel);
      if (channel instanceof Response) {
        return channel;
      }
      const oldest = requireSlackThreadTs(params.body.oldest);
      if (oldest instanceof Response) {
        return oldest;
      }
      const latest = requireSlackThreadTs(params.body.latest);
      if (latest instanceof Response) {
        return latest;
      }
      const limit = requireSlackLimit(params.body.limit);
      if (limit instanceof Response) {
        return limit;
      }
      const boundary = decodeSlackCursor(params.body.cursor, "history");
      if (boundary instanceof Response) {
        return boundary;
      }
      const messages = messagesForChannel(params.state, channel).filter((message) => {
        if (message.thread_ts !== undefined && message.reply_broadcast !== true) {
          return false;
        }
        if (oldest && message.ts <= oldest) {
          return false;
        }
        if (latest && message.ts >= latest) {
          return false;
        }
        return true;
      });
      const ordered = [...messages]
        .reverse()
        .filter((message) => boundary === undefined || message.ts < boundary);
      const page = ordered.slice(0, limit);
      const hasMore = page.length < ordered.length;
      const nextBoundary = page.at(-1)?.ts;
      return slackOk({
        has_more: hasMore,
        messages: page,
        response_metadata: {
          next_cursor: hasMore && nextBoundary ? encodeSlackCursor("history", nextBoundary) : "",
        },
      });
    }
    case "conversations.replies": {
      const channel = requireSlackChannelId(params.body.channel);
      if (channel instanceof Response) {
        return channel;
      }
      const ts = requireSlackThreadTs(params.body.ts);
      if (ts instanceof Response) {
        return ts;
      }
      if (!ts) {
        return slackError("message_not_found");
      }
      const threadTs = resolveThreadTs(params.state, { channel, ts });
      if (!threadTs) {
        return slackError("thread_not_found");
      }
      const limit = requireSlackLimit(params.body.limit);
      if (limit instanceof Response) {
        return limit;
      }
      const boundary = decodeSlackCursor(params.body.cursor, "replies");
      if (boundary instanceof Response) {
        return boundary;
      }
      const messages = messagesForChannel(params.state, channel).filter(
        (message) =>
          (message.ts === threadTs || message.thread_ts === threadTs) &&
          (boundary === undefined || message.ts > boundary),
      );
      const page = messages.slice(0, limit);
      const hasMore = page.length < messages.length;
      const nextBoundary = page.at(-1)?.ts;
      return slackOk({
        has_more: hasMore,
        messages: page,
        response_metadata: {
          next_cursor: hasMore && nextBoundary ? encodeSlackCursor("replies", nextBoundary) : "",
        },
      });
    }
    default:
      return slackError("unknown_method", 404);
  }
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: SlackServerState;
}): Promise<Response> {
  const channel = requireSlackChannelId(params.body.channel);
  if (channel instanceof Response) {
    return channel;
  }
  if (params.body.text !== undefined && typeof params.body.text !== "string") {
    return slackError("invalid_text", 400);
  }
  const text = readSlackText(params.body.text) ?? "";
  const attachments = readStructuredArray(params.body.attachments, "invalid_attachments");
  if (attachments instanceof Response) {
    return attachments;
  }
  const blocks = readStructuredArray(params.body.blocks, "invalid_blocks");
  if (blocks instanceof Response) {
    return blocks;
  }
  const user = requireSlackUserId(params.body.user ?? "UCRABUSER");
  if (user instanceof Response) {
    return user;
  }
  const threadTs = requireSlackThreadTs(params.body.threadTs ?? params.body.thread_ts);
  if (threadTs instanceof Response) {
    return threadTs;
  }
  if (threadTs && !hasThreadParent(params.state, { channel, threadTs })) {
    return slackError("thread_not_found");
  }
  const ts = requireSlackThreadTs(params.body.ts);
  if (ts instanceof Response) {
    return ts;
  }
  const message = appendMessage(
    params.state,
    createSlackMessage(params.state, {
      attachments,
      blocks,
      channel,
      text,
      threadTs,
      ts,
      user,
    }),
  );
  const event = asSlackEventCallback(params.state, message);
  scheduleSlackEventDelivery(params.state, event);
  return slackOk({ event, message });
}

async function handleRequest(params: { request: IncomingMessage; state: SlackServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/crabline/slack/inbound") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      params.request.resume();
      return adminAuthError();
    }
    const body = await parseUnknownRequestBody(params.request);
    if (!isJsonObject(body)) {
      return slackError("invalid_json", 400);
    }
    await appendEvent(params.state, {
      at: new Date().toISOString(),
      body,
      method: params.request.method,
      path: url.pathname,
      query: queryRecord(url),
      type: "admin",
    });
    return await handleAdminInbound({ body, state: params.state });
  }

  const query = queryRecord(url);
  if (url.pathname === "/slack/events") {
    if (params.request.method !== "POST") {
      params.request.resume();
      return new Response("method not allowed", {
        headers: { allow: "POST" },
        status: 405,
      });
    }
    if (
      !params.request.headers["x-slack-request-timestamp"] ||
      !params.request.headers["x-slack-signature"]
    ) {
      params.request.resume();
      return new Response("unauthorized", { status: 401 });
    }
    const rawBody = (await readBody(params.request)).toString("utf8");
    const authError = authenticateSlackEventsRequest(params.request, params.state, rawBody);
    if (authError) {
      return authError;
    }
    let body: unknown;
    try {
      body = rawBody ? (JSON.parse(rawBody) as unknown) : {};
    } catch (error) {
      throw new InvalidJsonBodyError(error);
    }
    if (!isJsonObject(body)) {
      return slackError("invalid_json", 400);
    }
    if (body.type === "url_verification") {
      return jsonResponse({ challenge: readTrimmedString(body.challenge) ?? "" });
    }
    if (!readTrimmedString(body.type)) {
      return slackError("invalid_payload", 400);
    }
    return new Response(null, { status: 200 });
  }

  const methodMatch = /^\/api\/([a-z]+(?:\.[a-zA-Z]+)*)$/u.exec(url.pathname);
  if (!methodMatch?.[1]) {
    return new Response("not found", { status: 404 });
  }
  const requestMethod = params.request.method ?? "GET";
  if (requestMethod !== "GET" && requestMethod !== "POST") {
    params.request.resume();
    return new Response("method not allowed", {
      headers: { allow: "GET, POST" },
      status: 405,
    });
  }

  if (params.request.headers.authorization) {
    const headerAuthError = requireSlackToken(params.request, {}, params.state);
    if (headerAuthError) {
      params.request.resume();
      return headerAuthError;
    }
  }
  const body = requestMethod === "GET" ? query : await parseUnknownRequestBody(params.request);
  if (!isJsonObject(body)) {
    return slackError("json_not_object", 400);
  }
  const authError = requireSlackToken(params.request, body, params.state);
  if (authError) {
    return authError;
  }
  const event: SlackRecorderEvent = {
    at: new Date().toISOString(),
    body: redactSlackAuthFields(body),
    method: params.request.method ?? "GET",
    path: url.pathname,
    query: redactSlackAuthQuery(query),
    type: "api",
  };
  const response = await handleSlackApi({
    body,
    method: methodMatch[1],
    state: params.state,
  });
  const mutation = ["chat.postMessage", "conversations.open"].includes(methodMatch[1]);
  const payload = mutation
    ? ((await response
        .clone()
        .json()
        .catch(() => undefined)) as unknown)
    : undefined;
  const committed = isJsonObject(payload) && payload.ok === true;
  if (methodMatch[1] === "chat.postMessage") {
    event.accepted = committed;
  }
  await appendEvent(params.state, event, committed);
  return response;
}

export async function startSlackServer(
  params: StartSlackServerParams = {},
): Promise<StartedSlackServer> {
  const host = params.host ?? "127.0.0.1";
  const externallyBound = !isLoopbackHost(host);
  const state: SlackServerState = {
    activeEventDeliveries: new Set(),
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    allowLoopbackHttpEvents: isLoopbackHost(host),
    botId: params.botId ?? "BCRABLINE",
    botToken: params.botToken ?? "xoxb-crabline-slack-token",
    botUserId: params.botUserId ?? "UCRABBOT",
    chatPostMessageRateLimit: resolveChatPostMessageRateLimit(params.chatPostMessageRateLimit),
    closing: false,
    deliveryAbortController: new AbortController(),
    eventsRequestUrl: params.eventsRequestUrl,
    nextDmIndex: 1,
    nextMpimIndex: 1,
    nextTsIndex: 100,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "slack.jsonl"),
    restrictEventTargets: true,
    signingSecret: params.signingSecret ?? "crabline-slack-signing-secret",
    userDmChannels: new Map(),
    userMpimChannels: new Map(),
    messagesByChannel: new Map(),
  };
  if (externallyBound && !params.botToken) {
    const generatedBotValue = `xoxb-${randomDecimalDigits(12)}-${randomDecimalDigits(12)}-${randomBytes(18).toString("base64url")}`;
    state.botToken = generatedBotValue;
  }
  if (externallyBound && !params.signingSecret) {
    const generatedSigningValue = randomBytes(16).toString("hex");
    state.signingSecret = generatedSigningValue;
  }
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest({ request, state }),
    handleError: (error) => {
      if (error instanceof InvalidJsonBodyError) {
        return slackError("invalid_json", 400);
      }
      if (error instanceof RequestBodyTooLargeError) {
        return slackError("request_too_large", 413);
      }
      return undefined;
    },
    host,
    port: params.port ?? 0,
    serverName: "Slack",
  });
  const baseUrl = httpServer.baseUrl;
  const apiRoot = `${baseUrl}/api/`;
  return {
    async close() {
      state.closing = true;
      state.deliveryAbortController.abort();
      await Promise.allSettled(state.activeEventDeliveries);
      await httpServer.close();
    },
    manifest: {
      adminToken: state.adminToken,
      baseUrl,
      botToken: state.botToken,
      endpoints: {
        adminInboundUrl: `${baseUrl}/crabline/slack/inbound`,
        apiRoot,
        eventsUrl: `${baseUrl}/slack/events`,
      },
      env: {
        SLACK_API_URL: apiRoot,
        SLACK_BOT_TOKEN: state.botToken,
        SLACK_SIGNING_SECRET: state.signingSecret,
      },
      provider: "slack",
      recorderPath: state.recorderPath,
      signingSecret: state.signingSecret,
      version: 1,
    },
  };
}
