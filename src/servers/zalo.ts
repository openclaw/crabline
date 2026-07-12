import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as requestHttp, type ClientRequest, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import {
  adminAuthError,
  drainRequestBody,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  isLoopbackHost,
  jsonResponse,
  parseUnknownRequestBody,
  queryRecord,
  readTrimmedString,
  RequestBodyTooLargeError,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";
import { resolveMaxPendingInboundEvents } from "./pending-events.js";

type ZaloChatType = "GROUP" | "PRIVATE";

const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;
const MAX_WEBHOOK_DELIVERY_TIMEOUT_MS = 30_000;
const BLOCKED_WEBHOOK_ADDRESSES = createBlockedWebhookAddresses();

type ZaloMessage = {
  chat: { chat_type: ZaloChatType; id: string };
  date: number;
  from: { display_name: string; id: string; is_bot: boolean };
  message_id: string;
  photo_url?: string;
  text?: string;
};

type ZaloUpdate = {
  event_name: "message.image.received" | "message.text.received";
  message: ZaloMessage;
};

type PendingUpdateRequest = {
  active: boolean;
  onDisconnect(): void;
  request: IncomingMessage;
  resolve(response: Response): void;
  timeout: NodeJS.Timeout | undefined;
};

type WebhookAddress = {
  address: string;
  family: 4 | 6;
};

type ValidatedWebhookTarget = {
  addresses: WebhookAddress[] | undefined;
};

type ZaloServerState = {
  activeWebhookRequests: Set<ClientRequest>;
  adminToken: string;
  allowLoopbackHttpWebhook: boolean;
  botId: string;
  botName: string;
  botToken: string;
  maxPendingInboundEvents: number;
  nextMessage: number;
  onEvent: ServerEventObserver | undefined;
  pendingRequests: PendingUpdateRequest[];
  recorderPath: string;
  restrictWebhookTargets: boolean;
  updates: ZaloUpdate[];
  webhook: { secretToken: string; updatedAt: number; url: string } | undefined;
  webhookDeliveryTimeoutMs: number;
};

export type ZaloServerManifest = {
  adminToken: string;
  baseUrl: string;
  botId: string;
  botToken: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
  };
  env: {
    ZALO_API_URL: string;
    ZALO_BOT_TOKEN: string;
  };
  provider: "zalo";
  recorderPath: string;
  version: 1;
};

export type StartedZaloServer = {
  close(): Promise<void>;
  manifest: ZaloServerManifest;
};

export type StartZaloServerParams = {
  adminToken?: string | undefined;
  botId?: string | undefined;
  botName?: string | undefined;
  botToken?: string | undefined;
  host?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  maxPendingInboundEvents?: number | undefined;
  webhookDeliveryTimeoutMs?: number | undefined;
};

async function appendEvent(state: ZaloServerState, event: ServerRequestEvent): Promise<void> {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function zaloOk(result?: unknown): Response {
  return jsonResponse(result === undefined ? { ok: true } : { ok: true, result });
}

function zaloError(description: string, status: number): Response {
  return jsonResponse({ description, error_code: status, ok: false }, status);
}

function messageId(state: ZaloServerState): string {
  return `${Date.now().toString(16)}${(state.nextMessage++).toString(16).padStart(6, "0")}`;
}

function readChatType(value: unknown): ZaloChatType {
  return readTrimmedString(value)?.toUpperCase() === "GROUP" ? "GROUP" : "PRIVATE";
}

function requestParams(url: URL, body: Record<string, unknown>): Record<string, unknown> {
  return { ...Object.fromEntries(url.searchParams.entries()), ...body };
}

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      key === "secret_token" ? "<redacted>" : value,
    ]),
  );
}

function requireParam(body: Record<string, unknown>, name: string): string | Response {
  return readTrimmedString(body[name]) ?? zaloError(`${name} is required`, 400);
}

function firstError(...values: Array<string | Response>): Response | undefined {
  return values.find((value): value is Response => value instanceof Response);
}

function webhookDeliveryTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_WEBHOOK_DELIVERY_TIMEOUT_MS));
}

