import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../core/errors.js";
import {
  adminAuthError,
  closeServer,
  drainRequestBody,
  formatUrlHost,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  isLoopbackHost,
  jsonResponse,
  queryRecord,
  readBody,
  RequestBodyTooLargeError,
  writeResponse,
} from "./http.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";
import { resolveMaxPendingInboundEvents } from "./pending-events.js";

const TELEGRAM_MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const TELEGRAM_WEBHOOK_MAX_RETRIES = 5;
const TELEGRAM_WEBHOOK_RETRY_BASE_MS = 100;

type TelegramServerEvent = {
  at: string;
  body?: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
  type: "admin" | "api";
};

type TelegramWebhook = {
  lastErrorDate?: number;
  lastErrorMessage?: string;
  secretToken?: string;
  url: string;
};

type TelegramServerState = {
  activeUpdatePoll: TelegramUpdatePoll | undefined;
  activeWebhookDeliveries: Set<AbortController>;
  adminToken: string;
  botId: number;
  botToken: string;
  botUsername: string;
  closing: boolean;
  inboundAdmission: Promise<void>;
  maxPendingInboundEvents: number;
  nextMessageId: number;
  nextUpdateId: number;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
  updates: TelegramUpdate[];
  webhook: TelegramWebhook | undefined;
  webhookDelivery: Promise<Response | undefined> | undefined;
  webhookRetryAttempts: number;
  webhookRetryTimer: NodeJS.Timeout | undefined;
  webhookRetryUpdateId: number | undefined;
};

type TelegramUpdatePoll = {
  finish(result: TelegramUpdatePollResult): void;
};

type TelegramUpdatePollResult = "conflict" | "shutdown" | "timeout" | "update";

type TelegramGetUpdatesState = Pick<
  TelegramServerState,
  "activeUpdatePoll" | "closing" | "updates"
>;

type TelegramMessage = {
  chat: {
    id: number | string;
    title?: string;
    type: "group" | "private" | "supergroup";
  };
  animation?: {
    file_id: string;
    file_name?: string;
    file_unique_id: string;
    mime_type?: string;
  };
  caption?: string;
  date: number;
  document?: {
    file_id: string;
    file_name?: string;
    file_unique_id: string;
    mime_type?: string;
  };
  audio?: {
    duration: number;
    file_id: string;
    file_name?: string;
    file_unique_id: string;
    mime_type?: string;
  };
  entities?: Array<{
    length: number;
    offset: number;
    type: string;
  }>;
  from: {
    first_name: string;
    id: number;
    is_bot: boolean;
    username?: string;
  };
  message_id: number;
  message_thread_id?: number;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    height: number;
    width: number;
  }>;
  text?: string;
  video?: {
    file_id: string;
    file_name?: string;
    file_unique_id: string;
    mime_type?: string;
  };
};

type TelegramUpdate = {
  message: TelegramMessage;
  update_id: number;
};

export type TelegramServerManifest = {
  adminToken: string;
  baseUrl: string;
  botToken: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
  };
  env: {
    TELEGRAM_BOT_TOKEN: string;
  };
  provider: "telegram";
  recorderPath: string;
  version: 1;
};

export type StartedTelegramServer = {
  close(): Promise<void>;
  manifest: TelegramServerManifest;
};

export type StartTelegramServerParams = {
  adminToken?: string | undefined;
  botId?: number | undefined;
  botToken?: string | undefined;
  botUsername?: string | undefined;
  host?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  maxPendingInboundEvents?: number | undefined;
};

function telegramOk(result: unknown): Response {
  return jsonResponse({ ok: true, result });
}

function telegramError(description: string, status = 400): Response {
  return jsonResponse({ description, error_code: status, ok: false }, status);
}

async function parseRequestBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, TELEGRAM_MAX_REQUEST_BODY_BYTES);
  if (body.length === 0) {
    return {};
  }
  const contentType = request.headers["content-type"] ?? "";
  const contentTypes = Array.isArray(contentType) ? contentType : [contentType];
  if (contentTypes.some((entry) => entry.toLowerCase().includes("json"))) {
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch (error) {
      throw new InvalidJsonBodyError(error);
    }
  }
  const multipartType = contentTypes.find((entry) =>
    entry.toLowerCase().includes("multipart/form-data"),
  );
  if (multipartType) {
    return await parseMultipartFormDataBody(body, multipartType);
  }
  const params = new URLSearchParams(body.toString("utf8"));
  return Object.fromEntries(params.entries());
}

