import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
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
  isJsonMediaType,
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
import { canonicalizeTelegramUsername, telegramUsernameChatId } from "./telegram-identity.js";

const TELEGRAM_MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const TELEGRAM_WEBHOOK_MAX_BACKOFF_EXPONENT = 5;
const TELEGRAM_WEBHOOK_RETRY_BASE_MS = 100;
const TELEGRAM_WEBHOOK_DELIVERY_TIMEOUT_MS = 3_000;
const MAX_ACTIVE_TELEGRAM_WEBHOOK_VALIDATIONS = 8;
const TELEGRAM_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}(?![\s\S])/u;
const TELEGRAM_MAX_TEXT_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
const TELEGRAM_HTML_TAG_PATTERN =
  /<\/?(?:a|b|blockquote|code|del|em|i|ins|pre|s|span|strike|strong|tg-emoji|tg-spoiler|tg-time|u)(?:\s+[^<>]*)?>/giu;
const TELEGRAM_HTML_ENTITY_PATTERN = /&(?:#\d+|#x[\da-f]+|amp|gt|lt|quot);/giu;
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
const TELEGRAM_NEW_MESSAGE_UPDATE_FIELDS = ["business_message", "channel_post", "message"] as const;
const TELEGRAM_MESSAGE_REFERENCE_FIELDS = [
  "edited_business_message",
  "edited_channel_post",
  "edited_message",
] as const;
const TELEGRAM_MESSAGE_UPDATE_FIELDS = [
  ...TELEGRAM_NEW_MESSAGE_UPDATE_FIELDS,
  ...TELEGRAM_MESSAGE_REFERENCE_FIELDS,
] as const;
const TELEGRAM_CHAT_UPDATE_FIELDS = [
  "chat_boost",
  "chat_join_request",
  "chat_member",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "my_chat_member",
  "removed_chat_boost",
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
  chatsById: Map<number, TelegramChat>;
  chatsByUsername: Map<string, TelegramChat>;
  closing: boolean;
  inboundAdmission: Promise<void>;
  maxPendingInboundEvents: number;
  nextMessageIds: Map<string, number>;
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

const TELEGRAM_MULTIPART_FILE = Symbol("telegramMultipartFile");

type TelegramMultipartFile = {
  [TELEGRAM_MULTIPART_FILE]: true;
  contentDigest: string;
  fileName: string;
};

type TelegramChat = {
  id: number;
  title?: string;
  type: "channel" | "group" | "private" | "supergroup";
  username?: string;
};

type TelegramMessage = {
  chat: TelegramChat;
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
    custom_emoji_id?: string;
    language?: string;
    length: number;
    offset: number;
    type: string;
    url?: string;
    user?: Record<string, unknown>;
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
  if (contentTypes.some(isJsonMediaType)) {
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
    fields[name] =
      typeof value === "string"
        ? value
        : ({
            [TELEGRAM_MULTIPART_FILE]: true,
            contentDigest: createHash("sha256")
              .update(Buffer.from(await value.arrayBuffer()))
              .digest("base64url"),
            fileName: value.name,
          } satisfies TelegramMultipartFile);
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

function telegramChatId(value: unknown): number | undefined {
  const stringValue = toStringValue(value);
  if (!stringValue) {
    return undefined;
  }
  if (/^-?\d+$/u.test(stringValue)) {
    const integerValue = toIntegerValue(stringValue);
    return integerValue === 0 ? undefined : integerValue;
  }
  return telegramUsernameChatId(stringValue);
}

async function appendEvent(state: TelegramServerState, event: TelegramServerEvent) {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function isTelegramMultipartFile(value: unknown): value is TelegramMultipartFile {
  return (
    typeof value === "object" &&
    value !== null &&
    TELEGRAM_MULTIPART_FILE in value &&
    value[TELEGRAM_MULTIPART_FILE] === true
  );
}

function redactTelegramSecrets(body: Record<string, string>): Record<string, string>;
function redactTelegramSecrets(body: Record<string, unknown>): Record<string, unknown>;
function redactTelegramSecrets(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key === "secret_token"
        ? "<redacted>"
        : isTelegramMultipartFile(value)
          ? value.fileName
          : value,
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

function inferTelegramChatType(chatId: number): TelegramChat["type"] {
  return chatId >= 0 ? "private" : String(chatId).startsWith("-100") ? "supergroup" : "group";
}

function createChat(chatId: number): TelegramChat {
  return {
    id: chatId,
    type: inferTelegramChatType(chatId),
  };
}

function telegramChatUsername(value: unknown): string | undefined {
  const username = toStringValue(value);
  if (!username) {
    return undefined;
  }
  return canonicalizeTelegramUsername(username.startsWith("@") ? username : `@${username}`);
}

function telegramChatType(value: unknown): TelegramChat["type"] | undefined {
  return value === "channel" || value === "group" || value === "private" || value === "supergroup"
    ? value
    : undefined;
}

function registerTelegramChat(state: TelegramServerState, chat: TelegramChat): void {
  const previous = state.chatsById.get(chat.id);
  const previousUsername = telegramChatUsername(previous?.username);
  if (previousUsername && state.chatsByUsername.get(previousUsername)?.id === chat.id) {
    state.chatsByUsername.delete(previousUsername);
  }
  const stored = { ...chat };
  state.chatsById.set(chat.id, stored);
  const username = telegramChatUsername(chat.username);
  if (username) {
    state.chatsByUsername.set(username, stored);
  }
}

function resolveTelegramChat(state: TelegramServerState, value: unknown): TelegramChat | undefined {
  const stringValue = toStringValue(value);
  if (!stringValue) {
    return undefined;
  }
  if (/^-?\d+$/u.test(stringValue)) {
    const chatId = telegramChatId(stringValue);
    if (chatId === undefined) {
      return undefined;
    }
    return state.chatsById.get(chatId) ?? createChat(chatId);
  }
  const username = telegramChatUsername(stringValue);
  if (!username) {
    return undefined;
  }
  const registered = state.chatsByUsername.get(username);
  if (registered) {
    return registered;
  }
  const chatId = telegramUsernameChatId(username);
  return chatId === undefined
    ? undefined
    : {
        id: chatId,
        type: inferTelegramChatType(chatId),
        username: username.slice(1),
      };
}

function telegramChatFromRecord(value: unknown): TelegramChat | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const id = telegramChatId(value.id);
  const type = telegramChatType(value.type);
  if (id === undefined || !type) {
    return undefined;
  }
  const rawUsername = toStringValue(value.username);
  const username = telegramChatUsername(rawUsername);
  const title = toStringValue(value.title);
  return {
    id,
    ...(title ? { title } : {}),
    type,
    ...(username && rawUsername
      ? { username: rawUsername.startsWith("@") ? rawUsername.slice(1) : rawUsername }
      : {}),
  };
}

function registerTelegramUpdateChats(state: TelegramServerState, body: Record<string, unknown>) {
  for (const field of TELEGRAM_MESSAGE_UPDATE_FIELDS) {
    const message = body[field];
    if (!isJsonObject(message)) {
      continue;
    }
    const chat = telegramChatFromRecord(message.chat);
    if (chat) {
      registerTelegramChat(state, chat);
    }
  }
  const callbackQuery = isJsonObject(body.callback_query) ? body.callback_query : undefined;
  const callbackMessage =
    callbackQuery && isJsonObject(callbackQuery.message) ? callbackQuery.message : undefined;
  const callbackChat = telegramChatFromRecord(callbackMessage?.chat);
  if (callbackChat) {
    registerTelegramChat(state, callbackChat);
  }
  for (const field of TELEGRAM_CHAT_UPDATE_FIELDS) {
    const update = body[field];
    if (!isJsonObject(update)) {
      continue;
    }
    const chat = telegramChatFromRecord(update.chat);
    if (chat) {
      registerTelegramChat(state, chat);
    }
  }
}

function telegramChatKey(chatId: number): string {
  return `number:${chatId}`;
}

function nextTelegramMessageId(state: TelegramServerState, chatId: number): number {
  return state.nextMessageIds.get(telegramChatKey(chatId)) ?? 1;
}

function takeNextTelegramMessageId(state: TelegramServerState, chatId: number): number | undefined {
  const messageId = nextTelegramMessageId(state, chatId);
  if (messageId >= Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  state.nextMessageIds.set(telegramChatKey(chatId), messageId + 1);
  return messageId;
}

function createOutboundMessage(
  state: TelegramServerState,
  body: Record<string, unknown>,
  text: string,
): TelegramMessage | undefined {
  const chat = resolveTelegramChat(state, body.chat_id);
  if (!chat) {
    return undefined;
  }
  const parsedThreadId = toIntegerValue(body.message_thread_id);
  if (body.message_thread_id !== undefined && parsedThreadId === undefined) {
    return undefined;
  }
  const messageId = takeNextTelegramMessageId(state, chat.id);
  if (messageId === undefined) {
    return undefined;
  }
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
  return {
    chat,
    date: Math.floor(Date.now() / 1000),
    from: createBotUser(state),
    message_id: messageId,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    text,
  };
}

function createOutboundMediaMessage(
  state: TelegramServerState,
  body: Record<string, unknown>,
  mediaKind: "animation" | "audio" | "document" | "photo" | "video",
  caption: string | undefined,
): TelegramMessage | undefined {
  const chat = resolveTelegramChat(state, body.chat_id);
  const mediaInput = body[mediaKind];
  const multipartFile = isTelegramMultipartFile(mediaInput) ? mediaInput : undefined;
  const fileName = multipartFile?.fileName ?? toStringValue(mediaInput);
  if (!chat || !fileName) {
    return undefined;
  }
  const parsedThreadId = toIntegerValue(body.message_thread_id);
  if (body.message_thread_id !== undefined && parsedThreadId === undefined) {
    return undefined;
  }
  const messageId = takeNextTelegramMessageId(state, chat.id);
  if (messageId === undefined) {
    return undefined;
  }
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
  const duration = Math.max(0, toIntegerValue(body.duration) ?? 0);
  const height = Math.max(1, toIntegerValue(body.height) ?? 1);
  const width = Math.max(1, toIntegerValue(body.width) ?? 1);
  const chatIdentity = Buffer.from(telegramChatKey(chat.id)).toString("base64url");
  const reusedIdentity = new RegExp(`^crabline-${mediaKind}-([A-Za-z0-9_-]{32})-`, "u").exec(
    fileName,
  )?.[1];
  const fileIdentity =
    multipartFile?.contentDigest.slice(0, 32) ??
    reusedIdentity ??
    createHash("sha256")
      .update(mediaKind)
      .update("\0")
      .update(fileName)
      .digest("base64url")
      .slice(0, 32);
  const fileId = `crabline-${mediaKind}-${fileIdentity}-${chatIdentity}-${messageId}`;
  const fileUniqueId = `crabline-${mediaKind}-unique-${fileIdentity}`;
  const media = {
    file_id: fileId,
    file_name: fileName,
    file_unique_id: fileUniqueId,
  };
  return {
    chat,
    date: Math.floor(Date.now() / 1000),
    from: createBotUser(state),
    ...(caption ? { caption } : {}),
    [mediaKind]:
      mediaKind === "photo"
        ? [
            {
              file_id: media.file_id,
              file_unique_id: media.file_unique_id,
              height: 1,
              width: 1,
            },
          ]
        : {
            ...media,
            ...(mediaKind === "audio"
              ? { duration }
              : mediaKind === "animation" || mediaKind === "video"
                ? { duration, height, width }
                : {}),
            mime_type: "application/octet-stream",
          },
    message_id: messageId,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  };
}

function createEditedMessage(
  state: TelegramServerState,
  body: Record<string, unknown>,
  text: string,
): TelegramMessage | undefined {
  const chat = resolveTelegramChat(state, body.chat_id);
  const messageId = toIntegerValue(body.message_id);
  if (!chat || messageId === undefined) {
    return undefined;
  }
  const parsedThreadId = toIntegerValue(body.message_thread_id);
  if (body.message_thread_id !== undefined && parsedThreadId === undefined) {
    return undefined;
  }
  const threadId = parsedThreadId !== undefined && parsedThreadId > 0 ? parsedThreadId : undefined;
  return {
    chat,
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
  const chat = resolveTelegramChat(state, body.chatId ?? body.chat_id);
  const text = body.text;
  if (
    !chat ||
    typeof text !== "string" ||
    text.length < 1 ||
    text.length > TELEGRAM_MAX_TEXT_LENGTH
  ) {
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
  const explicitChatType = telegramChatType(body.chatType ?? body.chat_type);
  if (
    ((body.chatType !== undefined || body.chat_type !== undefined) && !explicitChatType) ||
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
      chat: explicitChatType ? { ...chat, type: explicitChatType } : chat,
      date: Math.floor(Date.now() / 1000),
      from: {
        first_name: toStringValue(body.fromName ?? body.from_name) ?? "QA User",
        id: fromId ?? 100001,
        is_bot: false,
        ...(fromUsername ? { username: fromUsername } : {}),
      },
      message_id: messageId ?? nextTelegramMessageId(state, chat.id),
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
): TelegramMessage["entities"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entities: NonNullable<TelegramMessage["entities"]> = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return undefined;
    }
    const length = toIntegerValue(entry.length);
    const offset = toIntegerValue(entry.offset);
    const type = typeof entry.type === "string" && entry.type.length > 0 ? entry.type : undefined;
    const customEmojiId = entry.custom_emoji_id;
    const language = entry.language;
    const url = entry.url;
    const user = entry.user;
    if (
      length === undefined ||
      length < 1 ||
      offset === undefined ||
      offset < 0 ||
      offset + length > text.length ||
      !type ||
      (customEmojiId !== undefined &&
        (typeof customEmojiId !== "string" || customEmojiId.length === 0)) ||
      (language !== undefined && (typeof language !== "string" || language.length === 0)) ||
      (url !== undefined && (typeof url !== "string" || url.length === 0)) ||
      (user !== undefined && !isJsonObject(user))
    ) {
      return undefined;
    }
    entities.push({
      ...(customEmojiId !== undefined ? { custom_emoji_id: customEmojiId } : {}),
      ...(language !== undefined ? { language } : {}),
      length,
      offset,
      type,
      ...(url !== undefined ? { url } : {}),
      ...(user !== undefined ? { user } : {}),
    });
  }
  return entities;
}

function hasTelegramMedia(value: Record<string, unknown>): boolean {
  return TELEGRAM_MEDIA_FIELDS.some((field) => value[field] !== undefined);
}

function explicitTelegramId(
  body: Record<string, unknown>,
  names: readonly string[],
  additionalValues: readonly unknown[] = [],
  options: { allowZero?: boolean } = {},
): { present: false } | { present: true; value: number } | undefined {
  const values = [
    ...names.flatMap((name) => (body[name] === undefined ? [] : [body[name]])),
    ...additionalValues.filter((value) => value !== undefined),
  ];
  if (values.length === 0) {
    return { present: false };
  }
  const parsed = values.map(toIntegerValue);
  const minimum = options.allowZero ? 0 : 1;
  if (
    parsed.some(
      (value) => value === undefined || value < minimum || value >= Number.MAX_SAFE_INTEGER,
    ) ||
    new Set(parsed).size !== 1
  ) {
    return undefined;
  }
  return { present: true, value: parsed[0]! };
}

function explicitTelegramMessageIdValues(body: Record<string, unknown>): unknown[] {
  return TELEGRAM_NEW_MESSAGE_UPDATE_FIELDS.flatMap((field) => {
    const message = body[field];
    return isJsonObject(message) ? [message.message_id] : [];
  });
}

function referencedTelegramMessageIdValues(body: Record<string, unknown>): unknown[] {
  const values = TELEGRAM_MESSAGE_REFERENCE_FIELDS.flatMap((field) => {
    const message = body[field];
    return isJsonObject(message) ? [message.message_id] : [];
  });
  const callbackQuery = isJsonObject(body.callback_query) ? body.callback_query : undefined;
  const callbackMessage =
    callbackQuery && isJsonObject(callbackQuery.message) ? callbackQuery.message : undefined;
  return callbackMessage ? [...values, callbackMessage.message_id] : values;
}

function explicitTelegramMessageChatId(body: Record<string, unknown>): number | undefined | false {
  const chatIds: number[] = [];
  if (body.messageId !== undefined || body.message_id !== undefined) {
    const chatId = telegramChatId(body.chatId ?? body.chat_id);
    if (chatId === undefined) {
      return false;
    }
    chatIds.push(chatId);
  }
  for (const field of TELEGRAM_MESSAGE_UPDATE_FIELDS) {
    const message = body[field];
    if (!isJsonObject(message) || message.message_id === undefined) {
      continue;
    }
    const chat = isJsonObject(message.chat) ? message.chat : undefined;
    const chatId = telegramChatId(chat?.id);
    if (chatId === undefined) {
      return false;
    }
    chatIds.push(chatId);
  }
  const callbackQuery = isJsonObject(body.callback_query) ? body.callback_query : undefined;
  const callbackMessage =
    callbackQuery && isJsonObject(callbackQuery.message) ? callbackQuery.message : undefined;
  if (callbackMessage?.message_id !== undefined) {
    const chat = isJsonObject(callbackMessage.chat) ? callbackMessage.chat : undefined;
    const chatId = telegramChatId(chat?.id);
    if (chatId === undefined) {
      return false;
    }
    chatIds.push(chatId);
  }
  if (chatIds.length === 0) {
    return undefined;
  }
  const firstChatId = chatIds[0]!;
  return chatIds.every((chatId) => telegramChatKey(chatId) === telegramChatKey(firstChatId))
    ? firstChatId
    : false;
}

function readTelegramTextField(
  value: unknown,
  field: "caption" | "text",
  options: { parseMode?: unknown; required: boolean },
): Response | string | undefined {
  if (value === undefined) {
    return options.required ? telegramError(`Bad Request: ${field} is required`) : undefined;
  }
  if (typeof value !== "string") {
    return telegramError(`Bad Request: ${field} must be a string`);
  }
  const parsedLength = telegramTextLength(value, options.parseMode);
  if (options.required && parsedLength === 0) {
    return telegramError(`Bad Request: ${field} must not be empty`);
  }
  const maxLength = field === "text" ? TELEGRAM_MAX_TEXT_LENGTH : TELEGRAM_MAX_CAPTION_LENGTH;
  if (parsedLength > maxLength) {
    return telegramError(`Bad Request: ${field} is too long`);
  }
  return value;
}

function telegramTextLength(value: string, parseMode: unknown): number {
  const normalizedParseMode = typeof parseMode === "string" ? parseMode.toLowerCase() : undefined;
  if (normalizedParseMode === "html") {
    return telegramHtmlText(value).length;
  }
  if (normalizedParseMode === "markdown" || normalizedParseMode === "markdownv2") {
    return telegramMarkdownText(value, normalizedParseMode === "markdownv2").length;
  }
  return value.length;
}

function telegramHtmlText(value: string): string {
  return value
    .replace(TELEGRAM_HTML_TAG_PATTERN, "")
    .replace(TELEGRAM_HTML_ENTITY_PATTERN, (entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === "&amp;") {
        return "&";
      }
      if (normalized === "&gt;") {
        return ">";
      }
      if (normalized === "&lt;") {
        return "<";
      }
      if (normalized === "&quot;") {
        return '"';
      }
      const radix = normalized.startsWith("&#x") ? 16 : 10;
      const digits = normalized.slice(radix === 16 ? 3 : 2, -1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
}

function protectTelegramMarkdownEscapes(value: string, versionTwo: boolean): string {
  let protectedText = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const escapedCharacter = value[index + 1];
    if (
      character === "\\" &&
      escapedCharacter !== undefined &&
      (versionTwo
        ? escapedCharacter.charCodeAt(0) >= 1 && escapedCharacter.charCodeAt(0) <= 0x7e
        : "*_[]`".includes(escapedCharacter))
    ) {
      protectedText += "\0";
      index += 1;
      continue;
    }
    protectedText += character;
  }
  return protectedText;
}

function telegramMarkdownLiteralMask(value: string): string {
  return "\0".repeat(value.length);
}

function stripTelegramMarkdownExpandableMarker(line: string): string {
  if (!line.endsWith("||")) {
    return line;
  }
  let markers = 0;
  for (let index = line.indexOf("||"); index >= 0; index = line.indexOf("||", index + 2)) {
    markers += 1;
  }
  return markers % 2 === 1 ? line.slice(0, -2) : line;
}

function telegramMarkdownText(value: string, versionTwo: boolean): string {
  let parsed = protectTelegramMarkdownEscapes(value, versionTwo)
    .replace(/```(?:[^\n]*\n)?([\s\S]*?)```/gu, (_match, content: string) =>
      telegramMarkdownLiteralMask(content),
    )
    .replace(/`([^`\n]*)`/gu, (_match, content: string) => telegramMarkdownLiteralMask(content))
    .replace(
      /!\[([^\]\n]+)\]\(tg:\/\/(?:emoji\?id=\d+|time\?unix=-?\d+(?:&format=[rwdDtT]+)?)\)/gu,
      "$1",
    )
    .replace(/\[([^\]\n]+)\]\((?:\\.|[^)\n])*\)/gu, "$1");
  if (versionTwo) {
    parsed = parsed
      .replace(/^(?:\*\*)?>[^\n]*$/gmu, stripTelegramMarkdownExpandableMarker)
      .replace(/^\*\*(?=>)/gmu, "")
      .replace(/^>/gmu, "")
      .replace(/\|\|([\s\S]*?)\|\|/gu, "$1")
      .replace(/__([\s\S]*?)__/gu, "$1")
      .replace(/~([\s\S]*?)~/gu, "$1");
  }
  let previous: string;
  do {
    previous = parsed;
    parsed = parsed.replace(/\*([\s\S]*?)\*/gu, "$1").replace(/_([\s\S]*?)_/gu, "$1");
  } while (parsed !== previous);
  return parsed;
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
    const nextUpdateId = params.state.nextUpdateId;
    const explicitMessageId = explicitTelegramId(
      params.body,
      ["messageId", "message_id"],
      explicitTelegramMessageIdValues(params.body),
      { allowZero: true },
    );
    const explicitMessageChatId = explicitTelegramMessageChatId(params.body);
    const explicitUpdateId = explicitTelegramId(params.body, ["updateId", "update_id"]);
    const referencedMessageId = explicitTelegramId(
      {},
      [],
      referencedTelegramMessageIdValues(params.body),
      { allowZero: true },
    );
    const topLevelChatId = resolveTelegramChat(
      params.state,
      params.body.chatId ?? params.body.chat_id,
    )?.id;
    const messageChatId =
      explicitMessageChatId === false ? undefined : (explicitMessageChatId ?? topLevelChatId);
    const messageChatKey = messageChatId === undefined ? undefined : telegramChatKey(messageChatId);
    const previousNextMessageId =
      messageChatKey === undefined ? undefined : params.state.nextMessageIds.get(messageChatKey);
    const nextMessageId =
      messageChatId === undefined ? undefined : nextTelegramMessageId(params.state, messageChatId);
    if (
      explicitMessageId === undefined ||
      explicitMessageChatId === false ||
      explicitUpdateId === undefined ||
      referencedMessageId === undefined ||
      (explicitMessageId.present &&
        explicitMessageId.value > 0 &&
        (nextMessageId === undefined || explicitMessageId.value < nextMessageId)) ||
      (explicitUpdateId.present && explicitUpdateId.value < nextUpdateId)
    ) {
      return telegramError("Bad Request: explicit IDs must be valid and monotonic");
    }
    const update = createInboundUpdate(params.state, params.body);
    params.state.nextUpdateId = nextUpdateId;
    if (
      update &&
      ((!explicitMessageId.present &&
        (nextMessageId ?? Number.MAX_SAFE_INTEGER) >= Number.MAX_SAFE_INTEGER) ||
        (!explicitUpdateId.present && nextUpdateId >= Number.MAX_SAFE_INTEGER))
    ) {
      return telegramError("Bad Request: generated ID space is exhausted");
    }
    if (!update) {
      if (isValidIgnoredTelegramUpdate(params.body)) {
        if (messageChatKey !== undefined) {
          const observedNextMessageIds = [
            ...(explicitMessageId.present && explicitMessageId.value > 0
              ? [explicitMessageId.value + 1]
              : []),
            ...(referencedMessageId.present && referencedMessageId.value > 0
              ? [referencedMessageId.value + 1]
              : []),
          ];
          if (observedNextMessageIds.length > 0) {
            params.state.nextMessageIds.set(
              messageChatKey,
              Math.max(
                params.state.nextMessageIds.get(messageChatKey) ?? 1,
                ...observedNextMessageIds,
              ),
            );
          }
        }
        if (explicitUpdateId.present) {
          params.state.nextUpdateId = explicitUpdateId.value + 1;
        }
        registerTelegramUpdateChats(params.state, params.body);
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
    const updateChatKey = telegramChatKey(update.message.chat.id);
    params.state.nextMessageIds.set(
      updateChatKey,
      Math.max(
        params.state.nextMessageIds.get(updateChatKey) ?? 1,
        update.message.message_id + 1,
        ...(referencedMessageId.present && referencedMessageId.value > 0
          ? [referencedMessageId.value + 1]
          : []),
      ),
    );
    params.state.nextUpdateId = Math.max(params.state.nextUpdateId, update.update_id + 1);
    const reservedNextMessageId = params.state.nextMessageIds.get(updateChatKey)!;
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
      if (params.state.nextMessageIds.get(updateChatKey) === reservedNextMessageId) {
        if (previousNextMessageId === undefined) {
          params.state.nextMessageIds.delete(updateChatKey);
        } else {
          params.state.nextMessageIds.set(updateChatKey, previousNextMessageId);
        }
      }
      if (params.state.nextUpdateId === reservedNextUpdateId) {
        params.state.nextUpdateId = nextUpdateId;
      }
      throw error;
    }
    registerTelegramChat(params.state, update.message.chat);
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
      const secretToken =
        params.body.secret_token === undefined
          ? undefined
          : typeof params.body.secret_token === "string"
            ? params.body.secret_token
            : null;
      if (
        secretToken === null ||
        (secretToken !== undefined && !TELEGRAM_WEBHOOK_SECRET_PATTERN.test(secretToken))
      ) {
        return telegramError("Bad Request: invalid secret token");
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
    case "createforumtopic": {
      const chat = resolveTelegramChat(params.state, params.body.chat_id);
      if (!chat) {
        return telegramError("Bad Request: chat_id is required");
      }
      const messageThreadId = takeNextTelegramMessageId(params.state, chat.id);
      if (messageThreadId === undefined) {
        return telegramError("Bad Request: generated ID space is exhausted");
      }
      return telegramOk({
        icon_color: 0x6fb9f0,
        message_thread_id: messageThreadId,
        name: toStringValue(params.body.name) ?? "Crabline Topic",
      });
    }
    case "editmessagetext": {
      const text = readTelegramTextField(params.body.text, "text", {
        parseMode: params.body.parse_mode,
        required: true,
      });
      if (text instanceof Response) {
        return text;
      }
      const message = createEditedMessage(params.state, params.body, text!);
      return message
        ? telegramOk(message)
        : telegramError("Bad Request: chat_id, message_id, and text are required");
    }
    case "sendmessage": {
      const text = readTelegramTextField(params.body.text, "text", {
        parseMode: params.body.parse_mode,
        required: true,
      });
      if (text instanceof Response) {
        return text;
      }
      const chat = resolveTelegramChat(params.state, params.body.chat_id);
      if (chat && nextTelegramMessageId(params.state, chat.id) >= Number.MAX_SAFE_INTEGER) {
        return telegramError("Bad Request: generated ID space is exhausted");
      }
      const message = createOutboundMessage(params.state, params.body, text!);
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
      const caption = readTelegramTextField(params.body.caption, "caption", {
        parseMode: params.body.parse_mode,
        required: false,
      });
      if (caption instanceof Response) {
        return caption;
      }
      const chat = resolveTelegramChat(params.state, params.body.chat_id);
      if (chat && nextTelegramMessageId(params.state, chat.id) >= Number.MAX_SAFE_INTEGER) {
        return telegramError("Bad Request: generated ID space is exhausted");
      }
      const message = createOutboundMediaMessage(params.state, params.body, mediaKind, caption);
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
    chatsById: new Map(),
    chatsByUsername: new Map(),
    inboundAdmission: Promise.resolve(),
    maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
    nextMessageIds: new Map(),
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
