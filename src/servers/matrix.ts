import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  adminAuthError,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  jsonResponse,
  parseUnknownRequestBody,
  queryRecord,
  readInteger,
  readTrimmedString,
  RequestBodyTooLargeError,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";

type MatrixEvent = {
  content: Record<string, unknown>;
  event_id: string;
  origin_server_ts: number;
  room_id: string;
  sender: string;
  state_key?: string;
  type: string;
  unsigned?: { transaction_id: string };
};

type MatrixRoom = {
  createdSequence: number;
  id: string;
  name: string;
  state: MatrixEvent[];
  timeline: Array<{ sequence: number; event: MatrixEvent }>;
  users: Map<string, { avatar_url?: string; display_name?: string }>;
};

type MatrixTransactionResponse = {
  body: Record<string, unknown>;
  status: number;
};

type MatrixServerState = {
  accessToken: string;
  adminToken: string;
  botUserId: string;
  deviceId: string;
  filters: Map<string, Record<string, unknown>>;
  nextEvent: number;
  nextFilter: number;
  nextSequence: number;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
  rooms: Map<string, MatrixRoom>;
  serverName: string;
  syncWaiters: Set<() => void>;
  transactions: Map<string, MatrixTransactionResponse>;
};

export type MatrixServerManifest = {
  accessToken: string;
  adminToken: string;
  baseUrl: string;
  botUserId: string;
  deviceId: string;
  endpoints: {
    adminInboundUrl: string;
    clientApiRoot: string;
    syncUrl: string;
  };
  env: {
    MATRIX_ACCESS_TOKEN: string;
    MATRIX_BASE_URL: string;
    MATRIX_USER_ID: string;
  };
  provider: "matrix";
  recorderPath: string;
  version: 1;
};

export type StartedMatrixServer = {
  close(): Promise<void>;
  manifest: MatrixServerManifest;
};

export type StartMatrixServerParams = {
  accessToken?: string | undefined;
  adminToken?: string | undefined;
  botUserId?: string | undefined;
  deviceId?: string | undefined;
  host?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  roomId?: string | undefined;
  roomName?: string | undefined;
  serverName?: string | undefined;
};

function matrixId(prefix: "$" | "!", value: string, serverName: string): string {
  return `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 16)}:${serverName}`;
}

async function appendEvent(state: MatrixServerState, event: ServerRequestEvent): Promise<void> {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function authorized(request: IncomingMessage, token: string): boolean {
  const [scheme, value] = request.headers.authorization?.trim().split(/\s+/, 2) ?? [];
  return scheme?.toLowerCase() === "bearer" && value === token;
}

function matrixError(errcode: string, error: string, status: number): Response {
  return jsonResponse({ errcode, error }, status);
}

function eventId(state: MatrixServerState): string {
  return matrixId("$", `event-${state.nextEvent++}`, state.serverName);
}

function notifySyncWaiters(state: MatrixServerState): void {
  for (const resolve of state.syncWaiters) {
    resolve();
  }
  state.syncWaiters.clear();
}

async function waitForSyncEvent(state: MatrixServerState, timeout: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state.syncWaiters.delete(onEvent);
      resolve();
    }, timeout);
    const onEvent = () => {
      clearTimeout(timer);
      resolve();
    };
    state.syncWaiters.add(onEvent);
  });
}

function createEvent(params: {
  content: Record<string, unknown>;
  roomId: string;
  sender: string;
  state: MatrixServerState;
  stateKey?: string;
  transactionId?: string;
  type: string;
}): MatrixEvent {
  return {
    content: params.content,
    event_id: eventId(params.state),
    origin_server_ts: Date.now(),
    room_id: params.roomId,
    sender: params.sender,
    ...(params.stateKey !== undefined ? { state_key: params.stateKey } : {}),
    type: params.type,
    ...(params.transactionId ? { unsigned: { transaction_id: params.transactionId } } : {}),
  };
}

function createRoom(params: {
  botUserId: string;
  createdSequence: number;
  direct?: boolean;
  id: string;
  name: string;
  serverName: string;
  state: MatrixServerState;
}): MatrixRoom {
  const room: MatrixRoom = {
    createdSequence: params.createdSequence,
    id: params.id,
    name: params.name,
    state: [],
    timeline: [],
    users: new Map([[params.botUserId, { display_name: "OpenClaw QA" }]]),
  };
  room.state.push(
    createEvent({
      content: { creator: params.botUserId, room_version: "10" },
      roomId: room.id,
      sender: params.botUserId,
      state: params.state,
      stateKey: "",
      type: "m.room.create",
    }),
    createEvent({
      content: {
        membership: "join",
        displayname: "OpenClaw QA",
        ...(params.direct ? { is_direct: true } : {}),
      },
      roomId: room.id,
      sender: params.botUserId,
      state: params.state,
      stateKey: params.botUserId,
      type: "m.room.member",
    }),
    createEvent({
      content: { name: room.name },
      roomId: room.id,
      sender: params.botUserId,
      state: params.state,
      stateKey: "",
      type: "m.room.name",
    }),
  );
  return room;
}

