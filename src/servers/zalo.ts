import { randomBytes } from "node:crypto";
import {
  validateHeaderValue,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
  type HttpJsonHandlerResult,
  type ServerRequestEvent,
} from "./http.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";
import { resolveMaxPendingInboundEvents } from "./pending-events.js";
import {
  postWebhookRequest,
  validateWebhookTarget,
  type WebhookAddress,
} from "./webhook-target.js";

type ZaloChatType = "GROUP" | "PRIVATE";

const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_ZALO_WEBHOOK_VALIDATIONS = 8;
const MAX_WEBHOOK_DELIVERY_TIMEOUT_MS = 30_000;
const MAX_ZALO_WEBHOOK_SECRET_BYTES = 256;

type ZaloServerEvent = ServerRequestEvent & {
  accepted?: boolean | undefined;
};

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

type PendingUpdateResult =
  | { kind: "conflict" | "disconnect" | "shutdown" | "timeout" }
  | { kind: "update"; update: ZaloUpdate };

type PendingUpdateRequest = {
  active: boolean;
  onDisconnect(): void;
  request: IncomingMessage;
  response: ServerResponse;
  resolve(result: PendingUpdateResult): void;
  timeout: NodeJS.Timeout | undefined;
};

type ZaloValidatedWebhookTarget = {
  addresses: WebhookAddress[] | undefined;
};

type ZaloServerState = {
  activeWebhookRequests: Set<ClientRequest>;
  activeWebhookValidations: Set<AbortController>;
  adminToken: string;
  allowLoopbackHttpWebhook: boolean;
  botId: string;
  botName: string;
  botToken: string;
  closing: boolean;
  failedUpdateOrders: Set<number>;
  inboundAdmission: Promise<void>;
  maxPendingInboundEvents: number;
  nextMessage: number;
  nextUpdateOrder: number;
  onEvent: ServerEventObserver | undefined;
  pendingInboundAdmissions: number;
  pendingRequest: PendingUpdateRequest | undefined;
  recorderPath: string;
  reservedUpdateOrders: Set<number>;
  restrictWebhookTargets: boolean;
  updateOrders: WeakMap<ZaloUpdate, number>;
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

async function appendEvent(state: ZaloServerState, event: ZaloServerEvent): Promise<void> {
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

const SENSITIVE_PARAM_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "consumersecret",
  "credential",
  "credentials",
  "idtoken",
  "key",
  "oauthtoken",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "secrettoken",
  "sessiontoken",
  "signature",
  "signingsecret",
  "token",
  "webhooksecret",
]);

function isSensitiveParam(name: string): boolean {
  const canonicalName = name
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9]/gu, "")
    .toLowerCase();
  return (
    SENSITIVE_PARAM_NAMES.has(canonicalName) ||
    /(?:^|[_-])(?:access[_-]?token|api[_-]?key|authorization|key|password|secret|signature|token)(?:$|[_-])/iu.test(
      name,
    )
  );
}

function isUrlParam(name: string): boolean {
  return /(?:urls?|uris?)$/iu.test(name.normalize("NFKC").replace(/[^A-Za-z0-9]/gu, ""));
}

function redactParamValue(value: unknown, key: string): unknown {
  if (isSensitiveParam(key)) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactParamValue(entry, key));
  }
  if (isJsonObject(value)) {
    return redactParams(value);
  }
  if (
    typeof value === "string" &&
    (isUrlParam(key) || /^(?:\s*[a-z][a-z0-9+.-]*:)?\/\//iu.test(value))
  ) {
    return redactUrlCredentials(value);
  }
  return value;
}

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, redactParamValue(value, key)]),
  );
}

function redactSensitiveSearchParams(searchParams: URLSearchParams): boolean {
  let redacted = false;
  for (const key of searchParams.keys()) {
    if (isSensitiveParam(key)) {
      searchParams.set(key, "<redacted>");
      redacted = true;
    }
  }
  return redacted;
}