function createBlockedWebhookAddresses(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv4");
    const octets = address.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    blockList.addSubnet(`::ffff:${high.toString(16)}:${low.toString(16)}`, 96 + prefix, "ipv6");
  }
  for (const [address, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  return blockList;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/u, "$1").replace(/%25/gu, "%");
}

function isBlockedWebhookAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(normalized)?.[1];
  if (mappedIpv4) {
    return BLOCKED_WEBHOOK_ADDRESSES.check(mappedIpv4, "ipv4");
  }
  const family = isIP(normalized);
  return family === 4
    ? BLOCKED_WEBHOOK_ADDRESSES.check(normalized, "ipv4")
    : family === 6
      ? BLOCKED_WEBHOOK_ADDRESSES.check(normalized, "ipv6")
      : false;
}

async function resolveWebhookAddresses(hostname: string): Promise<WebhookAddress[]> {
  const normalized = normalizeHostname(hostname);
  const family = isIP(normalized);
  if (family === 4 || family === 6) {
    return [{ address: normalized, family }];
  }
  return (await lookup(normalized, { all: true, verbatim: true })).flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  );
}

async function validateWebhookUrl(
  url: URL,
  state: Pick<ZaloServerState, "allowLoopbackHttpWebhook" | "restrictWebhookTargets">,
): Promise<Response | ValidatedWebhookTarget> {
  if (
    url.protocol === "http:" &&
    (!state.allowLoopbackHttpWebhook || !isLoopbackHost(url.hostname))
  ) {
    return zaloError("url must use HTTPS", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return zaloError("url must use HTTPS", 400);
  }
  if (!state.restrictWebhookTargets) {
    return { addresses: undefined };
  }

  let addresses: WebhookAddress[];
  try {
    addresses = await resolveWebhookAddresses(url.hostname);
  } catch {
    return zaloError("url host could not be resolved", 400);
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedWebhookAddress(entry.address))) {
    return zaloError("url must not target a private or link-local address", 400);
  }
  return { addresses };
}

async function postWebhook(
  url: URL,
  body: string,
  secretToken: string,
  timeoutMs: number,
  address: WebhookAddress | undefined,
  activeRequests: Set<ClientRequest>,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    let deadline: NodeJS.Timeout;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      activeRequests.delete(request);
      callback();
    };
    const send = url.protocol === "https:" ? requestHttps : requestHttp;
    const request = send(
      url,
      {
        ...(address ? { family: address.family } : {}),
        headers: {
          "content-length": String(Buffer.byteLength(body)),
          "content-type": "application/json",
          "x-bot-api-secret-token": secretToken,
        },
        ...(address
          ? {
              lookup: (_hostname, _options, callback) =>
                callback(null, address.address, address.family),
            }
          : {}),
        method: "POST",
      },
      (incoming) => {
        response = incoming;
        incoming.resume();
        incoming.once("error", (error) => finish(() => reject(error)));
        incoming.once("end", () => finish(() => resolve(incoming.statusCode ?? 0)));
      },
    );
    activeRequests.add(request);
    deadline = setTimeout(() => {
      const error = new DOMException(
        `Webhook delivery timed out after ${timeoutMs}ms`,
        "TimeoutError",
      );
      response?.destroy(error);
      request.destroy(error);
    }, timeoutMs);
    deadline.unref();
    request.once("error", (error) => finish(() => reject(error)));
    request.end(body);
  });
}

function webhookTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(`Webhook delivery timed out after ${timeoutMs}ms`, "TimeoutError");
}