async function parseMultipartFormDataBody(
  body: Buffer,
  contentType: string,
): Promise<Record<string, unknown>> {
  let form: FormData;
  try {
    form = await new Request("http://localhost", {
      body,
      headers: { "content-type": contentType },
      method: "POST",
    }).formData();
  } catch (error) {
    throw new InvalidJsonBodyError(error);
  }
  const fields: Record<string, unknown> = {};
  for (const [name, value] of form) {
    fields[name] = typeof value === "string" ? value : value.name;
  }
  return fields;
}

function requireTelegramBotPath(pathname: string): { method: string; token: string } | undefined {
  const match = /^\/bot([^/]+)\/([A-Za-z][A-Za-z0-9_]*)$/u.exec(pathname);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { method: match[2], token: match[1] };
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number" || typeof value === "bigint"
      ? value.toString()
      : undefined;
}

function toIntegerValue(value: unknown): number | undefined {
  const stringValue = toStringValue(value);
  if (!stringValue || !/^-?\d+$/u.test(stringValue)) {
    return undefined;
  }
  return Number(stringValue);
}

function toBooleanValue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

function telegramChatId(value: unknown): number | string | undefined {
  const stringValue = toStringValue(value);
  if (!stringValue) {
    return undefined;
  }
  return /^-?\d+$/u.test(stringValue) ? Number(stringValue) : stringValue;
}

async function appendEvent(state: TelegramServerState, event: TelegramServerEvent) {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function redactTelegramBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key === "secret_token" ? "<redacted>" : value,
    ]),
  );
}

function createBotUser(state: TelegramServerState) {
  return {
    can_join_groups: true,
    can_read_all_group_messages: true,
    first_name: "Crabline",
    has_topics_enabled: true,
    id: state.botId,
    is_bot: true,
    supports_inline_queries: false,
    username: state.botUsername,
  };
}

function createChat(chatId: number | string): TelegramMessage["chat"] {
  const type =
    typeof chatId !== "number" || chatId >= 0
      ? "private"
      : String(chatId).startsWith("-100")
        ? "supergroup"
        : "group";
  return {
    id: chatId,
    type,
  };
}

function createOutboundMessage(
  state: TelegramServerState,
  body: Record<string, unknown>,
): TelegramMessage | undefined {
  const chatId = telegramChatId(body.chat_id);
  const text = toStringValue(body.text);
  if (chatId === undefined || !text) {
    return undefined;
  }
  const threadId = toIntegerValue(body.message_thread_id);
  return {
    chat: createChat(chatId),
    date: Math.floor(Date.now() / 1000),
    from: createBotUser(state),
    message_id: state.nextMessageId++,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    text,
  };
}

function createOutboundMediaMessage(
  state: TelegramServerState,
  body: Record<string, unknown>,
  mediaKind: "animation" | "audio" | "document" | "photo" | "video",
): TelegramMessage | undefined {
  const chatId = telegramChatId(body.chat_id);
  const fileName = toStringValue(body[mediaKind]);
  if (chatId === undefined || !fileName) {
    return undefined;
  }
  const threadId = toIntegerValue(body.message_thread_id);
  const caption = toStringValue(body.caption);
  const duration = Math.max(0, toIntegerValue(body.duration) ?? 0);
  const media = {
    file_id: `crabline-${mediaKind}-${state.nextMessageId}`,
    file_name: fileName,
    file_unique_id: `crabline-${mediaKind}-unique-${state.nextMessageId}`,
  };
  return {
    chat: createChat(chatId),
    date: Math.floor(Date.now() / 1000),
    from: createBotUser(state),
    ...(caption ? { caption } : {}),
    [mediaKind]:
      mediaKind === "photo"
        ? [{ ...media, height: 1, width: 1 }]
        : {
            ...media,
            ...(mediaKind === "audio" ? { duration } : {}),
            mime_type: "application/octet-stream",
          },
    message_id: state.nextMessageId++,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  };
}