function syncRoom(room: MatrixRoom, since: number | undefined) {
  const events = room.timeline
    .filter((entry) => since === undefined || entry.sequence > since)
    .map((entry) => entry.event);
  return {
    account_data: { events: [] },
    ephemeral: { events: [] },
    state: { events: since === undefined || room.createdSequence > since ? room.state : [] },
    timeline: { events, limited: false, prev_batch: `s${since ?? 0}` },
    unread_notifications: { highlight_count: 0, notification_count: 0 },
  };
}

function parseSyncToken(value: string | null): number | null | undefined {
  if (value === null) {
    return undefined;
  }
  const match = /^s(\d+)$/u.exec(value);
  if (!match) {
    return null;
  }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

async function handleSync(url: URL, state: MatrixServerState): Promise<Response> {
  const since = parseSyncToken(url.searchParams.get("since"));
  if (since === null || (since !== undefined && since > state.nextSequence - 1)) {
    return matrixError("M_UNKNOWN_POS", "Unknown position", 400);
  }
  const timeout = Math.min(readInteger(url.searchParams.get("timeout")) ?? 0, 1_000);
  const hasNewEvents = [...state.rooms.values()].some((room) =>
    room.timeline.some((entry) => since === undefined || entry.sequence > since),
  );
  if (since !== undefined && !hasNewEvents && timeout > 0) {
    await waitForSyncEvent(state, timeout);
  }
  const join = Object.fromEntries(
    [...state.rooms.values()].map((room) => [room.id, syncRoom(room, since)]),
  );
  return jsonResponse({
    account_data: { events: [] },
    device_lists: { changed: [], left: [] },
    device_one_time_keys_count: {},
    next_batch: `s${state.nextSequence - 1}`,
    presence: { events: [] },
    rooms: { invite: {}, join, knock: {}, leave: {} },
    to_device: { events: [] },
  });
}

function findRoom(state: MatrixServerState, encodedRoomId: string): MatrixRoom | undefined {
  return state.rooms.get(decodeURIComponent(encodedRoomId));
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: MatrixServerState;
}): Promise<Response> {
  const roomId = readTrimmedString(params.body.roomId);
  const sender = readTrimmedString(params.body.sender ?? params.body.senderId);
  const text = readTrimmedString(params.body.text);
  if (!roomId || !sender || !text) {
    return jsonResponse({ error: "roomId, senderId, and text are required", ok: false }, 400);
  }
  const direct = params.body.direct === true;
  const room =
    params.state.rooms.get(roomId) ??
    createRoom({
      botUserId: params.state.botUserId,
      createdSequence: params.state.nextSequence++,
      direct,
      id: roomId,
      name: readTrimmedString(params.body.roomName) ?? roomId,
      serverName: params.state.serverName,
      state: params.state,
    });
  params.state.rooms.set(roomId, room);
  const senderName = readTrimmedString(params.body.senderName);
  if (!room.users.has(sender)) {
    room.users.set(sender, senderName ? { display_name: senderName } : {});
    const membership = createEvent({
      content: {
        membership: "join",
        ...(senderName ? { displayname: senderName } : {}),
      },
      roomId,
      sender,
      state: params.state,
      stateKey: sender,
      type: "m.room.member",
    });
    room.state.push(membership);
    room.timeline.push({ event: membership, sequence: params.state.nextSequence++ });
  } else if (senderName) {
    room.users.set(sender, { display_name: senderName });
  }
  const content: Record<string, unknown> = { body: text, msgtype: "m.text" };
  const threadId = readTrimmedString(params.body.threadId);
  if (threadId) {
    content["m.relates_to"] = {
      event_id: threadId,
      is_falling_back: true,
      rel_type: "m.thread",
      "m.in_reply_to": { event_id: threadId },
    };
  }
  const event = createEvent({
    content,
    roomId,
    sender,
    state: params.state,
    type: "m.room.message",
  });
  room.timeline.push({ event, sequence: params.state.nextSequence++ });
  notifySyncWaiters(params.state);
  return jsonResponse({ event, ok: true });
}

