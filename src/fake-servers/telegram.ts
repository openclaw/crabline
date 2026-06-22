import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { CrablineError } from "../core/errors.js";

type TelegramFakeServerEvent = {
  at: string;
  body?: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
  type: "admin" | "api";
};

type TelegramFakeServerState = {
  botId: number;
  botToken: string;
  botUsername: string;
  nextMessageId: number;
  nextUpdateId: number;
  recorderPath: string;
  updates: TelegramUpdate[];
};

type TelegramMessage = {
  chat: {
    id: number | string;
    title?: string;
    type: "group" | "private" | "supergroup";
  };
  date: number;
  from: {
    first_name: string;
    id: number;
    is_bot: boolean;
    username?: string;
  };
  message_id: number;
  message_thread_id?: number;
  text: string;
};

type TelegramUpdate = {
  message: TelegramMessage;
  update_id: number;
};

export type TelegramFakeServerManifest = {
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

export type StartedTelegramFakeServer = {
  close(): Promise<void>;
  manifest: TelegramFakeServerManifest;
};

export type StartTelegramFakeServerParams = {
  botId?: number | undefined;
  botToken?: string | undefined;
  botUsername?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function telegramOk(result: unknown): Response {
  return jsonResponse({ ok: true, result });
}

function telegramError(description: string, status = 400): Response {
  return jsonResponse({ description, error_code: status, ok: false }, status);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function parseRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (body.length === 0) {
    return {};
  }
  const contentType = request.headers["content-type"] ?? "";
  if (
    Array.isArray(contentType)
      ? contentType.some((entry) => entry.includes("json"))
      : contentType.includes("json")
  ) {
    return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  }
  const params = new URLSearchParams(body.toString("utf8"));
  return Object.fromEntries(params.entries());
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function writeResponse(response: ServerResponse, fetchResponse: Response): Promise<void> {
  response.statusCode = fetchResponse.status;
  for (const [name, value] of fetchResponse.headers) {
    response.setHeader(name, value);
  }
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
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

async function appendEvent(state: TelegramFakeServerState, event: TelegramFakeServerEvent) {
  await fs.mkdir(path.dirname(state.recorderPath), { recursive: true });
  await fs.appendFile(state.recorderPath, `${JSON.stringify(event)}\n`, "utf8");
}

function createBotUser(state: TelegramFakeServerState) {
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
  return {
    id: chatId,
    type: typeof chatId === "number" && chatId < 0 ? "supergroup" : "private",
  };
}

function createOutboundMessage(
  state: TelegramFakeServerState,
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

function createEditedMessage(
  state: TelegramFakeServerState,
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
  state: TelegramFakeServerState,
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
      message_id: toIntegerValue(body.messageId ?? body.message_id) ?? state.nextMessageId++,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      text,
    },
    update_id: toIntegerValue(body.updateId ?? body.update_id) ?? state.nextUpdateId++,
  };
}

function queryRecord(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function handleTelegramApi(params: {
  body: Record<string, unknown>;
  method: string;
  state: TelegramFakeServerState;
}) {
  switch (params.method) {
    case "getMe":
      return telegramOk(createBotUser(params.state));
    case "deleteWebhook":
    case "setWebhook":
    case "setMyCommands":
    case "deleteMyCommands":
    case "sendChatAction":
    case "answerCallbackQuery":
    case "deleteMessage":
    case "pinChatMessage":
    case "unpinChatMessage":
    case "setMessageReaction":
    case "editForumTopic":
      return telegramOk(true);
    case "createForumTopic":
      return telegramOk({
        icon_color: 0x6fb9f0,
        message_thread_id: params.state.nextMessageId++,
        name: toStringValue(params.body.name) ?? "Crabline Topic",
      });
    case "editMessageText": {
      const message = createEditedMessage(params.state, params.body);
      return message
        ? telegramOk(message)
        : telegramError("Bad Request: chat_id, message_id, and text are required");
    }
    case "sendMessage": {
      const message = createOutboundMessage(params.state, params.body);
      return message
        ? telegramOk(message)
        : telegramError("Bad Request: chat_id and text are required");
    }
    case "getUpdates": {
      const offset = toIntegerValue(params.body.offset);
      const limit = toIntegerValue(params.body.limit) ?? 100;
      const updates =
        offset === undefined
          ? params.state.updates
          : params.state.updates.filter((update) => update.update_id >= offset);
      return telegramOk(updates.slice(0, limit));
    }
    default:
      return telegramError(`Not Found: unsupported method ${params.method}`, 404);
  }
}

async function handleRequest(params: { request: IncomingMessage; state: TelegramFakeServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/crabline/telegram/inbound") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = await parseRequestBody(params.request);
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
    return jsonResponse({ ok: true, update });
  }

  const botPath = requireTelegramBotPath(url.pathname);
  if (!botPath || botPath.token !== params.state.botToken) {
    return new Response("not found", { status: 404 });
  }
  const body =
    params.request.method === "GET" ? queryRecord(url) : await parseRequestBody(params.request);
  await appendEvent(params.state, {
    at: new Date().toISOString(),
    body,
    method: params.request.method ?? "GET",
    path: url.pathname,
    query: queryRecord(url),
    type: "api",
  });
  return handleTelegramApi({
    body,
    method: botPath.method,
    state: params.state,
  });
}

export async function startTelegramFakeServer(
  params: StartTelegramFakeServerParams = {},
): Promise<StartedTelegramFakeServer> {
  const state: TelegramFakeServerState = {
    botId: params.botId ?? 424242,
    botToken: params.botToken ?? "424242:crabline-telegram-token",
    botUsername: params.botUsername ?? "crabline_bot",
    nextMessageId: 1,
    nextUpdateId: 1,
    recorderPath:
      params.recorderPath ?? path.resolve(".crabline", "fake-servers", "telegram.jsonl"),
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
        jsonResponse(
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
    throw new CrablineError("Unable to resolve Telegram fake server address.", {
      kind: "connectivity",
    });
  }
  const baseUrl = `http://${host}:${address.port}`;
  return {
    async close() {
      await closeServer(server);
    },
    manifest: {
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