function createEditedMessage(
  state: TelegramServerState,
  body: Record<string, unknown>,
): TelegramMessage | undefined {
  const chatId = telegramChatId(body.chat_id);
  const text = toStringValue(body.text);
  const messageId = toIntegerValue(body.message_id);
  if (chatId === undefined || !text || messageId === undefined) {
    return undefined;
  }
  const threadId = toIntegerValue(body.message_thread_id);
  return {
    chat: createChat(chatId),
    date: Math.floor(Date.now() / 1000),
    from: createBotUser(state),
    message_id: messageId,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    text,
  };
}

function createInboundUpdate(
  state: TelegramServerState,
  body: Record<string, unknown>,
): TelegramUpdate | undefined {
  const chatId = telegramChatId(body.chatId ?? body.chat_id);
  const text = toStringValue(body.text);
  if (chatId === undefined || !text) {
    return undefined;
  }
  const fromId = toIntegerValue(body.fromId ?? body.from_id) ?? 100001;
  const threadId = toIntegerValue(body.messageThreadId ?? body.message_thread_id);
  const fromUsername = toStringValue(body.fromUsername ?? body.from_username);
  const messageId = toIntegerValue(body.messageId ?? body.message_id);
  const updateId = toIntegerValue(body.updateId ?? body.update_id);
  const entities = Array.isArray(body.entities)
    ? body.entities.filter(
        (entry): entry is { length: number; offset: number; type: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { length?: unknown }).length === "number" &&
          typeof (entry as { offset?: unknown }).offset === "number" &&
          typeof (entry as { type?: unknown }).type === "string",
      )
    : undefined;
  return {
    message: {
      chat: createChat(chatId),
      date: Math.floor(Date.now() / 1000),
      from: {
        first_name: toStringValue(body.fromName ?? body.from_name) ?? "QA User",
        id: fromId,
        is_bot: false,
        ...(fromUsername ? { username: fromUsername } : {}),
      },
      message_id: messageId ?? state.nextMessageId,
      ...(entities && entities.length > 0 ? { entities } : {}),
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      text,
    },
    update_id: updateId ?? state.nextUpdateId,
  };
}

async function handleTelegramAdminInbound(params: {
  body: Record<string, unknown>;
  request: IncomingMessage;
  state: TelegramServerState;
  url: URL;
}): Promise<Response> {
  let releaseAdmission!: () => void;
  const previousAdmission = params.state.inboundAdmission;
  params.state.inboundAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  await previousAdmission;
  try {
    const nextMessageId = params.state.nextMessageId;
    const nextUpdateId = params.state.nextUpdateId;
    const update = createInboundUpdate(params.state, params.body);
    params.state.nextMessageId = nextMessageId;
    params.state.nextUpdateId = nextUpdateId;
    if (!update) {
      return telegramError("Bad Request: chatId and text are required");
    }
    if (params.state.updates.length >= params.state.maxPendingInboundEvents) {
      return telegramError(
        `Too Many Requests: pending inbound queue is full (${params.state.maxPendingInboundEvents} updates)`,
        429,
      );
    }
    params.state.nextMessageId = Math.max(
      params.state.nextMessageId,
      update.message.message_id + 1,
    );
    params.state.nextUpdateId = Math.max(params.state.nextUpdateId, update.update_id + 1);
    const reservedNextMessageId = params.state.nextMessageId;
    const reservedNextUpdateId = params.state.nextUpdateId;
    try {
      await appendEvent(params.state, {
        at: new Date().toISOString(),
        body: params.body,
        method: params.request.method ?? "POST",
        path: params.url.pathname,
        query: queryRecord(params.url),
        type: "admin",
      });
    } catch (error) {
      if (params.state.nextMessageId === reservedNextMessageId) {
        params.state.nextMessageId = nextMessageId;
      }
      if (params.state.nextUpdateId === reservedNextUpdateId) {
        params.state.nextUpdateId = nextUpdateId;
      }
      throw error;
    }
    params.state.updates.push(update);
    params.state.updates.sort((left, right) => left.update_id - right.update_id);
    if (params.state.webhook) {
      const deliveryError = await deliverTelegramWebhookUpdates(params.state);
      return deliveryError ?? jsonResponse({ ok: true, update });
    }
    finishTelegramUpdatePoll(params.state, "update");
    return jsonResponse({ ok: true, update });
  } finally {
    releaseAdmission();
  }
}