async function withWebhookDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  timeoutMs: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw webhookTimeoutError(timeoutMs);
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(webhookTimeoutError(timeoutMs)), remainingMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** @internal */
export async function postZaloWebhook(params: {
  activeRequests?: Set<ClientRequest>;
  addresses?: WebhookAddress[] | undefined;
  body: string;
  timeoutMs: number;
  url: URL;
  verificationValue: string;
}): Promise<number> {
  const activeRequests = params.activeRequests ?? new Set<ClientRequest>();
  const deadlineAt = Date.now() + params.timeoutMs;
  const addresses =
    params.addresses && params.addresses.length > 0 ? params.addresses : [undefined];
  let lastError: unknown;
  for (const [index, address] of addresses.entries()) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw webhookTimeoutError(params.timeoutMs);
    }
    const attemptsRemaining = addresses.length - index;
    const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsRemaining));
    try {
      return await postWebhook(
        params.url,
        params.body,
        params.verificationValue,
        attemptTimeoutMs,
        address,
        activeRequests,
      );
    } catch (error) {
      lastError = error;
      if (
        error instanceof DOMException &&
        error.name === "TimeoutError" &&
        attemptsRemaining === 1
      ) {
        throw webhookTimeoutError(params.timeoutMs);
      }
    }
  }
  throw lastError;
}

function nextUpdate(state: ZaloServerState): Response | undefined {
  const update = state.updates.shift();
  return update ? zaloOk(update) : undefined;
}

function settlePendingUpdate(
  state: ZaloServerState,
  pending: PendingUpdateRequest,
  response: Response,
): boolean {
  if (!pending.active) {
    return false;
  }
  pending.active = false;
  const index = state.pendingRequests.indexOf(pending);
  if (index >= 0) {
    state.pendingRequests.splice(index, 1);
  }
  if (pending.timeout) {
    clearTimeout(pending.timeout);
  }
  pending.request.socket.off("close", pending.onDisconnect);
  pending.resolve(response);
  return true;
}

function waitForUpdate(
  request: IncomingMessage,
  state: ZaloServerState,
  timeoutSeconds: number,
): Promise<Response> {
  const queued = nextUpdate(state);
  if (queued) {
    return Promise.resolve(queued);
  }
  if (timeoutSeconds <= 0) {
    return Promise.resolve(zaloError("Request timeout", 408));
  }
  return new Promise((resolve) => {
    const pending: PendingUpdateRequest = {
      active: true,
      onDisconnect: () => {
        settlePendingUpdate(state, pending, zaloError("Client closed request", 499));
      },
      request,
      resolve,
      timeout: undefined,
    };
    state.pendingRequests.push(pending);
    request.socket.once("close", pending.onDisconnect);
    pending.timeout = setTimeout(() => {
      settlePendingUpdate(state, pending, zaloError("Request timeout", 408));
    }, timeoutSeconds * 1000);
    pending.timeout.unref();
    if (request.socket.destroyed) {
      pending.onDisconnect();
    }
  });
}

function deliverPollingUpdate(state: ZaloServerState, update: ZaloUpdate): boolean {
  while (state.pendingRequests.length > 0) {
    const pending = state.pendingRequests[0]!;
    if (settlePendingUpdate(state, pending, zaloOk(update))) {
      return true;
    }
  }
  if (state.updates.length >= state.maxPendingInboundEvents) {
    return false;
  }
  state.updates.push(update);
  return true;
}