function redactMalformedUrlCredentials(value: string): string {
  const credentialRedacted = value.replace(
    /^(\s*)((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#]*@/iu,
    "$1$2<redacted>@",
  );
  const queryStart = credentialRedacted.indexOf("?");
  const fragmentStart = credentialRedacted.indexOf("#", queryStart + 1);
  if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) {
    return credentialRedacted;
  }
  const queryEnd = fragmentStart >= 0 ? fragmentStart : credentialRedacted.length;
  const searchParams = new URLSearchParams(credentialRedacted.slice(queryStart + 1, queryEnd));
  if (!redactSensitiveSearchParams(searchParams)) {
    return credentialRedacted;
  }
  const search = searchParams.toString().replaceAll("%3Credacted%3E", "<redacted>");
  return `${credentialRedacted.slice(0, queryStart)}?${search}${credentialRedacted.slice(queryEnd)}`;
}

function redactUrlCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactMalformedUrlCredentials(value);
  }
  const hasCredentials = Boolean(url.username || url.password);
  const redactedQuery = redactSensitiveSearchParams(url.searchParams);
  if (!hasCredentials && !redactedQuery) {
    return value;
  }
  const search = url.search.replaceAll("%3Credacted%3E", "<redacted>");
  return `${url.protocol}//${hasCredentials ? "<redacted>@" : ""}${url.host}${url.pathname}${search}${url.hash}`;
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

async function validateWebhookUrl(
  url: URL,
  state: Pick<ZaloServerState, "allowLoopbackHttpWebhook" | "restrictWebhookTargets">,
  signal?: AbortSignal,
): Promise<Response | ZaloValidatedWebhookTarget> {
  const target = await validateWebhookTarget({
    allowLoopbackHttp: state.allowLoopbackHttpWebhook,
    restrictPrivateAddresses: state.restrictWebhookTargets,
    signal,
    url,
  });
  if ("error" in target) {
    return target.error === "unresolvable"
      ? zaloError("url host could not be resolved", 400)
      : target.error === "private-address"
        ? zaloError("url must not target a private or link-local address", 400)
        : zaloError("url must use HTTPS", 400);
  }
  return target;
}

function validateZaloWebhookSecret(secretToken: string): Response | undefined {
  if (Buffer.byteLength(secretToken) > MAX_ZALO_WEBHOOK_SECRET_BYTES) {
    return zaloError(`secret_token must not exceed ${MAX_ZALO_WEBHOOK_SECRET_BYTES} bytes`, 400);
  }
  try {
    validateHeaderValue("x-bot-api-secret-token", secretToken);
  } catch {
    return zaloError("secret_token contains invalid HTTP header characters", 400);
  }
  return undefined;
}

async function validateWebhookUrlWithDeadline(
  url: URL,
  state: ZaloServerState,
  deadlineAt: number,
): Promise<Response | ZaloValidatedWebhookTarget> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw webhookTimeoutError(state.webhookDeliveryTimeoutMs);
  }
  const validation = new AbortController();
  state.activeWebhookValidations.add(validation);
  const timer = setTimeout(
    () => validation.abort(webhookTimeoutError(state.webhookDeliveryTimeoutMs)),
    remainingMs,
  );
  timer.unref();
  try {
    return await validateWebhookUrl(url, state, validation.signal);
  } finally {
    clearTimeout(timer);
    state.activeWebhookValidations.delete(validation);
  }
}

function webhookTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(`Webhook delivery timed out after ${timeoutMs}ms`, "TimeoutError");
}

/** @internal */
export async function postZaloWebhook(params: {
  activeRequests?: Set<ClientRequest>;
  addresses?: WebhookAddress[] | undefined;
  body: string;
  shouldCancel?: (() => boolean) | undefined;
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
    if (params.shouldCancel?.()) {
      throw new Error("Webhook delivery cancelled.");
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw webhookTimeoutError(params.timeoutMs);
    }
    const attemptsRemaining = addresses.length - index;
    const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsRemaining));
    try {
      return await postWebhookRequest({
        activeRequests,
        address,
        body: params.body,
        headerEntries: [["x-bot-api-secret-token", params.verificationValue]],
        timeoutMs: attemptTimeoutMs,
        url: params.url,
      });
    } catch (error) {
      if (params.shouldCancel?.()) {
        throw error;
      }
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

function nextUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  state: ZaloServerState,
): HttpJsonHandlerResult | undefined {
  if (request.aborted || request.socket.destroyed || response.destroyed) {
    return undefined;
  }
  const update = state.updates[0];
  if (!update) {
    return undefined;
  }
  const order = pollingUpdateOrder(state, update);
  if (
    state.failedUpdateOrders.has(order) &&
    [...state.reservedUpdateOrders].some((reservedOrder) => reservedOrder < order)
  ) {
    return undefined;
  }
  state.updates.shift();
  reservePollingUpdate(state, update);
  return reservedUpdateResponse(state, update);
}

