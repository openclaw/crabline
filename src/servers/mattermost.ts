import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
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
import { closeWebSocketServer } from "./websocket.js";

const DEFAULT_WEBSOCKET_AUTHENTICATION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_WEBSOCKET_BUFFERED_BYTES = 1024 * 1024;

function resolveMaxWebSocketBufferedBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_WEBSOCKET_BUFFERED_BYTES;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("maxWebSocketBufferedBytes must be a positive safe integer.");
  }
  return value;
}

type MattermostPost = {
  channel_id: string;
  create_at: number;
  id: string;
  message: string;
  root_id: string;
  type: string;
  user_id: string;
};

type MattermostWebSocketEvent = {
  broadcast: {
    channel_id: string;
    omit_users: null | Record<string, boolean>;
    team_id: string;
    user_id: string;
  };
  data: Record<string, unknown>;
  event: string;
};

type MattermostServerState = {
  adminToken: string;
  botToken: string;
  botUserId: string;
  botUsername: string;
  channels: Map<string, { id: string; name: string; display_name: string; type: string }>;
  maxPendingInboundEvents: number;
  maxWebSocketBufferedBytes: number;
  nextPost: number;
  onEvent: ServerEventObserver | undefined;
  pendingEvents: MattermostWebSocketEvent[];
  posts: Map<string, MattermostPost>;
  recorderPath: string;
  users: Map<string, { id: string; username: string; update_at: number }>;
  websocketClients: Map<WebSocket, number>;
};

export type MattermostServerManifest = {
  adminToken: string;
  baseUrl: string;
  botToken: string;
  botUserId: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    websocketUrl: string;
  };
  env: {
    MATTERMOST_BOT_TOKEN: string;
    MATTERMOST_URL: string;
  };
  provider: "mattermost";
  recorderPath: string;
  version: 1;
};

export type StartedMattermostServer = {
  close(): Promise<void>;
  manifest: MattermostServerManifest;
};

export type StartMattermostServerParams = {
  adminToken?: string | undefined;
  botToken?: string | undefined;
  botUserId?: string | undefined;
  botUsername?: string | undefined;
  host?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  maxPendingInboundEvents?: number | undefined;
  maxWebSocketBufferedBytes?: number | undefined;
  websocketAuthenticationTimeoutMs?: number | undefined;
};

export function mattermostId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 26);
}

