import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import {
  postWebhookRequest,
  validateWebhookTarget,
  type WebhookAddress,
} from "./webhook-target.js";

const TELEGRAM_MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const TELEGRAM_WEBHOOK_MAX_BACKOFF_EXPONENT = 5;
const TELEGRAM_WEBHOOK_RETRY_BASE_MS = 100;
const TELEGRAM_WEBHOOK_DELIVERY_TIMEOUT_MS = 3_000;
const MAX_ACTIVE_TELEGRAM_WEBHOOK_VALIDATIONS = 8;
const TELEGRAM_CHAT_USERNAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/u;
const TELEGRAM_SEND_METHODS = new Set([
  "sendanimation",
  "sendaudio",
  "senddocument",
  "sendmessage",
  "sendphoto",
  "sendvideo",
]);
const TELEGRAM_MEDIA_FIELDS = [
  "animation",
  "audio",
  "document",
  "paid_media",
  "photo",
  "sticker",
  "story",
  "video",
  "video_note",
  "voice",
] as const;
const TELEGRAM_UNSUPPORTED_UPDATE_FIELDS = [
  "business_connection",
  "business_message",
  "callback_query",
  "channel_post",
  "chat_boost",
  "chat_join_request",
  "chat_member",
  "chosen_inline_result",
  "deleted_business_messages",
  "edited_business_message",
  "edited_channel_post",
  "edited_message",
  "guest_message",
  "inline_query",
  "managed_bot",
  "message_reaction",
  "message_reaction_count",
  "my_chat_member",
  "poll",
  "poll_answer",
  "pre_checkout_query",
  "purchased_paid_media",
  "removed_chat_boost",
  "shipping_query",
] as const;

type TelegramServerEvent = {
  accepted?: boolean | undefined;
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
  activeWebhookValidations: Set<AbortController>;
  adminToken: string;
  allowLoopbackHttpWebhook: boolean;
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
  restrictWebhookTargets: boolean;
  updates: TelegramUpdate[];
  webhook: TelegramWebhook | undefined;
  webhookAdmission: Promise<void>;
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
    duration: number;
    file_id: string;
    file_name?: string;
    file_unique_id: string;
    height: number;
    mime_type?: string;
    width: number;
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
    duration: number;
    file_id: string;
    file_name?: string;
    file_unique_id: string;
    height: number;
    mime_type?: string;
    width: number;
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
  const integerValue = Number(stringValue);
  return Number.isSafeInteger(integerValue) ? integerValue : undefined;
}

function toBooleanValue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

function telegramChatId(value: unknown): number | string | undefined {
  const stringValue = toStringValue(value);
  if (!stringValue) {
    return undefined;
  }
  if (/^-?\d+$/u.test(stringValue)) {
    const integerValue = toIntegerValue(stringValue);
    return integerValue === 0 ? undefined : integerValue;
  }
  return TELEGRAM_CHAT_USERNAME_PATTERN.test(stringValue) ? stringValue : undefined;
}