async function flushTelegramWebhookUpdates(
  state: TelegramServerState,
  onAttempt: (updateId: number) => void,
): Promise<Response | undefined> {
  if (!state.webhook) {
    return undefined;
  }
  while (state.updates.length > 0 && state.webhook) {
    syncTelegramWebhookRetryHead(state);
    const webhook: TelegramWebhook = state.webhook;
    const update = state.updates[0]!;
    onAttempt(update.update_id);
    const controller = new AbortController();
    state.activeWebhookDeliveries.add(controller);
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (webhook.secretToken) {
        headers.set("x-telegram-bot-api-secret-token", webhook.secretToken);
      }
      const response = await fetch(webhook.url, {
        body: JSON.stringify(update),
        headers,
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
      });
      await response.body?.cancel();
      if (!response.ok) {
        if (state.webhook === webhook) {
          webhook.lastErrorDate = Math.floor(Date.now() / 1_000);
          webhook.lastErrorMessage = `Wrong response from the webhook: ${response.status}`;
        }
        return telegramError("Bad Gateway: webhook delivery failed", 502);
      }
      const deliveredIndex = state.updates.indexOf(update);
      if (deliveredIndex >= 0) {
        state.updates.splice(deliveredIndex, 1);
      }
      if (state.webhook === webhook) {
        state.webhookRetryAttempts = 0;
      }
    } catch {
      if (state.webhook === webhook) {
        webhook.lastErrorDate = Math.floor(Date.now() / 1_000);
        webhook.lastErrorMessage = "Webhook delivery failed";
      }
      return telegramError("Bad Gateway: webhook delivery failed", 502);
    } finally {
      state.activeWebhookDeliveries.delete(controller);
    }
  }
  return undefined;
}

function clearTelegramWebhookRetry(state: TelegramServerState, resetAttempts = false): void {
  if (state.webhookRetryTimer) {
    clearTimeout(state.webhookRetryTimer);
    state.webhookRetryTimer = undefined;
  }
  if (resetAttempts) {
    state.webhookRetryAttempts = 0;
    state.webhookRetryUpdateId = undefined;
  }
}

function syncTelegramWebhookRetryHead(state: TelegramServerState): void {
  const updateId = state.updates[0]?.update_id;
  if (updateId === state.webhookRetryUpdateId) {
    return;
  }
  clearTelegramWebhookRetry(state);
  state.webhookRetryAttempts = 0;
  state.webhookRetryUpdateId = updateId;
}

function scheduleTelegramWebhookDelivery(state: TelegramServerState, delayMs: number): void {
  if (
    state.closing ||
    !state.webhook ||
    state.updates.length === 0 ||
    state.webhookDelivery ||
    state.webhookRetryTimer
  ) {
    return;
  }
  state.webhookRetryTimer = setTimeout(() => {
    state.webhookRetryTimer = undefined;
    void deliverTelegramWebhookUpdates(state, true);
  }, delayMs);
  state.webhookRetryTimer.unref();
}