async function appendEvent(state: MattermostServerState, event: ServerRequestEvent): Promise<void> {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function authorized(request: IncomingMessage, token: string): boolean {
  const [scheme, value] = request.headers.authorization?.trim().split(/\s+/, 2) ?? [];
  return scheme?.toLowerCase() === "bearer" && value === token;
}

function mattermostError(message: string, status: number): Response {
  return jsonResponse(
    {
      id: `api.context.${status}`,
      message,
      request_id: "",
      status_code: status,
    },
    status,
  );
}

function eventBroadcast(params: {
  channelId?: string;
  omitUsers?: Record<string, boolean>;
  userId?: string;
}): MattermostWebSocketEvent["broadcast"] {
  return {
    channel_id: params.channelId ?? "",
    omit_users: params.omitUsers ?? null,
    team_id: "",
    user_id: params.userId ?? "",
  };
}

function postEvent(
  event: "post_deleted" | "post_edited" | "posted",
  post: MattermostPost,
  senderName: string,
  channelType: string,
): MattermostWebSocketEvent {
  return {
    event,
    data: {
      channel_display_name: post.channel_id,
      channel_id: post.channel_id,
      channel_name: post.channel_id,
      channel_type: channelType,
      post: JSON.stringify(post),
      sender_name: senderName,
    },
    broadcast: eventBroadcast({ channelId: post.channel_id, userId: post.user_id }),
  };
}

function sendEvent(
  state: MattermostServerState,
  client: WebSocket,
  event: MattermostWebSocketEvent,
): boolean {
  const seq = state.websocketClients.get(client);
  if (seq === undefined || client.readyState !== WebSocket.OPEN) {
    state.websocketClients.delete(client);
    return false;
  }
  const payload = JSON.stringify({ ...event, seq });
  if (
    client.bufferedAmount + Buffer.byteLength(payload, "utf8") >
    state.maxWebSocketBufferedBytes
  ) {
    state.websocketClients.delete(client);
    client.close(1013, "client too slow");
    return false;
  }
  try {
    client.send(payload);
  } catch {
    state.websocketClients.delete(client);
    client.terminate();
    return false;
  }
  state.websocketClients.set(client, seq + 1);
  return true;
}

function broadcast(state: MattermostServerState, event: MattermostWebSocketEvent): boolean {
  if (
    Buffer.byteLength(JSON.stringify({ ...event, seq: 0 }), "utf8") >
    state.maxWebSocketBufferedBytes
  ) {
    for (const client of state.websocketClients.keys()) {
      state.websocketClients.delete(client);
      client.close(1013, "client too slow");
    }
    return false;
  }
  let delivered = false;
  for (const client of state.websocketClients.keys()) {
    delivered = sendEvent(state, client, event) || delivered;
  }
  if (delivered) {
    return true;
  }
  if (state.pendingEvents.length >= state.maxPendingInboundEvents) {
    return false;
  }
  state.pendingEvents.push(event);
  return true;
}

function pendingQueueFullResponse(state: MattermostServerState): Response {
  return jsonResponse(
    {
      error: `Pending inbound queue is full (${state.maxPendingInboundEvents} events)`,
      ok: false,
    },
    503,
  );
}

function createPost(params: {
  channelId: string;
  message: string;
  rootId?: string | undefined;
  state: MattermostServerState;
  userId: string;
}): MattermostPost {
  const id = mattermostId(`post-${params.state.nextPost++}`);
  const post = {
    channel_id: params.channelId,
    create_at: Date.now(),
    id,
    message: params.message,
    root_id: params.rootId ?? "",
    type: "",
    user_id: params.userId,
  };
  params.state.posts.set(id, post);
  return post;
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: MattermostServerState;
}): Promise<Response> {
  const channelId = readTrimmedString(params.body.channelId ?? params.body.channel_id);
  const senderId = readTrimmedString(params.body.senderId ?? params.body.user_id);
  const text = readTrimmedString(params.body.text ?? params.body.message);
  if (!channelId || !senderId || !text) {
    return jsonResponse({ error: "channelId, senderId, and text are required", ok: false }, 400);
  }
  if (
    params.state.websocketClients.size === 0 &&
    params.state.pendingEvents.length >= params.state.maxPendingInboundEvents
  ) {
    return pendingQueueFullResponse(params.state);
  }
  const senderName = readTrimmedString(params.body.senderName) ?? senderId;
  const channelType = readTrimmedString(params.body.channelType) ?? "D";
  params.state.users.set(senderId, { id: senderId, update_at: Date.now(), username: senderName });
  params.state.channels.set(channelId, {
    display_name: channelId,
    id: channelId,
    name: channelId,
    type: channelType,
  });
  const post = createPost({
    channelId,
    message: text,
    rootId: readTrimmedString(params.body.rootId ?? params.body.root_id),
    state: params.state,
    userId: senderId,
  });
  if (!broadcast(params.state, postEvent("posted", post, senderName, channelType))) {
    params.state.posts.delete(post.id);
    return pendingQueueFullResponse(params.state);
  }
  return jsonResponse({ ok: true, post });
}