async function appendEvent(state: TelegramServerState, event: TelegramServerEvent) {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function redactTelegramSecrets<T>(body: Record<string, T>): Record<string, T | string> {
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
    typeof chatId === "string"
      ? "supergroup"
      : chatId >= 0
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
  const parsedThreadId = toIntegerValue(body.message_thread_id);
  if (body.message_thread_id !== undefined && parsedThreadId === undefined) {
    return undefined;
  }
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
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
  const parsedThreadId = toIntegerValue(body.message_thread_id);
  if (body.message_thread_id !== undefined && parsedThreadId === undefined) {
    return undefined;
  }
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
  const caption = toStringValue(body.caption);
  const duration = Math.max(0, toIntegerValue(body.duration) ?? 0);
  const height = Math.max(1, toIntegerValue(body.height) ?? 1);
  const width = Math.max(1, toIntegerValue(body.width) ?? 1);
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
            ...(mediaKind === "audio"
              ? { duration }
              : mediaKind === "animation" || mediaKind === "video"
                ? { duration, height, width }
                : {}),
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
  const parsedThreadId = toIntegerValue(body.message_thread_id);
  if (body.message_thread_id !== undefined && parsedThreadId === undefined) {
    return undefined;
  }
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
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
  const fromIdValue = body.fromId ?? body.from_id;
  const threadIdValue = body.messageThreadId ?? body.message_thread_id;
  const messageIdValue = body.messageId ?? body.message_id;
  const updateIdValue = body.updateId ?? body.update_id;
  const fromId = toIntegerValue(fromIdValue);
  const parsedThreadId = toIntegerValue(threadIdValue);
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
  const fromUsername = toStringValue(body.fromUsername ?? body.from_username);
  const messageId = toIntegerValue(messageIdValue);
  const updateId = toIntegerValue(updateIdValue);
  if (
    (fromIdValue !== undefined && fromId === undefined) ||
    (threadIdValue !== undefined && parsedThreadId === undefined) ||
    (messageIdValue !== undefined && messageId === undefined) ||
    (updateIdValue !== undefined && updateId === undefined)
  ) {
    return undefined;
  }
  const entities = parseTelegramEntities(body.entities, text);
  if (body.entities !== undefined && !entities) {
    return undefined;
  }
  return {
    message: {
      chat: createChat(chatId),
      date: Math.floor(Date.now() / 1000),
      from: {
        first_name: toStringValue(body.fromName ?? body.from_name) ?? "QA User",
        id: fromId ?? 100001,
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

function parseTelegramEntities(
  value: unknown,
  text: string,
): Array<{ length: number; offset: number; type: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entities: Array<{ length: number; offset: number; type: string }> = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return undefined;
    }
    const length = toIntegerValue(entry.length);
    const offset = toIntegerValue(entry.offset);
    const type = toStringValue(entry.type);
    if (
      length === undefined ||
      length < 1 ||
      offset === undefined ||
      offset < 0 ||
      offset + length > text.length ||
      !type
    ) {
      return undefined;
    }
    entities.push({ length, offset, type });
  }
  return entities;
}

function hasTelegramMedia(value: Record<string, unknown>): boolean {
  return TELEGRAM_MEDIA_FIELDS.some((field) => value[field] !== undefined);
}

function hasValidExplicitTelegramIdentities(body: Record<string, unknown>): boolean {
  return (
    [body.chatId, body.chat_id].every(
      (value) => value === undefined || telegramChatId(value) !== undefined,
    ) &&
    [
      body.fromId,
      body.from_id,
      body.messageId,
      body.message_id,
      body.messageThreadId,
      body.message_thread_id,
      body.updateId,
      body.update_id,
    ].every((value) => value === undefined || toIntegerValue(value) !== undefined)
  );
}

function isValidIgnoredTelegramUpdate(body: Record<string, unknown>): boolean {
  const updateIdValue = body.updateId ?? body.update_id;
  const updateId = toIntegerValue(updateIdValue);

  if (isJsonObject(body.message)) {
    const message = body.message;
    const chat = isJsonObject(message.chat) ? message.chat : undefined;
    if (
      updateId === undefined ||
      !chat ||
      telegramChatId(chat.id) === undefined ||
      toIntegerValue(message.message_id) === undefined ||
      (message.from !== undefined &&
        (!isJsonObject(message.from) || toIntegerValue(message.from.id) === undefined)) ||
      (message.message_thread_id !== undefined &&
        toIntegerValue(message.message_thread_id) === undefined)
    ) {
      return false;
    }
    return toStringValue(message.text) === undefined;
  }

  const chatId = telegramChatId(body.chatId ?? body.chat_id);
  if (
    chatId !== undefined &&
    hasValidExplicitTelegramIdentities(body) &&
    hasTelegramMedia(body) &&
    toStringValue(body.text) === undefined
  ) {
    return true;
  }

  return (
    updateId !== undefined &&
    TELEGRAM_UNSUPPORTED_UPDATE_FIELDS.some((field) => isJsonObject(body[field]))
  );
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
      if (isValidIgnoredTelegramUpdate(params.body)) {
        return jsonResponse({ ok: true });
      }
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
      scheduleTelegramWebhookDelivery(params.state, 0);
      return jsonResponse({ ok: true, update });
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
    try {
      const delivery = await postTelegramWebhook(state, webhook, update);
      if ("error" in delivery) {
        if (state.webhook === webhook) {
          webhook.lastErrorDate = Math.floor(Date.now() / 1_000);
          webhook.lastErrorMessage = delivery.error;
        }
        return telegramError("Bad Gateway: webhook delivery failed", 502);
      }
      if (delivery.status < 200 || delivery.status >= 300) {
        if (state.webhook === webhook) {
          webhook.lastErrorDate = Math.floor(Date.now() / 1_000);
          webhook.lastErrorMessage = `Wrong response from the webhook: ${delivery.status}`;
        }
        return telegramError("Bad Gateway: webhook delivery failed", 502);
      }
      if (state.webhook !== webhook) {
        return undefined;
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
    }
  }
  return undefined;
}

async function validateTelegramWebhookUrl(
  state: Pick<TelegramServerState, "allowLoopbackHttpWebhook" | "restrictWebhookTargets">,
  url: URL,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<Response | { addresses: WebhookAddress[] | undefined }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return telegramError("Bad Request: webhook host could not be resolved");
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Webhook delivery timed out", "TimeoutError")),
    remainingMs,
  );
  timer.unref();
  let target;
  try {
    target = await validateWebhookTarget({
      allowLoopbackHttp: state.allowLoopbackHttpWebhook,
      restrictPrivateAddresses: state.restrictWebhookTargets,
      signal: AbortSignal.any([signal, deadline.signal]),
      url,
    });
  } catch {
    return telegramError("Bad Request: webhook host could not be resolved");
  } finally {
    clearTimeout(timer);
  }
  if (!("error" in target)) {
    return target;
  }
  return target.error === "unresolvable"
    ? telegramError("Bad Request: webhook host could not be resolved")
    : target.error === "private-address"
      ? telegramError("Bad Request: webhook URL must not target a private or link-local address")
      : telegramError("Bad Request: webhook URL must use HTTPS");
}

/** @internal */
export async function withTelegramWebhookDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new DOMException("Webhook delivery timed out", "TimeoutError");
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Webhook delivery aborted", "AbortError"),
        ),
      );
    const timer = setTimeout(
      () => finish(() => reject(new DOMException("Webhook delivery timed out", "TimeoutError"))),
      remainingMs,
    );
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function postTelegramWebhook(
  state: TelegramServerState,
  webhook: TelegramWebhook,
  update: TelegramUpdate,
): Promise<{ error: string } | { status: number }> {
  const url = new URL(webhook.url);
  const deadlineAt = Date.now() + TELEGRAM_WEBHOOK_DELIVERY_TIMEOUT_MS;
  const controller = new AbortController();
  state.activeWebhookDeliveries.add(controller);
  try {
    const target = await validateTelegramWebhookUrl(state, url, deadlineAt, controller.signal);
    if (target instanceof Response) {
      return { error: "Webhook target is no longer allowed" };
    }
    const addresses: Array<WebhookAddress | undefined> =
      target.addresses && target.addresses.length > 0 ? target.addresses : [undefined];
    let lastError: unknown;
    for (const [index, address] of addresses.entries()) {
      if (state.closing) {
        throw new Error("Telegram server is shutting down.");
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new DOMException("Webhook delivery timed out", "TimeoutError");
      }
      try {
        const attemptsRemaining = addresses.length - index;
        const status = await postWebhookRequest({
          address,
          body: JSON.stringify(update),
          headerEntries: webhook.secretToken
            ? [["x-telegram-bot-api-secret-token", webhook.secretToken]]
            : undefined,
          signal: controller.signal,
          timeoutMs: Math.max(1, Math.floor(remainingMs / attemptsRemaining)),
          url,
        });
        return { status };
      } catch (error) {
        lastError = error;
        if (state.closing || controller.signal.aborted) {
          throw error;
        }
      }
    }
    throw lastError;
  } finally {
    state.activeWebhookDeliveries.delete(controller);
  }
}