function pollingUpdateOrder(state: ZaloServerState, update: ZaloUpdate): number {
  const existing = state.updateOrders.get(update);
  if (existing !== undefined) {
    return existing;
  }
  const order = state.nextUpdateOrder++;
  state.updateOrders.set(update, order);
  return order;
}

function queuePollingUpdate(state: ZaloServerState, update: ZaloUpdate): void {
  const order = pollingUpdateOrder(state, update);
  const insertionIndex = state.updates.findIndex(
    (queued) => pollingUpdateOrder(state, queued) > order,
  );
  if (insertionIndex < 0) {
    state.updates.push(update);
  } else {
    state.updates.splice(insertionIndex, 0, update);
  }
}

function reservePollingUpdate(state: ZaloServerState, update: ZaloUpdate): void {
  const order = pollingUpdateOrder(state, update);
  state.failedUpdateOrders.delete(order);
  state.reservedUpdateOrders.add(order);
}

function flushPendingPollingUpdate(state: ZaloServerState): void {
  const pending = state.pendingRequest;
  const update = state.updates[0];
  if (!pending || !update) {
    return;
  }
  if (!isPendingUpdateRequestLive(pending)) {
    settlePendingUpdate(state, pending, { kind: "disconnect" });
    return;
  }
  const order = pollingUpdateOrder(state, update);
  if (
    state.failedUpdateOrders.has(order) &&
    [...state.reservedUpdateOrders].some((reservedOrder) => reservedOrder < order)
  ) {
    return;
  }
  state.updates.shift();
  reservePollingUpdate(state, update);
  settlePendingUpdate(state, pending, { kind: "update", update });
}

function reservedUpdateResponse(state: ZaloServerState, update: ZaloUpdate): HttpJsonHandlerResult {
  let settled = false;
  const release = () => {
    if (settled) {
      return false;
    }
    settled = true;
    state.reservedUpdateOrders.delete(pollingUpdateOrder(state, update));
    return true;
  };
  return {
    onWriteFailure() {
      if (!release()) {
        return;
      }
      state.failedUpdateOrders.add(pollingUpdateOrder(state, update));
      queuePollingUpdate(state, update);
      flushPendingPollingUpdate(state);
    },
    onWriteSuccess() {
      if (release()) {
        flushPendingPollingUpdate(state);
      }
    },
    response: zaloOk(update),
  };
}

function settlePendingUpdate(
  state: ZaloServerState,
  pending: PendingUpdateRequest,
  result: PendingUpdateResult,
): boolean {
  if (!pending.active) {
    return false;
  }
  pending.active = false;
  if (state.pendingRequest === pending) {
    state.pendingRequest = undefined;
  }
  if (pending.timeout) {
    clearTimeout(pending.timeout);
  }
  pending.request.socket.off("close", pending.onDisconnect);
  pending.request.off("aborted", pending.onDisconnect);
  pending.response.off("close", pending.onDisconnect);
  pending.resolve(result);
  return true;
}

function isPendingUpdateRequestLive(pending: PendingUpdateRequest): boolean {
  return (
    !pending.request.aborted && !pending.request.socket.destroyed && !pending.response.destroyed
  );
}

async function waitForUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  state: ZaloServerState,
  timeoutSeconds: number,
): Promise<HttpJsonHandlerResult> {
  if (request.aborted || request.socket.destroyed || response.destroyed) {
    return zaloError("Client closed request", 499);
  }
  const previous = state.pendingRequest;
  if (previous) {
    settlePendingUpdate(state, previous, { kind: "conflict" });
  }
  const queued = nextUpdate(request, response, state);
  if (queued) {
    return queued;
  }
  if (timeoutSeconds <= 0) {
    return zaloError("Request timeout", 408);
  }
  const result = await new Promise<PendingUpdateResult>((resolve) => {
    const pending: PendingUpdateRequest = {
      active: true,
      onDisconnect: () => {
        settlePendingUpdate(state, pending, { kind: "disconnect" });
      },
      request,
      response,
      resolve,
      timeout: undefined,
    };
    state.pendingRequest = pending;
    request.once("aborted", pending.onDisconnect);
    request.socket.once("close", pending.onDisconnect);
    response.once("close", pending.onDisconnect);
    pending.timeout = setTimeout(() => {
      settlePendingUpdate(state, pending, { kind: "timeout" });
    }, timeoutSeconds * 1000);
    pending.timeout.unref();
    if (request.socket.destroyed || response.destroyed) {
      pending.onDisconnect();
    }
  });
  switch (result.kind) {
    case "conflict":
      return zaloError("Conflict: terminated by other getUpdates request", 409);
    case "disconnect":
      return zaloError("Client closed request", 499);
    case "shutdown":
      return zaloError("Server shutting down", 503);
    case "timeout":
      return zaloError("Request timeout", 408);
    case "update":
      return reservedUpdateResponse(state, result.update);
  }
}