async function handleApi(params: {
  body: unknown;
  method: string;
  path: string;
  state: MattermostServerState;
}): Promise<Response> {
  const { body, method, path: apiPath, state } = params;
  if (method === "GET" && apiPath === "/users/me") {
    return jsonResponse(state.users.get(state.botUserId));
  }
  const usernameMatch = /^\/users\/username\/([^/]+)$/u.exec(apiPath);
  if (method === "GET" && usernameMatch?.[1]) {
    const username = decodeURIComponent(usernameMatch[1]);
    const user = [...state.users.values()].find((entry) => entry.username === username);
    return user ? jsonResponse(user) : mattermostError("User not found", 404);
  }
  const userMatch = /^\/users\/([^/]+)$/u.exec(apiPath);
  if (method === "GET" && userMatch?.[1]) {
    const user = state.users.get(userMatch[1]);
    return user ? jsonResponse(user) : mattermostError("User not found", 404);
  }
  const channelMatch = /^\/channels\/([^/]+)$/u.exec(apiPath);
  if (method === "GET" && channelMatch?.[1]) {
    const channel = state.channels.get(channelMatch[1]);
    return channel ? jsonResponse(channel) : mattermostError("Channel not found", 404);
  }
  if (method === "POST" && apiPath === "/channels/direct") {
    const userIds = Array.isArray(body) ? body : [];
    if (userIds.length !== 2 || userIds.some((value) => typeof value !== "string" || !value)) {
      return mattermostError("Two user IDs are required", 400);
    }
    const channelId = mattermostId(`dm:${userIds.map(String).sort().join(":")}`);
    const channel = { display_name: "", id: channelId, name: channelId, type: "D" };
    state.channels.set(channelId, channel);
    return jsonResponse(channel, 201);
  }
  if (!isJsonObject(body)) {
    return mattermostError("Request body must be a JSON object", 400);
  }
  if (method === "POST" && apiPath === "/users/me/typing") {
    const channelId = readTrimmedString(body.channel_id);
    if (!channelId) {
      return mattermostError("channel_id is required", 400);
    }
    if (
      !broadcast(state, {
        broadcast: eventBroadcast({
          channelId,
          omitUsers: { [state.botUserId]: true },
        }),
        data: {
          channel_id: channelId,
          ...(readTrimmedString(body.parent_id)
            ? { parent_id: readTrimmedString(body.parent_id) }
            : {}),
          user_id: state.botUserId,
        },
        event: "typing",
      })
    ) {
      return pendingQueueFullResponse(state);
    }
    return jsonResponse({});
  }
  if (method === "POST" && apiPath === "/posts") {
    const channelId = readTrimmedString(body.channel_id);
    const message = readTrimmedString(body.message);
    if (!channelId || !message) {
      return mattermostError("channel_id and message are required", 400);
    }
    const post = createPost({
      channelId,
      message,
      rootId: readTrimmedString(body.root_id),
      state,
      userId: state.botUserId,
    });
    const channelType = state.channels.get(channelId)?.type ?? "O";
    if (!broadcast(state, postEvent("posted", post, state.botUsername, channelType))) {
      state.posts.delete(post.id);
      return pendingQueueFullResponse(state);
    }
    return jsonResponse(post, 201);
  }
  const postMatch = /^\/posts\/([^/]+)$/u.exec(apiPath);
  if (postMatch?.[1] && method === "PUT") {
    const post = state.posts.get(postMatch[1]);
    if (!post) {
      return mattermostError("Post not found", 404);
    }
    const updated = { ...post, message: readTrimmedString(body.message) ?? post.message };
    state.posts.set(updated.id, updated);
    if (
      !broadcast(
        state,
        postEvent(
          "post_edited",
          updated,
          state.botUsername,
          state.channels.get(updated.channel_id)?.type ?? "O",
        ),
      )
    ) {
      state.posts.set(post.id, post);
      return pendingQueueFullResponse(state);
    }
    return jsonResponse(updated);
  }
  if (postMatch?.[1] && method === "DELETE") {
    const post = state.posts.get(postMatch[1]);
    if (!post) {
      return mattermostError("Post not found", 404);
    }
    state.posts.delete(post.id);
    if (
      !broadcast(
        state,
        postEvent(
          "post_deleted",
          post,
          state.botUsername,
          state.channels.get(post.channel_id)?.type ?? "O",
        ),
      )
    ) {
      state.posts.set(post.id, post);
      return pendingQueueFullResponse(state);
    }
    return new Response(null, { status: 204 });
  }
  return mattermostError("Not found", 404);
}

async function handleRequest(request: IncomingMessage, state: MattermostServerState) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  if (url.pathname === "/crabline/mattermost/inbound" && method === "POST") {
    if (!hasAdminToken(request, state.adminToken)) {
      drainRequestBody(request);
      return adminAuthError();
    }
    const body = await parseUnknownRequestBody(request);
    if (!isJsonObject(body)) {
      return jsonResponse({ error: "Request body must be a JSON object", ok: false }, 400);
    }
    await appendEvent(state, {
      at: new Date().toISOString(),
      body,
      method,
      path: url.pathname,
      query: queryRecord(url),
      type: "admin",
    });
    return await handleAdminInbound({ body, state });
  }
  if (!url.pathname.startsWith("/api/v4/")) {
    return new Response("not found", { status: 404 });
  }
  if (!authorized(request, state.botToken)) {
    drainRequestBody(request);
    return mattermostError("Invalid or missing token", 401);
  }
  const body =
    method === "GET" || method === "DELETE" ? {} : await parseUnknownRequestBody(request);
  await appendEvent(state, {
    at: new Date().toISOString(),
    ...(typeof body === "object" && body !== null && Object.keys(body).length > 0 ? { body } : {}),
    method,
    path: url.pathname,
    query: queryRecord(url),
    type: "api",
  });
  return await handleApi({ body, method, path: url.pathname.slice("/api/v4".length), state });
}