async function replaceTelegramWebhook(
  state: TelegramServerState,
  webhook: TelegramWebhook | undefined,
  dropPendingUpdates: boolean,
): Promise<void> {
  let releaseAdmission!: () => void;
  const previousAdmission = state.webhookAdmission;
  state.webhookAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  await previousAdmission;
  try {
    state.webhook = undefined;
    clearTelegramWebhookRetry(state, true);
    for (const controller of state.activeWebhookDeliveries) {
      controller.abort();
    }
    await state.webhookDelivery;
    if (dropPendingUpdates) {
      state.updates.length = 0;
    }
    state.webhook = webhook;
    if (webhook) {
      finishTelegramUpdatePoll(state, "conflict");
      scheduleTelegramWebhookDelivery(state, 0);
    }
  } finally {
    releaseAdmission();
  }
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
  if (!scheduledRetry && state.webhookRetryTimer) {
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
        const delayMs =
          TELEGRAM_WEBHOOK_RETRY_BASE_MS *
          2 ** Math.min(state.webhookRetryAttempts, TELEGRAM_WEBHOOK_MAX_BACKOFF_EXPONENT);
        state.webhookRetryAttempts = Math.min(
          state.webhookRetryAttempts + 1,
          TELEGRAM_WEBHOOK_MAX_BACKOFF_EXPONENT,
        );
        scheduleTelegramWebhookDelivery(state, delayMs);
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
        await replaceTelegramWebhook(
          params.state,
          undefined,
          toBooleanValue(params.body.drop_pending_updates),
        );
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
      if (params.state.activeWebhookValidations.size >= MAX_ACTIVE_TELEGRAM_WEBHOOK_VALIDATIONS) {
        return telegramError("Too Many Requests: too many webhook validations", 429);
      }
      const validation = new AbortController();
      params.state.activeWebhookValidations.add(validation);
      const target = await validateTelegramWebhookUrl(
        params.state,
        parsedUrl,
        Date.now() + TELEGRAM_WEBHOOK_DELIVERY_TIMEOUT_MS,
        validation.signal,
      ).finally(() => {
        params.state.activeWebhookValidations.delete(validation);
      });
      if (target instanceof Response) {
        return target;
      }
      const secretToken = toStringValue(params.body.secret_token);
      if (secretToken && !/^[A-Za-z0-9_-]{1,256}$/u.test(secretToken)) {
        return telegramError("Bad Request: invalid secret token");
      }
      await replaceTelegramWebhook(
        params.state,
        {
          ...(secretToken ? { secretToken } : {}),
          url: parsedUrl.href,
        },
        toBooleanValue(params.body.drop_pending_updates),
      );
      return telegramOk(true);
    }
    case "deletewebhook":
      await replaceTelegramWebhook(
        params.state,
        undefined,
        toBooleanValue(params.body.drop_pending_updates),
      );
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
  if (params.body.offset !== undefined && offset === undefined) {
    return telegramError("Bad Request: offset must be a safe integer");
  }
  if (params.body.limit !== undefined && toIntegerValue(params.body.limit) === undefined) {
    return telegramError("Bad Request: limit must be a safe integer");
  }
  if (params.body.timeout !== undefined && toIntegerValue(params.body.timeout) === undefined) {
    return telegramError("Bad Request: timeout must be a safe integer");
  }
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
  const event: TelegramServerEvent = {
    at: new Date().toISOString(),
    body: redactTelegramSecrets(body),
    method: requestMethod,
    path: `/bot<redacted>/${botPath.method}`,
    query: redactTelegramSecrets(queryRecord(url)),
    type: "api",
  };
  if (TELEGRAM_SEND_METHODS.has(botPath.method.toLowerCase())) {
    const response = await handleTelegramApi({
      body,
      method: botPath.method,
      request: params.request,
      state: params.state,
    });
    event.accepted = response.ok;
    try {
      await appendEvent(params.state, event);
    } catch (error) {
      if (!event.accepted) {
        throw error;
      }
    }
    return response;
  }
  await appendEvent(params.state, event);
  return await handleTelegramApi({
    body,
    method: botPath.method,
    request: params.request,
    state: params.state,
  });
}

