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
  jsonResponse,
  queryRecord,
  readBody,
  RequestBodyTooLargeError,
  writeResponse,
} from "./http.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";

const TELEGRAM_MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

type TelegramServerEvent = {
  at: string;
  body?: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
  type: "admin" | "api";
};

type TelegramServerState = {
  activeUpdatePoll: TelegramUpdatePoll | undefined;
  adminToken: string;
  botId: number;
  botToken: string;
  botUsername: string;
  closing: boolean;
  nextMessageId: number;
  nextUpdateId: number;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
  updates: TelegramUpdate[];
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
  if (contentTypes.some((entry) => entry.includes("json"))) {
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch (error) {
      throw new InvalidJsonBodyError(error);
    }
  }
  const multipartType = contentTypes.find((entry) => entry.includes("multipart/form-data"));
  if (multipartType) {
    return parseMultipartFormDataBody(body, multipartType);
  }
  const params = new URLSearchParams(body.toString("utf8"));
  return Object.fromEntries(params.entries());
}

function parseMultipartFormDataBody(body: Buffer, contentType: string): Record<string, unknown> {
  const boundary = /(?:^|;\s*)boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundaryValue = boundary?.[1] ?? boundary?.[2];
  if (!boundaryValue) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  const delimiter = `--${boundaryValue}`;
  for (const rawPart of body.toString("binary").split(delimiter)) {
    const part = rawPart.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (!part || part === "--") {
      continue;
    }
    const separatorIndex = part.indexOf("\r\n\r\n");
    if (separatorIndex < 0) {
      continue;
    }
    const rawHeaders = part.slice(0, separatorIndex);
    const rawContent = part.slice(separatorIndex + 4).replace(/\r?\n--$/u, "");
    const disposition = rawHeaders
      .split(/\r?\n/u)
      .find((header) => header.toLowerCase().startsWith("content-disposition:"));
    const name = /(?:^|;\s*)name="([^"]+)"/iu.exec(disposition ?? "")?.[1];
    if (!name) {
      continue;
    }
    const filename = /(?:^|;\s*)filename="([^"]*)"/iu.exec(disposition ?? "")?.[1];
    fields[name] = filename && filename.length > 0 ? filename : rawContent;
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
  if (messageId !== undefined) {
    state.nextMessageId = Math.max(state.nextMessageId, messageId + 1);
  }
  if (updateId !== undefined) {
    state.nextUpdateId = Math.max(state.nextUpdateId, updateId + 1);
  }
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
      message_id: messageId ?? state.nextMessageId++,
      ...(entities && entities.length > 0 ? { entities } : {}),
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      text,
    },
    update_id: updateId ?? state.nextUpdateId++,
  };
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
    case "deletewebhook":
    case "setwebhook":
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
    const update = createInboundUpdate(params.state, body);
    await appendEvent(params.state, {
      at: new Date().toISOString(),
      body,
      method: params.request.method ?? "POST",
      path: url.pathname,
      query: queryRecord(url),
      type: "admin",
    });
    if (!update) {
      return telegramError("Bad Request: chatId and text are required");
    }
    params.state.updates.push(update);
    params.state.updates.sort((left, right) => left.update_id - right.update_id);
    finishTelegramUpdatePoll(params.state, "update");
    return jsonResponse({ ok: true, update });
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
    body,
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
  const state: TelegramServerState = {
    activeUpdatePoll: undefined,
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    botId: params.botId ?? 424242,
    botToken: params.botToken ?? "424242:crabline-telegram-token",
    botUsername: params.botUsername ?? "crabline_bot",
    nextMessageId: 1,
    nextUpdateId: 1,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "telegram.jsonl"),
    closing: false,
    updates: [],
  };
  const host = params.host ?? "127.0.0.1";
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
            : jsonResponse(
                {
                  error: error instanceof Error ? error.message : String(error),
                  ok: false,
                },
                500,
              ),
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