function attachWebSocketServer(params: {
  authenticationTimeoutMs: number;
  state: MattermostServerState;
  server: import("node:http").Server;
}) {
  const websocketServer = new WebSocketServer({ noServer: true });
  const onUpgrade = (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api/v4/websocket") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit("connection", client, request);
    });
  };
  params.server.on("upgrade", onUpgrade);
  websocketServer.on("connection", (client) => {
    let authenticationOpen = true;
    const authenticationTimeout = setTimeout(() => {
      authenticationOpen = false;
      client.close(4001, "authentication timeout");
    }, params.authenticationTimeoutMs);
    authenticationTimeout.unref();
    client.on("message", (raw: RawData) => {
      let message: {
        action?: string;
        data?: { channel_id?: string; parent_id?: string; token?: string };
        seq?: number;
      };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        client.close(1003, "invalid json");
        return;
      }
      const seq = message.seq ?? 0;
      if (!params.state.websocketClients.has(client)) {
        if (!authenticationOpen || client.readyState !== WebSocket.OPEN) {
          return;
        }
        if (
          message.action !== "authentication_challenge" ||
          message.data?.token !== params.state.botToken
        ) {
          client.send(
            JSON.stringify({
              error: { id: "api.context.unauthorized", message: "Authentication failed" },
              seq_reply: seq,
              status: "FAIL",
            }),
          );
          authenticationOpen = false;
          client.close(4001, "authentication failed");
          return;
        }
        clearTimeout(authenticationTimeout);
        authenticationOpen = false;
        params.state.websocketClients.set(client, 0);
        client.send(JSON.stringify({ seq_reply: seq, status: "OK" }));
        sendEvent(params.state, client, {
          broadcast: eventBroadcast({ userId: params.state.botUserId }),
          data: {
            connection_id: mattermostId(`connection-${Date.now()}-${Math.random()}`),
            server_version: "crabline-mattermost.1",
          },
          event: "hello",
        });
        const pending = params.state.pendingEvents.splice(0);
        for (const [index, event] of pending.entries()) {
          if (!sendEvent(params.state, client, event)) {
            params.state.pendingEvents.unshift(...pending.slice(index));
            break;
          }
        }
        return;
      }
      if (message.action === "user_typing" && message.data?.channel_id) {
        broadcast(params.state, {
          broadcast: eventBroadcast({
            channelId: message.data.channel_id,
            omitUsers: { [params.state.botUserId]: true },
          }),
          data: {
            parent_id: message.data.parent_id ?? "",
            user_id: params.state.botUserId,
          },
          event: "typing",
        });
        client.send(JSON.stringify({ seq_reply: seq, status: "OK" }));
        return;
      }
      if (message.action === "ping") {
        client.send(JSON.stringify({ data: { text: "pong" }, seq_reply: seq, status: "OK" }));
        return;
      }
      client.send(
        JSON.stringify({
          error: { id: "api.websocket.invalid_action", message: "Unsupported action" },
          seq_reply: seq,
          status: "FAIL",
        }),
      );
    });
    client.once("close", () => {
      authenticationOpen = false;
      clearTimeout(authenticationTimeout);
      params.state.websocketClients.delete(client);
    });
  });
  return async () => {
    params.server.off("upgrade", onUpgrade);
    await closeWebSocketServer(websocketServer);
  };
}

export async function startMattermostServer(
  params: StartMattermostServerParams = {},
): Promise<StartedMattermostServer> {
  const host = params.host ?? "127.0.0.1";
  const botUserId = params.botUserId ?? mattermostId("crabline-mattermost-bot");
  const botUsername = params.botUsername ?? "crabline_bot";
  const state: MattermostServerState = {
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    botToken:
      params.botToken ??
      (isLoopbackHost(host) ? "crabline-mattermost-token" : randomBytes(13).toString("hex")),
    botUserId,
    botUsername,
    channels: new Map(),
    maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
    maxWebSocketBufferedBytes: resolveMaxWebSocketBufferedBytes(params.maxWebSocketBufferedBytes),
    nextPost: 1,
    onEvent: params.onEvent,
    pendingEvents: [],
    posts: new Map(),
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "mattermost.jsonl"),
    users: new Map([[botUserId, { id: botUserId, update_at: Date.now(), username: botUsername }]]),
    websocketClients: new Map(),
  };
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest(request, state),
    handleError: (error) => {
      if (error instanceof InvalidJsonBodyError) {
        return mattermostError("Request body is not valid JSON", 400);
      }
      if (error instanceof RequestBodyTooLargeError) {
        return mattermostError("Request body is too large", 413);
      }
      return undefined;
    },
    host,
    port: params.port ?? 0,
    serverName: "Mattermost",
  });
  const closeMattermostWebSocketServer = attachWebSocketServer({
    authenticationTimeoutMs:
      params.websocketAuthenticationTimeoutMs ?? DEFAULT_WEBSOCKET_AUTHENTICATION_TIMEOUT_MS,
    server: httpServer.server,
    state,
  });
  return {
    async close() {
      await closeMattermostWebSocketServer();
      await httpServer.close();
    },
    manifest: {
      adminToken: state.adminToken,
      baseUrl: httpServer.baseUrl,
      botToken: state.botToken,
      botUserId,
      endpoints: {
        adminInboundUrl: `${httpServer.baseUrl}/crabline/mattermost/inbound`,
        apiRoot: `${httpServer.baseUrl}/api/v4`,
        websocketUrl: `${httpServer.baseUrl.replace(/^http/u, "ws")}/api/v4/websocket`,
      },
      env: {
        MATTERMOST_BOT_TOKEN: state.botToken,
        MATTERMOST_URL: httpServer.baseUrl,
      },
      provider: "mattermost",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