async function deliverWebhookUpdate(
  state: ZaloServerState,
  webhook: NonNullable<ZaloServerState["webhook"]>,
  update: ZaloUpdate,
): Promise<Response | undefined> {
  const deadlineAt = Date.now() + state.webhookDeliveryTimeoutMs;
  const url = new URL(webhook.url);
  let target: Response | ValidatedWebhookTarget;
  try {
    target = await withWebhookDeadline(
      validateWebhookUrl(url, state),
      deadlineAt,
      state.webhookDeliveryTimeoutMs,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return zaloError(`Webhook delivery timed out after ${state.webhookDeliveryTimeoutMs}ms`, 502);
    }
    throw error;
  }
  if (target instanceof Response) {
    return target;
  }
  try {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw webhookTimeoutError(state.webhookDeliveryTimeoutMs);
    }
    const status = await postZaloWebhook({
      activeRequests: state.activeWebhookRequests,
      addresses: target.addresses,
      body: JSON.stringify({ ok: true, result: update }),
      timeoutMs: remainingMs,
      url,
      verificationValue: webhook.secretToken,
    });
    if (status < 200 || status >= 300) {
      return zaloError(`Webhook delivery failed with HTTP ${status}`, 502);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return zaloError(`Webhook delivery timed out after ${state.webhookDeliveryTimeoutMs}ms`, 502);
    }
    return zaloError(
      `Webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  return undefined;
}

async function handleAdminInbound(
  request: IncomingMessage,
  state: ZaloServerState,
  url: URL,
): Promise<Response> {
  if (!hasAdminToken(request, state.adminToken)) {
    drainRequestBody(request);
    return adminAuthError();
  }
  const parsedBody = await parseUnknownRequestBody(request);
  if (!isJsonObject(parsedBody)) {
    return zaloError("Bad Request: can't parse JSON object", 400);
  }
  const body = parsedBody;
  const chatId = requireParam(body, "chatId");
  const senderId = requireParam(body, "senderId");
  const text = requireParam(body, "text");
  if (chatId instanceof Response || senderId instanceof Response || text instanceof Response) {
    return [chatId, senderId, text].find((value) => value instanceof Response) as Response;
  }
  const update: ZaloUpdate = {
    event_name: "message.text.received",
    message: {
      chat: { chat_type: readChatType(body.chatType), id: chatId },
      date: Date.now(),
      from: {
        display_name: readTrimmedString(body.senderName) ?? senderId,
        id: senderId,
        is_bot: false,
      },
      message_id: messageId(state),
      text,
    },
  };
  if (
    !state.webhook?.url &&
    state.pendingRequests.length === 0 &&
    state.updates.length >= state.maxPendingInboundEvents
  ) {
    return zaloError(
      `Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`,
      429,
    );
  }
  await appendEvent(state, {
    at: new Date().toISOString(),
    body,
    method: request.method ?? "POST",
    path: url.pathname,
    query: queryRecord(url),
    type: "admin",
  });
  if (state.webhook?.url) {
    const error = await deliverWebhookUpdate(state, state.webhook, update);
    if (error) {
      return error;
    }
  } else {
    if (!deliverPollingUpdate(state, update)) {
      return zaloError(
        `Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`,
        429,
      );
    }
  }
  return zaloOk(update);
}

async function handleZaloMethod(
  request: IncomingMessage,
  state: ZaloServerState,
  url: URL,
  method: string,
): Promise<Response> {
  const parsedBody = await parseUnknownRequestBody(request);
  if (!isJsonObject(parsedBody)) {
    return zaloError("Bad Request: can't parse JSON object", 400);
  }
  const body = requestParams(url, parsedBody);
  await appendEvent(state, {
    at: new Date().toISOString(),
    ...(Object.keys(body).length > 0 ? { body: redactParams(body) } : {}),
    method: request.method ?? "GET",
    path: `/bot<redacted>/${method}`,
    query: redactParams(queryRecord(url)) as Record<string, string>,
    type: "api",
  });

  if (method === "getMe") {
    return zaloOk({
      account_name: state.botName,
      account_type: "BASIC",
      can_join_groups: true,
      id: state.botId,
    });
  }
  if (method === "getUpdates") {
    if (state.webhook?.url) {
      return zaloError("Webhook is configured; delete it before using getUpdates", 400);
    }
    const parsedTimeout = Number(readTrimmedString(body.timeout) ?? "30");
    const timeout = Number.isFinite(parsedTimeout) ? Math.max(0, Math.min(parsedTimeout, 50)) : 30;
    return await waitForUpdate(request, state, timeout);
  }
  if (method === "sendMessage" || method === "sendPhoto") {
    const chatId = requireParam(body, "chat_id");
    const content = requireParam(body, method === "sendMessage" ? "text" : "photo");
    const error = firstError(chatId, content);
    if (error) {
      return error;
    }
    return zaloOk({ date: Date.now(), message_id: messageId(state) });
  }
  if (method === "sendChatAction") {
    const chatId = requireParam(body, "chat_id");
    const action = requireParam(body, "action");
    const error = firstError(chatId, action);
    if (error) {
      return error;
    }
    if (action !== "typing" && action !== "upload_photo") {
      return zaloError("action must be typing or upload_photo", 400);
    }
    return zaloOk();
  }
  if (method === "setWebhook") {
    const webhookUrl = requireParam(body, "url");
    const secretToken = requireParam(body, "secret_token");
    const error = firstError(webhookUrl, secretToken);
    if (error) {
      return error;
    }
    if (typeof webhookUrl !== "string" || typeof secretToken !== "string") {
      return zaloError("Invalid webhook parameters", 400);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      return zaloError("url must be a valid HTTPS URL", 400);
    }
    const target = await validateWebhookUrl(parsedUrl, state);
    if (target instanceof Response) {
      return target;
    }
    const webhook = { secretToken, updatedAt: Date.now(), url: parsedUrl.href };
    state.webhook = webhook;
    return zaloOk({ updated_at: webhook.updatedAt, url: webhook.url });
  }
  if (method === "deleteWebhook") {
    const updatedAt = Date.now();
    state.webhook = undefined;
    return zaloOk({ updated_at: updatedAt, url: "" });
  }
  if (method === "getWebhookInfo") {
    return zaloOk(
      state.webhook ? { updated_at: state.webhook.updatedAt, url: state.webhook.url } : { url: "" },
    );
  }
  return zaloError("Bad request - invalid API name", 400);
}

export async function startZaloServer(
  params: StartZaloServerParams = {},
): Promise<StartedZaloServer> {
  const host = params.host ?? "127.0.0.1";
  const state: ZaloServerState = {
    activeWebhookRequests: new Set(),
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    allowLoopbackHttpWebhook: isLoopbackHost(host),
    botId: params.botId ?? "1459232241454765289",
    botName: params.botName ?? "bot.crabline",
    botToken:
      params.botToken ??
      (isLoopbackHost(host) ? "crabline-zalo-bot-token" : randomBytes(32).toString("base64url")),
    maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
    nextMessage: 1,
    onEvent: params.onEvent,
    pendingRequests: [],
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "zalo.jsonl"),
    restrictWebhookTargets: !isLoopbackHost(host),
    updates: [],
    webhook: undefined,
    webhookDeliveryTimeoutMs: webhookDeliveryTimeoutMs(params.webhookDeliveryTimeoutMs),
  };
  const httpServer = await startHttpJsonServer({
    handle: async (request) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (request.method === "POST" && url.pathname === "/crabline/zalo/inbound") {
        return await handleAdminInbound(request, state, url);
      }
      const match = /^\/bot([^/]+)\/([^/]+)$/u.exec(url.pathname);
      if (!match || (request.method !== "GET" && request.method !== "POST")) {
        return zaloError("Not found", 404);
      }
      if (match[1] !== state.botToken) {
        drainRequestBody(request);
        return zaloError("Unauthorized", 401);
      }
      return await handleZaloMethod(request, state, url, match[2] ?? "");
    },
    handleError: (error) => {
      if (error instanceof InvalidJsonBodyError) {
        return zaloError("Bad Request: can't parse JSON object", 400);
      }
      if (error instanceof RequestBodyTooLargeError) {
        return zaloError("Request Entity Too Large", 413);
      }
      return undefined;
    },
    host,
    port: params.port ?? 0,
    serverName: "Zalo",
  });
  const manifest: ZaloServerManifest = {
    adminToken: state.adminToken,
    baseUrl: httpServer.baseUrl,
    botId: state.botId,
    botToken: state.botToken,
    endpoints: {
      adminInboundUrl: `${httpServer.baseUrl}/crabline/zalo/inbound`,
      apiRoot: httpServer.baseUrl,
    },
    env: {
      ZALO_API_URL: httpServer.baseUrl,
      ZALO_BOT_TOKEN: state.botToken,
    },
    provider: "zalo",
    recorderPath: state.recorderPath,
    version: 1,
  };
  return {
    async close() {
      for (const request of state.activeWebhookRequests) {
        request.destroy(new Error("Zalo server is shutting down."));
      }
      for (const pending of state.pendingRequests.splice(0)) {
        settlePendingUpdate(state, pending, zaloError("Server shutting down", 503));
      }
      await httpServer.close();
    },
    manifest,
  };
}