async function deliverTelegramWebhookUpdates(
  state: TelegramServerState,
  scheduledRetry = false,
): Promise<Response | undefined> {
  if (state.webhookDelivery) {
    return await state.webhookDelivery;
  }
  syncTelegramWebhookRetryHead(state);
  if (
    !scheduledRetry &&
    (state.webhookRetryTimer || state.webhookRetryAttempts >= TELEGRAM_WEBHOOK_MAX_RETRIES)
  ) {
    return telegramError("Bad Gateway: webhook delivery failed", 502);
  }
  let attemptedUpdateId: number | undefined;
  const delivery = flushTelegramWebhookUpdates(state, (updateId) => {
    attemptedUpdateId = updateId;
  });
  state.webhookDelivery = delivery;
  let result: Response | undefined;
  try {
    result = await delivery;
    return result;
  } finally {
    if (state.webhookDelivery === delivery) {
      state.webhookDelivery = undefined;
    }
    if (state.webhook && state.updates.length > 0) {
      if (state.updates[0]?.update_id !== attemptedUpdateId) {
        syncTelegramWebhookRetryHead(state);
        scheduleTelegramWebhookDelivery(state, 0);
      } else if (result) {
        if (state.webhookRetryAttempts < TELEGRAM_WEBHOOK_MAX_RETRIES) {
          const delayMs = TELEGRAM_WEBHOOK_RETRY_BASE_MS * 2 ** state.webhookRetryAttempts;
          state.webhookRetryAttempts += 1;
          scheduleTelegramWebhookDelivery(state, delayMs);
        }
      } else {
        state.webhookRetryAttempts = 0;
        scheduleTelegramWebhookDelivery(state, 0);
      }
    }
  }
}

async function handleTelegramApi(params: {
  body: Record<string, unknown>;
  method: string;
  request: IncomingMessage;
  state: TelegramServerState;
}) {
  const method = params.method.toLowerCase();
  switch (method) {
    case "getme":
      return telegramOk(createBotUser(params.state));
    case "setmycommands":
    case "deletemycommands":
    case "sendchataction":
    case "answercallbackquery":
    case "deletemessage":
    case "pinchatmessage":
    case "unpinchatmessage":
    case "setmessagereaction":
    case "editforumtopic":
      return telegramOk(true);
    case "setwebhook": {
      if (params.body.url === "") {
        if (toBooleanValue(params.body.drop_pending_updates)) {
          params.state.updates.length = 0;
        }
        clearTelegramWebhookRetry(params.state, true);
        params.state.webhook = undefined;
        return telegramOk(true);
      }
      const webhookUrl = toStringValue(params.body.url);
      if (!webhookUrl) {
        return telegramError("Bad Request: url is required");
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(webhookUrl);
      } catch {
        return telegramError("Bad Request: bad webhook URL");
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return telegramError("Bad Request: bad webhook URL");
      }
      const secretToken = toStringValue(params.body.secret_token);
      if (secretToken && !/^[A-Za-z0-9_-]{1,256}$/u.test(secretToken)) {
        return telegramError("Bad Request: invalid secret token");
      }
      if (toBooleanValue(params.body.drop_pending_updates)) {
        params.state.updates.length = 0;
      }
      params.state.webhook = {
        ...(secretToken ? { secretToken } : {}),
        url: parsedUrl.href,
      };
      finishTelegramUpdatePoll(params.state, "conflict");
      clearTelegramWebhookRetry(params.state, true);
      scheduleTelegramWebhookDelivery(params.state, 0);
      return telegramOk(true);
    }
    case "deletewebhook":
      if (toBooleanValue(params.body.drop_pending_updates)) {
        params.state.updates.length = 0;
      }
      clearTelegramWebhookRetry(params.state, true);
      params.state.webhook = undefined;
      return telegramOk(true);
    case "getwebhookinfo":
      return telegramOk({
        has_custom_certificate: false,
        ...(params.state.webhook?.lastErrorDate
          ? { last_error_date: params.state.webhook.lastErrorDate }
          : {}),
        ...(params.state.webhook?.lastErrorMessage
          ? { last_error_message: params.state.webhook.lastErrorMessage }
          : {}),
        pending_update_count: params.state.updates.length,
        url: params.state.webhook?.url ?? "",
      });
    case "createforumtopic":
      return telegramOk({
        icon_color: 0x6fb9f0,
        message_thread_id: params.state.nextMessageId++,
        name: toStringValue(params.body.name) ?? "Crabline Topic",
      });
    case "editmessagetext": {
      const message = createEditedMessage(params.state, params.body);
      return message
        ? telegramOk(message)
        : telegramError("Bad Request: chat_id, message_id, and text are required");
    }
    case "sendmessage": {
      const message = createOutboundMessage(params.state, params.body);
      return message
        ? telegramOk(message)
        : telegramError("Bad Request: chat_id and text are required");
    }
    case "sendanimation":
    case "sendaudio":
    case "senddocument":
    case "sendphoto":
    case "sendvideo": {
      const mediaKind = method.slice("send".length) as
        | "animation"
        | "audio"
        | "document"
        | "photo"
        | "video";
      const message = createOutboundMediaMessage(params.state, params.body, mediaKind);
      return message
        ? telegramOk(message)
        : telegramError(`Bad Request: chat_id and ${mediaKind} are required`);
    }
    case "getupdates":
      if (params.state.webhook) {
        return telegramError("Conflict: can't use getUpdates method while webhook is active", 409);
      }
      return await handleTelegramGetUpdates(params);
    default:
      return telegramError(`Not Found: unsupported method ${params.method}`, 404);
  }
}