async function handleMatrixApi(params: {
  body: Record<string, unknown>;
  method: string;
  path: string;
  state: MatrixServerState;
  url: URL;
}): Promise<Response> {
  const relativePath = params.path.replace(/^\/_matrix\/client\/(?:v3|r0)/u, "");
  if (params.method === "GET" && relativePath === "/account/whoami") {
    return jsonResponse({
      device_id: params.state.deviceId,
      is_guest: false,
      user_id: params.state.botUserId,
    });
  }
  if (params.method === "GET" && relativePath === "/joined_rooms") {
    return jsonResponse({ joined_rooms: [...params.state.rooms.keys()] });
  }
  if (params.method === "GET" && relativePath === "/capabilities") {
    return jsonResponse({ capabilities: {} });
  }
  let match = /^\/profile\/([^/]+)$/u.exec(relativePath);
  if (params.method === "GET" && match) {
    const userId = decodeURIComponent(match[1]!);
    const member = [...params.state.rooms.values()]
      .map((room) => room.users.get(userId))
      .find((profile) => profile !== undefined);
    return member
      ? jsonResponse({
          ...(member.avatar_url ? { avatar_url: member.avatar_url } : {}),
          ...(member.display_name ? { displayname: member.display_name } : {}),
        })
      : matrixError("M_NOT_FOUND", "Unknown user", 404);
  }
  if (params.method === "GET" && relativePath === "/pushrules/") {
    const empty = { content: [], override: [], room: [], sender: [], underride: [] };
    return jsonResponse({ global: empty });
  }
  if (params.method === "GET" && relativePath === "/sync") {
    return await handleSync(params.url, params.state);
  }

  match = /^\/user\/([^/]+)\/filter$/u.exec(relativePath);
  if (params.method === "POST" && match) {
    const userId = decodeURIComponent(match[1]!);
    if (userId !== params.state.botUserId) {
      return matrixError("M_FORBIDDEN", "Cannot create a filter for another user", 403);
    }
    const filterId = String(params.state.nextFilter++);
    params.state.filters.set(filterId, params.body);
    return jsonResponse({ filter_id: filterId });
  }

  match = /^\/user\/([^/]+)\/filter\/([^/]+)$/u.exec(relativePath);
  if (params.method === "GET" && match) {
    const userId = decodeURIComponent(match[1]!);
    if (userId !== params.state.botUserId) {
      return matrixError("M_FORBIDDEN", "Cannot get filters for another user", 403);
    }
    const filter = params.state.filters.get(decodeURIComponent(match[2]!));
    return filter ? jsonResponse(filter) : matrixError("M_NOT_FOUND", "Unknown filter", 404);
  }

  match = /^\/rooms\/([^/]+)\/joined_members$/u.exec(relativePath);
  if (params.method === "GET" && match) {
    const room = findRoom(params.state, match[1]!);
    return room
      ? jsonResponse({ joined: Object.fromEntries(room.users) })
      : matrixError("M_NOT_FOUND", "Unknown room", 404);
  }

  match = /^\/rooms\/([^/]+)\/state\/([^/]+)(?:\/(.*))?$/u.exec(relativePath);
  if (params.method === "GET" && match) {
    const room = findRoom(params.state, match[1]!);
    if (!room) {
      return matrixError("M_NOT_FOUND", "Unknown room", 404);
    }
    const eventType = decodeURIComponent(match[2]!);
    const stateKey = decodeURIComponent(match[3] ?? "");
    if (eventType === "m.room.name" && stateKey === "") {
      return jsonResponse({ name: room.name });
    }
    if (eventType === "m.room.canonical_alias" && stateKey === "") {
      return matrixError("M_NOT_FOUND", "Unknown state event", 404);
    }
    if (eventType === "m.room.member") {
      const membership = [...room.state]
        .reverse()
        .find((event) => event.type === "m.room.member" && event.state_key === stateKey);
      return membership
        ? jsonResponse(membership.content)
        : matrixError("M_NOT_FOUND", "Unknown room member", 404);
    }
    return matrixError("M_NOT_FOUND", "Unknown state event", 404);
  }

  match = /^\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/u.exec(relativePath);
  if (params.method === "PUT" && match) {
    const transactionKey = relativePath;
    const existingResponse = params.state.transactions.get(transactionKey);
    if (existingResponse) {
      return jsonResponse(existingResponse.body, existingResponse.status);
    }
    const room = findRoom(params.state, match[1]!);
    if (!room) {
      const body = { errcode: "M_NOT_FOUND", error: "Unknown room" };
      params.state.transactions.set(transactionKey, { body, status: 404 });
      return jsonResponse(body, 404);
    }
    const event = createEvent({
      content: params.body,
      roomId: room.id,
      sender: params.state.botUserId,
      state: params.state,
      transactionId: decodeURIComponent(match[3]!),
      type: decodeURIComponent(match[2]!),
    });
    room.timeline.push({ event, sequence: params.state.nextSequence++ });
    const body = { event_id: event.event_id };
    params.state.transactions.set(transactionKey, { body, status: 200 });
    notifySyncWaiters(params.state);
    return jsonResponse(body);
  }

  match = /^\/rooms\/([^/]+)\/typing\/([^/]+)$/u.exec(relativePath);
  if (params.method === "PUT" && match) {
    return jsonResponse({});
  }
  match = /^\/rooms\/([^/]+)\/receipt\/m\.read\/([^/]+)$/u.exec(relativePath);
  if (params.method === "POST" && match) {
    return jsonResponse({});
  }

  return matrixError("M_UNRECOGNIZED", "Unrecognized request", 404);
}