async function serveRequest(params: {
  request: IncomingMessage;
  response: ServerResponse;
  state: TelegramServerState;
}): Promise<void> {
  let fetchResponse: Response;
  try {
    fetchResponse = await handleRequest({ request: params.request, state: params.state });
  } catch (error) {
    fetchResponse =
      error instanceof InvalidJsonBodyError
        ? telegramError("Bad Request: can't parse JSON object")
        : error instanceof RequestBodyTooLargeError
          ? telegramError("Request Entity Too Large", 413)
          : jsonResponse({ error: "internal server error", ok: false }, 500);
  }

  try {
    await writeResponse(params.response, fetchResponse);
  } catch {
    // A disconnected client cannot receive an error fallback. End delivery here
    // so the Node request callback never leaks an unhandled rejection.
    params.response.destroy();
  }
}

export async function startTelegramServer(
  params: StartTelegramServerParams = {},
): Promise<StartedTelegramServer> {
  const host = params.host ?? "127.0.0.1";
  const botId = params.botId ?? 424242;
  if (!Number.isSafeInteger(botId) || botId < 1) {
    throw new Error("botId must be a positive safe integer.");
  }
  const state: TelegramServerState = {
    activeUpdatePoll: undefined,
    activeWebhookDeliveries: new Set(),
    activeWebhookValidations: new Set(),
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    allowLoopbackHttpWebhook: isLoopbackHost(host),
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
    restrictWebhookTargets: true,
    closing: false,
    updates: [],
    webhook: undefined,
    webhookAdmission: Promise.resolve(),
    webhookDelivery: undefined,
    webhookRetryAttempts: 0,
    webhookRetryTimer: undefined,
    webhookRetryUpdateId: undefined,
  };
  const port = params.port ?? 0;
  const server = createServer((request, response) => {
    void serveRequest({ request, response, state });
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
      for (const controller of state.activeWebhookValidations) {
        controller.abort();
      }
      await state.webhookDelivery;
      await state.webhookAdmission;
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
