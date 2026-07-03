import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  adminAuthError,
  hasAdminToken,
  jsonResponse,
  parseRequestBody,
  queryRecord,
  readTrimmedString,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";

type ZaloChatType = "GROUP" | "PRIVATE";

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
  resolve(response: Response): void;
  timeout: NodeJS.Timeout;
};

type ZaloServerState = {
  adminToken: string;
  botId: string;
  botName: string;
  botToken: string;
  nextMessage: number;
  pendingRequests: PendingUpdateRequest[];
  recorderPath: string;
  updates: ZaloUpdate[];
  webhook: { secretToken: string; updatedAt: number; url: string } | undefined;
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
  port?: number | undefined;
  recorderPath?: string | undefined;
};

async function appendEvent(state: ZaloServerState, event: ServerRequestEvent): Promise<void> {
  await fs.mkdir(path.dirname(state.recorderPath), { recursive: true });
  await fs.appendFile(state.recorderPath, `${JSON.stringify(event)}\n`, "utf8");
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

function nextUpdate(state: ZaloServerState): Response | undefined {
  const update = state.updates.shift();
  return update ? zaloOk(update) : undefined;
}

function waitForUpdate(state: ZaloServerState, timeoutSeconds: number): Promise<Response> {
  const queued = nextUpdate(state);
  if (queued) {
    return Promise.resolve(queued);
  }
  if (timeoutSeconds <= 0) {
    return Promise.resolve(zaloError("Request timeout", 408));
  }
  return new Promise((resolve) => {
    const pending: PendingUpdateRequest = {
      resolve,
      timeout: setTimeout(() => {
        const index = state.pendingRequests.indexOf(pending);
        if (index >= 0) {
          state.pendingRequests.splice(index, 1);
        }
        resolve(zaloError("Request timeout", 408));
      }, timeoutSeconds * 1000),
    };
    state.pendingRequests.push(pending);
  });
}

function deliverPollingUpdate(state: ZaloServerState, update: ZaloUpdate): void {
  const pending = state.pendingRequests.shift();
  if (!pending) {
    state.updates.push(update);
    return;
  }
  clearTimeout(pending.timeout);
  pending.resolve(zaloOk(update));
}

async function deliverWebhookUpdate(
  webhook: NonNullable<ZaloServerState["webhook"]>,
  update: ZaloUpdate,
): Promise<Response | undefined> {
  try {
    const response = await fetch(webhook.url, {
      body: JSON.stringify({ ok: true, result: update }),
      headers: {
        "content-type": "application/json",
        "x-bot-api-secret-token": webhook.secretToken,
      },
      method: "POST",
    });
    if (!response.ok) {
      return zaloError(`Webhook delivery failed with HTTP ${response.status}`, 502);
    }
  } catch (error) {
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
    return adminAuthError();
  }
  const body = await parseRequestBody(request);
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
  await appendEvent(state, {
    at: new Date().toISOString(),
    body,
    method: request.method ?? "POST",
    path: url.pathname,
    query: queryRecord(url),
    type: "admin",
  });
  if (state.webhook?.url) {
    const error = await deliverWebhookUpdate(state.webhook, update);
    if (error) {
      return error;
    }
  } else {
    deliverPollingUpdate(state, update);
  }
  return zaloOk(update);
}

async function handleZaloMethod(
  request: IncomingMessage,
  state: ZaloServerState,
  url: URL,
  method: string,
): Promise<Response> {
  const body = requestParams(url, await parseRequestBody(request));
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
    return await waitForUpdate(state, timeout);
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
      return zaloError("url must be a valid HTTP or HTTPS URL", 400);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return zaloError("url must be a valid HTTP or HTTPS URL", 400);
    }
    state.updates.length = 0;
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
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    botId: params.botId ?? "1459232241454765289",
    botName: params.botName ?? "bot.crabline",
    botToken: params.botToken ?? "crabline-zalo-bot-token",
    nextMessage: 1,
    pendingRequests: [],
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "zalo.jsonl"),
    updates: [],
    webhook: undefined,
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
        return zaloError("Unauthorized", 401);
      }
      return await handleZaloMethod(request, state, url, match[2] ?? "");
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
      for (const pending of state.pendingRequests.splice(0)) {
        clearTimeout(pending.timeout);
        pending.resolve(zaloError("Server shutting down", 503));
      }
      await httpServer.close();
    },
    manifest,
  };
}