export async function startMatrixServer(
  params: StartMatrixServerParams = {},
): Promise<StartedMatrixServer> {
  const host = params.host ?? "127.0.0.1";
  const serverName = params.serverName ?? "matrix.test";
  const state: MatrixServerState = {
    accessToken: params.accessToken ?? `syt_crabline_${randomBytes(12).toString("hex")}`,
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    botUserId: params.botUserId ?? `@openclaw:${serverName}`,
    deviceId: params.deviceId ?? "CRABLINE",
    filters: new Map(),
    nextEvent: 1,
    nextFilter: 1,
    nextSequence: 1,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath ?? path.resolve("artifacts/crabline/matrix.jsonl"),
    rooms: new Map(),
    serverName,
    syncWaiters: new Set(),
    transactions: new Map(),
  };
  const roomId = params.roomId ?? matrixId("!", "default-room", serverName);
  state.rooms.set(
    roomId,
    createRoom({
      botUserId: state.botUserId,
      createdSequence: 0,
      id: roomId,
      name: params.roomName ?? "Crabline Matrix Room",
      serverName,
      state,
    }),
  );

  const server = await startHttpJsonServer({
    handleError: (error) => {
      if (error instanceof InvalidJsonBodyError) {
        return matrixError("M_NOT_JSON", "Request body is not valid JSON", 400);
      }
      if (error instanceof RequestBodyTooLargeError) {
        return matrixError("M_TOO_LARGE", "Request body is too large", 413);
      }
      return matrixError("M_UNKNOWN", "Internal server error", 500);
    },
    host,
    port: params.port ?? 0,
    serverName: "Matrix",
    async handle(request) {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const type = url.pathname === "/crabline/matrix/inbound" ? "admin" : "api";
      if (type === "admin") {
        if (method !== "POST") {
          return jsonResponse({ error: "Method not allowed", ok: false }, 405);
        }
        if (!hasAdminToken(request, state.adminToken)) {
          request.resume();
          return adminAuthError();
        }
        const body = await parseUnknownRequestBody(request);
        if (!isJsonObject(body)) {
          return jsonResponse({ error: "Request body must be a JSON object", ok: false }, 400);
        }
        await appendEvent(state, {
          at: new Date().toISOString(),
          ...(Object.keys(body).length > 0 ? { body } : {}),
          method,
          path: url.pathname,
          query: queryRecord(url),
          type,
        });
        return await handleAdminInbound({ body, state });
      }
      if (url.pathname === "/_matrix/client/versions" && method === "GET") {
        await appendEvent(state, {
          at: new Date().toISOString(),
          method,
          path: url.pathname,
          query: queryRecord(url),
          type,
        });
        return jsonResponse({ unstable_features: {}, versions: ["v1.11"] });
      }
      if (!url.pathname.startsWith("/_matrix/client/")) {
        return matrixError("M_UNRECOGNIZED", "Unrecognized request", 404);
      }
      if (!authorized(request, state.accessToken)) {
        request.resume();
        return matrixError("M_UNKNOWN_TOKEN", "Invalid access token", 401);
      }
      const parsedBody = ["POST", "PUT"].includes(method)
        ? await parseUnknownRequestBody(request)
        : {};
      if (!isJsonObject(parsedBody)) {
        return matrixError("M_BAD_JSON", "Request body must be a JSON object", 400);
      }
      await appendEvent(state, {
        at: new Date().toISOString(),
        ...(Object.keys(parsedBody).length > 0 ? { body: parsedBody } : {}),
        method,
        path: url.pathname,
        query: queryRecord(url),
        type,
      });
      return await handleMatrixApi({ body: parsedBody, method, path: url.pathname, state, url });
    },
  });

  const clientApiRoot = `${server.baseUrl}/_matrix/client/v3`;
  return {
    close: server.close,
    manifest: {
      accessToken: state.accessToken,
      adminToken: state.adminToken,
      baseUrl: server.baseUrl,
      botUserId: state.botUserId,
      deviceId: state.deviceId,
      endpoints: {
        adminInboundUrl: `${server.baseUrl}/crabline/matrix/inbound`,
        clientApiRoot,
        syncUrl: `${clientApiRoot}/sync`,
      },
      env: {
        MATRIX_ACCESS_TOKEN: state.accessToken,
        MATRIX_BASE_URL: server.baseUrl,
        MATRIX_USER_ID: state.botUserId,
      },
      provider: "matrix",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