function deliverPollingUpdate(state: ZaloServerState, update: ZaloUpdate): boolean {
  pollingUpdateOrder(state, update);
  if (state.updates.length > 0) {
    if (state.updates.length + state.reservedUpdateOrders.size >= state.maxPendingInboundEvents) {
      return false;
    }
    queuePollingUpdate(state, update);
    flushPendingPollingUpdate(state);
    return true;
  }
  const pending = state.pendingRequest;
  if (pending) {
    if (isPendingUpdateRequestLive(pending)) {
      reservePollingUpdate(state, update);
      settlePendingUpdate(state, pending, { kind: "update", update });
      return true;
    }
    settlePendingUpdate(state, pending, { kind: "disconnect" });
  }
  if (state.updates.length + state.reservedUpdateOrders.size >= state.maxPendingInboundEvents) {
    return false;
  }
  queuePollingUpdate(state, update);
  return true;
}

async function deliverWebhookUpdate(
  state: ZaloServerState,
  webhook: NonNullable<ZaloServerState["webhook"]>,
  update: ZaloUpdate,
): Promise<Response | undefined> {
  const deadlineAt = Date.now() + state.webhookDeliveryTimeoutMs;
  const url = new URL(webhook.url);
  let target: Response | ZaloValidatedWebhookTarget;
  try {
    target = await validateWebhookUrlWithDeadline(url, state, deadlineAt);
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
      body: JSON.stringify(update),
      shouldCancel: () => state.closing,
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
  const queued =
    state.webhook?.url === undefined ? state.updates.length + state.reservedUpdateOrders.size : 0;
  if (queued + state.pendingInboundAdmissions >= state.maxPendingInboundEvents) {
    drainRequestBody(request);
    return zaloError(
      `Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`,
      429,
    );
  }
  state.pendingInboundAdmissions += 1;
  let releaseAdmission!: () => void;
  const previousAdmission = state.inboundAdmission;
  state.inboundAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let admissionPending = true;
  try {
    const parsedBody = await parseUnknownRequestBody(request);
    await previousAdmission;
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
    if (
      !state.webhook?.url &&
      state.updates.length + state.reservedUpdateOrders.size >= state.maxPendingInboundEvents
    ) {
      return zaloError(
        `Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`,
        429,
      );
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
    await appendEvent(state, {
      at: new Date().toISOString(),
      body: redactParams(body),
      method: request.method ?? "POST",
      path: url.pathname,
      query: redactParams(queryRecord(url)) as Record<string, string>,
      type: "admin",
    });
    if (state.webhook?.url) {
      const error = await deliverWebhookUpdate(state, state.webhook, update);
      if (error) {
        return error;
      }
    } else {
      state.pendingInboundAdmissions -= 1;
      admissionPending = false;
      if (!deliverPollingUpdate(state, update)) {
        return zaloError(
          `Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`,
          429,
        );
      }
    }
    return zaloOk(update);
  } finally {
    await previousAdmission;
    releaseAdmission();
    if (admissionPending) {
      state.pendingInboundAdmissions -= 1;
    }
  }
}

async function handleZaloMethod(
  request: IncomingMessage,
  response: ServerResponse,
  state: ZaloServerState,
  url: URL,
  method: string,
): Promise<HttpJsonHandlerResult> {
  const parsedBody = await parseUnknownRequestBody(request);
  if (!isJsonObject(parsedBody)) {
    return zaloError("Bad Request: can't parse JSON object", 400);
  }
  const body = requestParams(url, parsedBody);
  const event: ZaloServerEvent = {
    at: new Date().toISOString(),
    ...(Object.keys(body).length > 0 ? { body: redactParams(body) } : {}),
    method: request.method ?? "GET",
    path: `/bot<redacted>/${method}`,
    query: redactParams(queryRecord(url)) as Record<string, string>,
    type: "api",
  };

  if (method === "sendMessage" || method === "sendPhoto") {
    const chatId = requireParam(body, "chat_id");
    const content = requireParam(body, method === "sendMessage" ? "text" : "photo");
    const error = firstError(chatId, content);
    const sendResponse = error ?? zaloOk({ date: Date.now(), message_id: messageId(state) });
    event.accepted = sendResponse.ok;
    try {
      await appendEvent(state, event);
    } catch (appendError) {
      if (!event.accepted) {
        throw appendError;
      }
    }
    return sendResponse;
  }

  if (method !== "setWebhook") {
    await appendEvent(state, event);
  }

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
    return await waitForUpdate(request, response, state, timeout);
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
    const finish = async (response: Response, rejected: boolean): Promise<Response> => {
      if (rejected && isJsonObject(event.body) && "url" in event.body) {
        event.body.url = "<redacted>";
      }
      await appendEvent(state, event);
      return response;
    };
    const webhookUrl = requireParam(body, "url");
    const secretToken = requireParam(body, "secret_token");
    const error = firstError(webhookUrl, secretToken);
    if (error) {
      return await finish(error, true);
    }
    if (typeof webhookUrl !== "string" || typeof secretToken !== "string") {
      return await finish(zaloError("Invalid webhook parameters", 400), true);
    }
    const secretError = validateZaloWebhookSecret(secretToken);
    if (secretError) {
      return await finish(secretError, true);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      return await finish(zaloError("url must be a valid HTTPS URL", 400), true);
    }
    if (state.activeWebhookValidations.size >= MAX_ACTIVE_ZALO_WEBHOOK_VALIDATIONS) {
      return await finish(zaloError("Too many webhook validations", 429), true);
    }
    let target: Response | ZaloValidatedWebhookTarget;
    try {
      target = await validateWebhookUrlWithDeadline(
        parsedUrl,
        state,
        Date.now() + state.webhookDeliveryTimeoutMs,
      );
    } catch {
      return await finish(zaloError("url host could not be resolved", 400), true);
    }
    if (target instanceof Response) {
      return await finish(target, true);
    }
    if (state.reservedUpdateOrders.size > 0) {
      return await finish(zaloError("Polling deliveries are still in progress", 409), true);
    }
    const webhook = { secretToken, updatedAt: Date.now(), url: parsedUrl.href };
    if (state.pendingRequest) {
      settlePendingUpdate(state, state.pendingRequest, { kind: "conflict" });
    }
    state.webhook = webhook;
    return await finish(zaloOk({ updated_at: webhook.updatedAt, url: webhook.url }), false);
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
    activeWebhookValidations: new Set(),
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    allowLoopbackHttpWebhook: isLoopbackHost(host),
    botId: params.botId ?? "1459232241454765289",
    botName: params.botName ?? "bot.crabline",
    botToken:
      params.botToken ??
      (isLoopbackHost(host) ? "crabline-zalo-bot-token" : randomBytes(32).toString("base64url")),
    closing: false,
    failedUpdateOrders: new Set(),
    inboundAdmission: Promise.resolve(),
    maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
    nextMessage: 1,
    nextUpdateOrder: 1,
    onEvent: params.onEvent,
    pendingInboundAdmissions: 0,
    pendingRequest: undefined,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "zalo.jsonl"),
    reservedUpdateOrders: new Set(),
    restrictWebhookTargets: true,
    updateOrders: new WeakMap(),
    updates: [],
    webhook: undefined,
    webhookDeliveryTimeoutMs: webhookDeliveryTimeoutMs(params.webhookDeliveryTimeoutMs),
  };
  const httpServer = await startHttpJsonServer({
    handle: async (request, response) => {
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
      return await handleZaloMethod(request, response, state, url, match[2] ?? "");
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
      state.closing = true;
      for (const request of state.activeWebhookRequests) {
        request.destroy(new Error("Zalo server is shutting down."));
      }
      for (const validation of state.activeWebhookValidations) {
        validation.abort(new Error("Zalo server is shutting down."));
      }
      if (state.pendingRequest) {
        settlePendingUpdate(state, state.pendingRequest, { kind: "shutdown" });
      }
      await httpServer.close();
    },
    manifest,
  };
}