/** @internal */
export async function handleTelegramGetUpdates(params: {
  body: Record<string, unknown>;
  request: IncomingMessage;
  state: TelegramGetUpdatesState;
}): Promise<Response> {
  const offset = toIntegerValue(params.body.offset);
  const limit = toIntegerValue(params.body.limit) ?? 100;
  const timeout = toIntegerValue(params.body.timeout) ?? 0;
  if (limit < 1 || limit > 100) {
    return telegramError("Bad Request: limit must be between 1 and 100");
  }
  if (timeout < 0) {
    return telegramError("Bad Request: timeout must be non-negative");
  }

  finishTelegramUpdatePoll(params.state, "conflict");
  let updates = takeTelegramUpdates(params.state, offset, limit);
  const deadline = Date.now() + Math.min(timeout * 1_000, 2_147_483_647);
  if (updates.length === 0 && timeout > 0) {
    while (updates.length === 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      const pollResult = await waitForTelegramUpdate(
        params.state,
        params.request,
        remainingMs,
        () => hasTelegramUpdates(params.state, offset),
      );
      if (pollResult === "conflict") {
        return telegramError(
          "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
          409,
        );
      }
      if (pollResult !== "update") {
        break;
      }
      updates = takeTelegramUpdates(params.state, offset, limit);
    }
  }
  return telegramOk(updates);
}

function takeTelegramUpdates(
  state: TelegramGetUpdatesState,
  offset: number | undefined,
  limit: number,
): TelegramUpdate[] {
  if (offset !== undefined && offset < 0) {
    const retainedCount = Math.min(Math.abs(offset), state.updates.length);
    state.updates.splice(0, state.updates.length - retainedCount);
  } else if (offset !== undefined) {
    const firstUnconfirmed = state.updates.findIndex((update) => update.update_id >= offset);
    if (firstUnconfirmed === -1) {
      state.updates.length = 0;
    } else if (firstUnconfirmed > 0) {
      state.updates.splice(0, firstUnconfirmed);
    }
  }
  return state.updates.slice(0, limit);
}

function hasTelegramUpdates(state: TelegramGetUpdatesState, offset: number | undefined): boolean {
  if (offset === undefined || offset < 0) {
    return state.updates.length > 0;
  }
  return state.updates.some((update) => update.update_id >= offset);
}

function finishTelegramUpdatePoll(
  state: TelegramGetUpdatesState,
  result: TelegramUpdatePollResult,
): void {
  state.activeUpdatePoll?.finish(result);
}

async function waitForTelegramUpdate(
  state: TelegramGetUpdatesState,
  request: IncomingMessage,
  timeoutMs: number,
  hasUpdate: () => boolean,
): Promise<TelegramUpdatePollResult> {
  if (state.closing || request.socket.destroyed) {
    return "shutdown";
  }
  return await new Promise<TelegramUpdatePollResult>((resolve) => {
    let settled = false;
    const poll: TelegramUpdatePoll = {
      finish(result) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        request.socket.off("close", onSocketClose);
        if (state.activeUpdatePoll === poll) {
          state.activeUpdatePoll = undefined;
        }
        resolve(result);
      },
    };
    const onSocketClose = () => poll.finish("shutdown");
    const timer = setTimeout(() => poll.finish("timeout"), timeoutMs);
    timer.unref();
    const previousPoll = state.activeUpdatePoll;
    state.activeUpdatePoll = poll;
    previousPoll?.finish("conflict");
    request.socket.once("close", onSocketClose);
    if (state.closing || request.socket.destroyed) {
      poll.finish("shutdown");
    } else if (hasUpdate()) {
      poll.finish("update");
    }
  });
}

