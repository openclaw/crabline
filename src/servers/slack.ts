import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import {
  adminAuthError,
  hasAdminToken,
  InvalidJsonBodyError,
  jsonResponse,
  parseRequestBody,
  queryRecord,
  readInteger,
  readTrimmedString,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";
import {
  SLACK_CHANNEL_ID_RULE,
  SLACK_SEND_TARGET_ID_RULE,
  SLACK_TS_RULE,
  SLACK_USER_ID_RULE,
} from "../providers/slack-ids.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";

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
  adminToken: string;
  botId: string;
  botToken: string;
  botUserId: string;
  eventsRequestUrl: string | undefined;
  nextDmIndex: number;
  nextTsIndex: number;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
  signingSecret: string;
  userDmChannels: Map<string, string>;
  messagesByChannel: Map<string, SlackMessage[]>;
};

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

function requireSlackToken(
  request: IncomingMessage,
  body: Record<string, unknown>,
  state: SlackServerState,
): Response | undefined {
  const authorization = request.headers.authorization;
  const tokenFromHeader =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
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
    (message) => message.ts === params.threadTs || message.thread_ts === params.threadTs,
  );
}

function nextSlackTs(state: SlackServerState): string {
  const index = state.nextTsIndex++;
  return `${1_700_000_000 + Math.floor(index / 1_000_000)}.${String(index % 1_000_000).padStart(6, "0")}`;
}

function nextDmChannelId(state: SlackServerState): string {
  const index = state.nextDmIndex++;
  return `D${String(index).padStart(9, "0")}`;
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

function appendMessage(state: SlackServerState, message: SlackMessage): SlackMessage {
  const messages = state.messagesByChannel.get(message.channel) ?? [];
  messages.push(message);
  state.messagesByChannel.set(message.channel, messages);
  return message;
}

async function appendEvent(state: SlackServerState, event: ServerRequestEvent) {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
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

function asSlackEventCallback(message: SlackMessage) {
  return {
    api_app_id: "ACRABLINE",
    authorizations: [],
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

async function deliverSlackEvent(
  state: SlackServerState,
  event: ReturnType<typeof asSlackEventCallback>,
): Promise<Response | undefined> {
  if (!state.eventsRequestUrl) {
    return undefined;
  }
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const response = await fetch(state.eventsRequestUrl, {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackRequestSignature(state.signingSecret, timestamp, body),
      },
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return slackError("event_delivery_failed", 502);
    }
  } catch {
    return slackError("event_delivery_failed", 502);
  }
  return undefined;
}

async function handleSlackApi(params: {
  body: Record<string, unknown>;
  method: string;
  request: IncomingMessage;
  state: SlackServerState;
}): Promise<Response> {
  const authError = requireSlackToken(params.request, params.body, params.state);
  if (authError) {
    return authError;
  }

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
      if (readBoolean(params.body.simulate_rate_limit) === true) {
        return slackRateLimited(readInteger(params.body.retry_after) ?? 1);
      }
      const channel = requireSlackSendTargetId(params.body.channel);
      if (channel instanceof Response) {
        return channel;
      }
      const text = readTrimmedString(params.body.text) ?? "";
      const attachments = readStructuredValue(params.body.attachments);
      const blocks = readStructuredValue(params.body.blocks);
      const metadata = readStructuredValue(params.body.metadata);
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
      const users = readTrimmedString(params.body.users);
      const firstUser = users?.split(",")[0]?.trim();
      const user = requireSlackUserId(firstUser);
      if (user instanceof Response) {
        return user;
      }
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
      return slackOk({
        channel: {
          id: channel,
          is_channel: channel.startsWith("C"),
          is_group: channel.startsWith("G"),
          is_im: channel.startsWith("D"),
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
      const limit = readInteger(params.body.limit) ?? 100;
      const messages = messagesForChannel(params.state, channel).filter((message) => {
        if (oldest && message.ts <= oldest) {
          return false;
        }
        if (latest && message.ts >= latest) {
          return false;
        }
        return true;
      });
      return slackOk({
        has_more: messages.length > limit,
        messages: [...messages].reverse().slice(0, limit),
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
      const limit = readInteger(params.body.limit) ?? 100;
      const messages = messagesForChannel(params.state, channel).filter(
        (message) => message.ts === ts || message.thread_ts === ts,
      );
      if (messages.length === 0) {
        return slackError("thread_not_found");
      }
      return slackOk({ has_more: messages.length > limit, messages: messages.slice(0, limit) });
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
  const text = readTrimmedString(params.body.text);
  if (!text) {
    return slackError("text is required", 400);
  }
  const user = requireSlackUserId(params.body.user ?? "UCRABUSER");
  if (user instanceof Response) {
    return user;
  }
  const threadTs = requireSlackThreadTs(params.body.threadTs ?? params.body.thread_ts);
  if (threadTs instanceof Response) {
    return threadTs;
  }
  const ts = requireSlackThreadTs(params.body.ts);
  if (ts instanceof Response) {
    return ts;
  }
  const message = createSlackMessage(params.state, {
    channel,
    text,
    threadTs,
    ts,
    user,
  });
  const event = asSlackEventCallback(message);
  const deliveryError = await deliverSlackEvent(params.state, event);
  if (deliveryError) {
    return deliveryError;
  }
  appendMessage(params.state, message);
  return slackOk({ event, message });
}

async function handleRequest(params: { request: IncomingMessage; state: SlackServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/crabline/slack/inbound") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      return adminAuthError();
    }
    const body = await parseRequestBody(params.request);
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
  const body = params.request.method === "GET" ? query : await parseRequestBody(params.request);
  await appendEvent(params.state, {
    at: new Date().toISOString(),
    body: redactSlackAuthFields(body),
    method: params.request.method ?? "GET",
    path: url.pathname,
    query: redactSlackAuthQuery(query),
    type: "api",
  });

  if (url.pathname === "/slack/events") {
    if (body.type === "url_verification") {
      return jsonResponse({ challenge: readTrimmedString(body.challenge) ?? "" });
    }
    return slackOk();
  }

  const methodMatch = /^\/api\/([a-z]+(?:\.[a-zA-Z]+)*)$/u.exec(url.pathname);
  if (!methodMatch?.[1]) {
    return new Response("not found", { status: 404 });
  }
  return await handleSlackApi({
    body,
    method: methodMatch[1],
    request: params.request,
    state: params.state,
  });
}

export async function startSlackServer(
  params: StartSlackServerParams = {},
): Promise<StartedSlackServer> {
  const state: SlackServerState = {
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    botId: params.botId ?? "BCRABLINE",
    botToken: params.botToken ?? "xoxb-crabline-slack-token",
    botUserId: params.botUserId ?? "UCRABBOT",
    eventsRequestUrl: params.eventsRequestUrl,
    nextDmIndex: 1,
    nextTsIndex: 100,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "slack.jsonl"),
    signingSecret: params.signingSecret ?? "crabline-slack-signing-secret",
    userDmChannels: new Map(),
    messagesByChannel: new Map(),
  };
  const host = params.host ?? "127.0.0.1";
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest({ request, state }),
    handleError: (error) =>
      error instanceof InvalidJsonBodyError ? slackError("invalid_json", 400) : undefined,
    host,
    port: params.port ?? 0,
    serverName: "Slack",
  });
  const baseUrl = httpServer.baseUrl;
  const apiRoot = `${baseUrl}/api/`;
  return {
    async close() {
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