function telegramMethodNotAllowed(): Response {
  const response = telegramError("Method Not Allowed", 405);
  response.headers.set("allow", "GET, POST");
  return response;
}

async function handleRequest(params: { request: IncomingMessage; state: TelegramServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/crabline/telegram/inbound") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      drainRequestBody(params.request);
      return adminAuthError();
    }
    const body = await parseRequestBody(params.request);
    if (!isJsonObject(body)) {
      return telegramError("Bad Request: request body must be a JSON object");
    }
    return await handleTelegramAdminInbound({
      body,
      request: params.request,
      state: params.state,
      url,
    });
  }

  const botPath = requireTelegramBotPath(url.pathname);
  if (!botPath || botPath.token !== params.state.botToken) {
    drainRequestBody(params.request);
    return new Response("not found", { status: 404 });
  }
  const requestMethod = params.request.method ?? "GET";
  if (requestMethod !== "GET" && requestMethod !== "POST") {
    drainRequestBody(params.request);
    return telegramMethodNotAllowed();
  }
  const body = requestMethod === "GET" ? queryRecord(url) : await parseRequestBody(params.request);
  if (!isJsonObject(body)) {
    return telegramError("Bad Request: can't parse JSON object");
  }
  await appendEvent(params.state, {
    at: new Date().toISOString(),
    body: redactTelegramBody(body),
    method: requestMethod,
    path: `/bot<redacted>/${botPath.method}`,
    query: queryRecord(url),
    type: "api",
  });
  return handleTelegramApi({
    body,
    method: botPath.method,
    request: params.request,
    state: params.state,
  });
}

export async function startTelegramServer(
  params: StartTelegramServerParams = {},
): Promise<StartedTelegramServer> {
  const host = params.host ?? "127.0.0.1";
  const botId = params.botId ?? 424242;
  const state: TelegramServerState = {
    activeUpdatePoll: undefined,
    activeWebhookDeliveries: new Set(),
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    botId,
    botToken:
      params.botToken ??
      (isLoopbackHost(host)
        ? "424242:crabline-telegram-token"
        : `${botId}:${randomBytes(26).toString("base64url")}`),
    botUsername: params.botUsername ?? "crabline_bot",
    inboundAdmission: Promise.resolve(),
    maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
    nextMessageId: 1,
    nextUpdateId: 1,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "telegram.jsonl"),
    closing: false,
    updates: [],
    webhook: undefined,
    webhookDelivery: undefined,
    webhookRetryAttempts: 0,
    webhookRetryTimer: undefined,
    webhookRetryUpdateId: undefined,
  };
  const port = params.port ?? 0;
  const server = createServer(async (request, response) => {
    try {
      await writeResponse(response, await handleRequest({ request, state }));
    } catch (error) {
      await writeResponse(
        response,
        error instanceof InvalidJsonBodyError
          ? telegramError("Bad Request: can't parse JSON object")
          : error instanceof RequestBodyTooLargeError
            ? telegramError("Request Entity Too Large", 413)
            : jsonResponse({ error: "internal server error", ok: false }, 500),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new CrablineError("Unable to resolve Telegram local server address.", {
      kind: "connectivity",
    });
  }
  const baseUrl = `http://${formatUrlHost(host)}:${address.port}`;
  return {
    async close() {
      state.closing = true;
      finishTelegramUpdatePoll(state, "shutdown");
      clearTelegramWebhookRetry(state);
      for (const controller of state.activeWebhookDeliveries) {
        controller.abort();
      }
      await state.webhookDelivery;
      await state.inboundAdmission;
      await closeServer(server);
    },
    manifest: {
      adminToken: state.adminToken,
      baseUrl,
      botToken: state.botToken,
      endpoints: {
        adminInboundUrl: `${baseUrl}/crabline/telegram/inbound`,
        apiRoot: baseUrl,
      },
      env: {
        TELEGRAM_BOT_TOKEN: state.botToken,
      },
      provider: "telegram",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
