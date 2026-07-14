import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  isHistoricalMatrixUserId,
  isMatrixEventId,
  isMatrixRoomId,
  isMatrixUserId,
} from "../matrix-ids.js";
import {
  adminAuthError,
  constantTimeTokenEqual,
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
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
import {
  recordCommittedServerEvent,
  recordServerEvent,
  type ServerEventObserver,
} from "./recorder.js";

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
  ephemeral: Array<{
    event: { content: Record<string, unknown>; type: "m.receipt" | "m.typing" };
    sequence: number;
  }>;
  id: string;
  lastDroppedTimelineSequence: number | undefined;
  name: string;
  state: MatrixEvent[];
  stateBeforeTimeline: Map<string, MatrixEvent>;
  timeline: Array<{ sequence: number; event: MatrixEvent }>;
  typingTimeouts: Map<string, NodeJS.Timeout>;
  typingUsers: Set<string>;
  users: Map<string, { avatar_url?: string; display_name?: string }>;
};

type MatrixTransactionResponse = {
  body: Record<string, unknown>;
  expiresAt: number;
  status: number;
};

type MatrixServerState = {
  accessToken: string;
  adminToken: string;
  botUserId: string;
  deviceId: string;
  directRooms: Map<string, Set<string>>;
  directRoomsSequence: number | undefined;
  filterBytes: number;
  filters: Map<string, { body: Record<string, unknown>; bytes: number }>;
  maxCommittedRooms: number;
  maxCommittedUsers: number;
  maxSyncResponseBytes: number;
  nextEvent: number;
  nextFilter: number;
  nextSequence: number;
  onEvent: ServerEventObserver | undefined;
  profiles: Map<string, { avatar_url?: string; display_name?: string }>;
  recorderPath: string;
  rooms: Map<string, MatrixRoom>;
  serverName: string;
  syncWaiters: Set<() => void>;
  transactions: Map<string, MatrixTransactionResponse>;
};

type MatrixRecorderEvent = ServerRequestEvent & {
  accepted?: boolean | undefined;
};

const MAX_MATRIX_FILTER_BYTES = 1024 * 1024;
const MAX_MATRIX_FILTERS = 100;
const MAX_MATRIX_TIMELINE_EVENTS = 1_000;
const MAX_MATRIX_TRANSACTION_RESPONSES = 1_000;
const MATRIX_TRANSACTION_RETENTION_MS = 10 * 60_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_MATRIX_COMMITTED_ROOMS = 1_000;
const DEFAULT_MAX_MATRIX_COMMITTED_USERS = 1_000;
const DEFAULT_MAX_MATRIX_SYNC_RESPONSE_BYTES = 4 * 1024 * 1024;

class InvalidMatrixPathEncodingError extends Error {
  constructor() {
    super("Matrix request path contains invalid percent encoding.");
    this.name = "InvalidMatrixPathEncodingError";
  }
}

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
  maxCommittedRooms?: number | undefined;
  maxCommittedUsers?: number | undefined;
  maxSyncResponseBytes?: number | undefined;
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

async function appendEvent(
  state: MatrixServerState,
  event: ServerRequestEvent,
  committed = false,
): Promise<void> {
  const params = { event, onEvent: state.onEvent, recorderPath: state.recorderPath };
  await (committed ? recordCommittedServerEvent(params) : recordServerEvent(params));
}

function authorized(request: IncomingMessage, token: string): boolean {
  const match = /^Bearer\s+(\S+)$/iu.exec(request.headers.authorization ?? "");
  const providedToken = match?.[1];
  return providedToken ? constantTimeTokenEqual(providedToken, token) : false;
}

function matrixError(errcode: string, error: string, status: number): Response {
  return jsonResponse({ errcode, error }, status);
}

function matrixResourceLimitError(error: string): Response {
  return jsonResponse(
    {
      admin_contact: "mailto:admin@localhost",
      errcode: "M_RESOURCE_LIMIT_EXCEEDED",
      error,
    },
    503,
  );
}

function resolvePositiveLimit(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function decodeMatrixPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidMatrixPathEncodingError();
  }
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
    ephemeral: [],
    id: params.id,
    lastDroppedTimelineSequence: undefined,
    name: params.name,
    state: [],
    stateBeforeTimeline: new Map(),
    timeline: [],
    typingTimeouts: new Map(),
    typingUsers: new Set(),
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
  for (const event of room.state) {
    room.stateBeforeTimeline.set(matrixStateKey(event), event);
  }
  return room;
}

function matrixStateKey(event: MatrixEvent): string {
  return JSON.stringify([event.type, event.state_key ?? ""]);
}

function appendTimelineEvent(
  room: MatrixRoom,
  entry: { event: MatrixEvent; sequence: number },
): void {
  room.timeline.push(entry);
  if (room.timeline.length > MAX_MATRIX_TIMELINE_EVENTS) {
    const dropped = room.timeline.splice(0, room.timeline.length - MAX_MATRIX_TIMELINE_EVENTS);
    room.lastDroppedTimelineSequence = dropped.at(-1)?.sequence;
    for (const droppedEntry of dropped) {
      if (droppedEntry.event.state_key !== undefined) {
        room.stateBeforeTimeline.set(matrixStateKey(droppedEntry.event), droppedEntry.event);
      }
    }
  }
}

function appendEphemeralEvent(
  room: MatrixRoom,
  entry: {
    event: { content: Record<string, unknown>; type: "m.receipt" | "m.typing" };
    sequence: number;
  },
): void {
  room.ephemeral.push(entry);
  if (room.ephemeral.length > MAX_MATRIX_TIMELINE_EVENTS) {
    room.ephemeral.splice(0, room.ephemeral.length - MAX_MATRIX_TIMELINE_EVENTS);
  }
}

function publishTypingState(state: MatrixServerState, room: MatrixRoom): void {
  appendEphemeralEvent(room, {
    event: { content: { user_ids: [...room.typingUsers] }, type: "m.typing" },
    sequence: state.nextSequence++,
  });
  notifySyncWaiters(state);
}

function publishDirectRoom(state: MatrixServerState, userId: string, roomId: string): void {
  const roomIds = state.directRooms.get(userId) ?? new Set<string>();
  if (roomIds.has(roomId)) {
    return;
  }
  roomIds.add(roomId);
  state.directRooms.set(userId, roomIds);
  state.directRoomsSequence = state.nextSequence++;
}

function serializeSyncAccountData(
  state: MatrixServerState,
  since: number | undefined,
  maxBytes: number,
): string | undefined {
  const sequence = state.directRoomsSequence;
  if (sequence === undefined || (since !== undefined && sequence <= since)) {
    return '{"events":[]}';
  }
  const prefix = '{"events":[{"content":{';
  const suffix = '},"type":"m.direct"}]}';
  const parts: string[] = [];
  let bytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  for (const [userId, roomIds] of state.directRooms) {
    const roomParts: string[] = [];
    let roomBytes = 2;
    for (const roomId of roomIds) {
      const separator = roomParts.length === 0 ? "" : ",";
      const roomPart = `${separator}${JSON.stringify(roomId)}`;
      roomBytes += Buffer.byteLength(roomPart, "utf8");
      if (bytes + roomBytes > maxBytes) {
        return undefined;
      }
      roomParts.push(roomPart);
    }
    const separator = parts.length === 0 ? "" : ",";
    const part = `${separator}${JSON.stringify(userId)}:[${roomParts.join("")}]`;
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > maxBytes) {
      return undefined;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join("")}${suffix}`;
}

function rememberTransaction(
  state: MatrixServerState,
  key: string,
  response: MatrixTransactionResponse,
): void {
  state.transactions.set(key, response);
}

function forgetExpiredTransactions(state: MatrixServerState): void {
  const now = Date.now();
  for (const [key, response] of state.transactions) {
    if (response.expiresAt > now) {
      break;
    }
    state.transactions.delete(key);
  }
}

function transactionResponse(
  state: MatrixServerState,
  key: string,
): MatrixTransactionResponse | undefined {
  forgetExpiredTransactions(state);
  const response = state.transactions.get(key);
  if (!response) {
    return undefined;
  }
  state.transactions.delete(key);
  response.expiresAt = Date.now() + MATRIX_TRANSACTION_RETENTION_MS;
  state.transactions.set(key, response);
  return response;
}

function readTimelineLimit(filter: Record<string, unknown> | undefined): number | undefined {
  const room = filter?.room;
  const timeline = isJsonObject(room) ? room.timeline : undefined;
  const limit = isJsonObject(timeline) ? readInteger(timeline.limit) : undefined;
  return limit === undefined ? undefined : Math.max(0, limit);
}

function resolveSyncFilter(
  url: URL,
  state: MatrixServerState,
): Record<string, unknown> | Response | undefined {
  const value = url.searchParams.get("filter");
  if (value === null) {
    return undefined;
  }
  const stored = state.filters.get(value);
  if (stored) {
    return stored.body;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonObject(parsed) ? parsed : matrixError("M_INVALID_PARAM", "Invalid filter", 400);
  } catch {
    return matrixError("M_INVALID_PARAM", "Unknown filter", 400);
  }
}

function createSyncRoom(
  room: MatrixRoom,
  since: number | undefined,
  available: Array<{ sequence: number; event: MatrixEvent }>,
  timeline: Array<{ sequence: number; event: MatrixEvent }>,
) {
  const firstSequence = timeline[0]?.sequence;
  const historyWasTrimmed =
    room.lastDroppedTimelineSequence !== undefined &&
    (since === undefined || since < room.lastDroppedTimelineSequence);
  const limited = historyWasTrimmed || timeline.length < available.length;
  const omittedTimeline = available.slice(0, available.length - timeline.length);
  const omittedState = new Map<string, MatrixEvent>();
  if (since === undefined || room.createdSequence > since || historyWasTrimmed) {
    for (const [key, event] of room.stateBeforeTimeline) {
      omittedState.set(key, event);
    }
  }
  for (const entry of omittedTimeline) {
    if (entry.event.state_key !== undefined) {
      omittedState.set(matrixStateKey(entry.event), entry.event);
    }
  }
  return {
    account_data: { events: [] },
    ephemeral: {
      events: room.ephemeral
        .filter((entry) => since === undefined || entry.sequence > since)
        .map((entry) => entry.event),
    },
    state: {
      events: [...omittedState.values()].filter(
        (event) => !timeline.some((entry) => entry.event.event_id === event.event_id),
      ),
    },
    timeline: {
      events: timeline.map((entry) => entry.event),
      limited,
      prev_batch: `s${firstSequence === undefined ? (since ?? 0) : firstSequence - 1}`,
    },
    unread_notifications: { highlight_count: 0, notification_count: 0 },
  };
}

function jsonItemsByteLength(items: readonly unknown[], maxBytes: number): number | undefined {
  let bytes = 0;
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > maxBytes) {
      return undefined;
    }
  }
  return bytes;
}

function boundedSyncRoom(
  room: MatrixRoom,
  since: number | undefined,
  timelineLimit: number | undefined,
  maxBytes: number,
): string | undefined {
  const available = room.timeline.filter((entry) => since === undefined || entry.sequence > since);
  const requestedTimeline =
    timelineLimit === undefined
      ? available
      : available.slice(Math.max(0, available.length - timelineLimit));
  const ephemeral = room.ephemeral
    .filter((entry) => since === undefined || entry.sequence > since)
    .map((entry) => entry.event);
  const ephemeralBytes = jsonItemsByteLength(ephemeral, maxBytes);
  if (ephemeralBytes === undefined) {
    return undefined;
  }

  const timeline: Array<{ sequence: number; event: MatrixEvent }> = [];
  let timelineBytes = 0;
  for (let index = requestedTimeline.length - 1; index >= 0; index -= 1) {
    const entry = requestedTimeline[index]!;
    const eventBytes = Buffer.byteLength(JSON.stringify(entry.event), "utf8");
    if (timelineBytes + ephemeralBytes + eventBytes > maxBytes) {
      break;
    }
    timeline.unshift(entry);
    timelineBytes += eventBytes;
  }
  if (requestedTimeline.length > 0 && timelineLimit !== 0 && timeline.length === 0) {
    return undefined;
  }

  while (true) {
    const body = createSyncRoom(room, since, available, timeline);
    const stateBytes = jsonItemsByteLength(body.state.events, maxBytes);
    if (stateBytes !== undefined && stateBytes + ephemeralBytes + timelineBytes <= maxBytes) {
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
        return serialized;
      }
    }
    const dropped = timeline.shift();
    if (!dropped) {
      return undefined;
    }
    timelineBytes -= Buffer.byteLength(JSON.stringify(dropped.event), "utf8");
  }
}

function roomHasSyncUpdates(room: MatrixRoom, since: number | undefined): boolean {
  return (
    since === undefined ||
    room.createdSequence > since ||
    room.timeline.some((entry) => entry.sequence > since) ||
    room.ephemeral.some((entry) => entry.sequence > since)
  );
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
  const filter = resolveSyncFilter(url, state);
  if (filter instanceof Response) {
    return filter;
  }
  const timelineLimit = readTimelineLimit(filter);
  const timeout = Math.min(readInteger(url.searchParams.get("timeout")) ?? 0, 1_000);
  const hasNewEvents =
    (state.directRoomsSequence !== undefined &&
      (since === undefined || state.directRoomsSequence > since)) ||
    [...state.rooms.values()].some((room) => roomHasSyncUpdates(room, since));
  if (since !== undefined && !hasNewEvents && timeout > 0) {
    await waitForSyncEvent(state, timeout);
  }
  const accountData = serializeSyncAccountData(state, since, state.maxSyncResponseBytes);
  if (!accountData) {
    return matrixResourceLimitError("Sync response exceeds the configured byte limit");
  }
  const prefix = `{"account_data":${accountData},"device_lists":{"changed":[],"left":[]},"device_one_time_keys_count":{},"next_batch":${JSON.stringify(
    `s${state.nextSequence - 1}`,
  )},"presence":{"events":[]},"rooms":{"invite":{},"join":{`;
  const suffix = '},"knock":{},"leave":{}},"to_device":{"events":[]}}';
  const parts: string[] = [];
  let responseBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  for (const room of state.rooms.values()) {
    if (!roomHasSyncUpdates(room, since)) {
      continue;
    }
    const separator = parts.length === 0 ? "" : ",";
    const roomKey = JSON.stringify(room.id);
    const framingBytes = Buffer.byteLength(`${separator}${roomKey}:`, "utf8");
    const roomBody = boundedSyncRoom(
      room,
      since,
      timelineLimit,
      state.maxSyncResponseBytes - responseBytes - framingBytes,
    );
    if (!roomBody) {
      return matrixResourceLimitError("Sync response exceeds the configured byte limit");
    }
    parts.push(`${separator}${roomKey}:${roomBody}`);
    responseBytes += framingBytes + Buffer.byteLength(roomBody, "utf8");
  }
  const body = `${prefix}${parts.join("")}${suffix}`;
  if (Buffer.byteLength(body, "utf8") > state.maxSyncResponseBytes) {
    return matrixResourceLimitError("Sync response exceeds the configured byte limit");
  }
  return new Response(body, {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function findRoom(state: MatrixServerState, encodedRoomId: string): MatrixRoom | undefined {
  return state.rooms.get(decodeMatrixPathSegment(encodedRoomId));
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: MatrixServerState;
}): Promise<Response> {
  const roomId = readTrimmedString(params.body.roomId);
  const sender = readTrimmedString(params.body.sender ?? params.body.senderId);
  const text = typeof params.body.text === "string" ? params.body.text : undefined;
  if (!roomId || !sender || text === undefined || text.length === 0) {
    return jsonResponse({ error: "roomId, senderId, and text are required", ok: false }, 400);
  }
  const threadId = readTrimmedString(params.body.threadId);
  if (
    !isMatrixRoomId(roomId) ||
    !isHistoricalMatrixUserId(sender) ||
    (threadId !== undefined && !isMatrixEventId(threadId))
  ) {
    return jsonResponse({ error: "Invalid Matrix identifier", ok: false }, 400);
  }
  const direct = params.body.direct === true;
  const existingRoom = params.state.rooms.get(roomId);
  if (!existingRoom && params.state.rooms.size >= params.state.maxCommittedRooms) {
    return jsonResponse({ error: "Committed Matrix rooms limit reached", ok: false }, 503);
  }
  if (
    !params.state.profiles.has(sender) &&
    params.state.profiles.size >= params.state.maxCommittedUsers
  ) {
    return jsonResponse({ error: "Committed Matrix users limit reached", ok: false }, 503);
  }
  const roomHasSender = existingRoom
    ? existingRoom.users.has(sender)
    : sender === params.state.botUserId;
  const roomUserCount = existingRoom?.users.size ?? 1;
  if (!roomHasSender && roomUserCount >= params.state.maxCommittedUsers) {
    return jsonResponse({ error: "Committed Matrix users limit reached", ok: false }, 503);
  }
  const room =
    existingRoom ??
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
  if (direct) {
    publishDirectRoom(params.state, sender, roomId);
  }
  const senderName = readTrimmedString(params.body.senderName);
  if (senderName) {
    params.state.profiles.set(sender, {
      ...params.state.profiles.get(sender),
      display_name: senderName,
    });
  } else if (!params.state.profiles.has(sender)) {
    params.state.profiles.set(sender, {});
  }
  const existingProfile = room.users.get(sender);
  if (existingProfile === undefined) {
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
    appendTimelineEvent(room, { event: membership, sequence: params.state.nextSequence++ });
  } else if (senderName && existingProfile.display_name !== senderName) {
    room.users.set(sender, { ...existingProfile, display_name: senderName });
    const membership = createEvent({
      content: { membership: "join", displayname: senderName },
      roomId,
      sender,
      state: params.state,
      stateKey: sender,
      type: "m.room.member",
    });
    const stateIndex = room.state.findIndex(
      (event) => event.type === "m.room.member" && event.state_key === sender,
    );
    if (stateIndex >= 0) {
      room.state[stateIndex] = membership;
    } else {
      room.state.push(membership);
    }
    appendTimelineEvent(room, {
      event: membership,
      sequence: params.state.nextSequence++,
    });
  }
  const roomAvatarUrl = room.users.get(sender)?.avatar_url;
  if (roomAvatarUrl) {
    params.state.profiles.set(sender, {
      ...params.state.profiles.get(sender),
      avatar_url: roomAvatarUrl,
    });
  }
  const content: Record<string, unknown> = { body: text, msgtype: "m.text" };
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
  appendTimelineEvent(room, { event, sequence: params.state.nextSequence++ });
  notifySyncWaiters(params.state);
  return jsonResponse({ event, ok: true });
}

async function handleMatrixApi(params: {
  body: Record<string, unknown>;
  method: string;
  path: string;
  recorderEvent: MatrixRecorderEvent;
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
    const userId = decodeMatrixPathSegment(match[1]!);
    const profile = params.state.profiles.get(userId);
    return profile
      ? jsonResponse({
          ...(profile.avatar_url ? { avatar_url: profile.avatar_url } : {}),
          ...(profile.display_name ? { displayname: profile.display_name } : {}),
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
    const userId = decodeMatrixPathSegment(match[1]!);
    if (userId !== params.state.botUserId) {
      return matrixError("M_FORBIDDEN", "Cannot create a filter for another user", 403);
    }
    const bytes = Buffer.byteLength(JSON.stringify(params.body), "utf8");
    if (
      params.state.filters.size >= MAX_MATRIX_FILTERS ||
      params.state.filterBytes + bytes > MAX_MATRIX_FILTER_BYTES
    ) {
      return matrixResourceLimitError("Too many stored filters");
    }
    const filterId = String(params.state.nextFilter++);
    params.state.filters.set(filterId, { body: params.body, bytes });
    params.state.filterBytes += bytes;
    return jsonResponse({ filter_id: filterId });
  }

  match = /^\/user\/([^/]+)\/filter\/([^/]+)$/u.exec(relativePath);
  if (params.method === "GET" && match) {
    const userId = decodeMatrixPathSegment(match[1]!);
    if (userId !== params.state.botUserId) {
      return matrixError("M_FORBIDDEN", "Cannot get filters for another user", 403);
    }
    const filter = params.state.filters.get(decodeMatrixPathSegment(match[2]!));
    return filter ? jsonResponse(filter.body) : matrixError("M_NOT_FOUND", "Unknown filter", 404);
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
    const eventType = decodeMatrixPathSegment(match[2]!);
    const stateKey = decodeMatrixPathSegment(match[3] ?? "");
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
    const roomId = decodeMatrixPathSegment(match[1]!);
    const eventType = decodeMatrixPathSegment(match[2]!);
    const transactionId = decodeMatrixPathSegment(match[3]!);
    const transactionKey = JSON.stringify([
      params.state.botUserId,
      roomId,
      eventType,
      transactionId,
    ]);
    const existingResponse = transactionResponse(params.state, transactionKey);
    if (existingResponse) {
      params.recorderEvent.accepted =
        existingResponse.status >= 200 && existingResponse.status < 300;
      return jsonResponse(existingResponse.body, existingResponse.status);
    }
    if (params.state.transactions.size >= MAX_MATRIX_TRANSACTION_RESPONSES) {
      params.recorderEvent.accepted = false;
      return matrixResourceLimitError("Too many retained transaction responses");
    }
    const room = params.state.rooms.get(roomId);
    if (!room) {
      params.recorderEvent.accepted = false;
      const body = { errcode: "M_NOT_FOUND", error: "Unknown room" };
      rememberTransaction(params.state, transactionKey, {
        body,
        expiresAt: Date.now() + MATRIX_TRANSACTION_RETENTION_MS,
        status: 404,
      });
      return jsonResponse(body, 404);
    }
    const event = createEvent({
      content: params.body,
      roomId: room.id,
      sender: params.state.botUserId,
      state: params.state,
      transactionId,
      type: eventType,
    });
    appendTimelineEvent(room, { event, sequence: params.state.nextSequence++ });
    const body = { event_id: event.event_id };
    rememberTransaction(params.state, transactionKey, {
      body,
      expiresAt: Date.now() + MATRIX_TRANSACTION_RETENTION_MS,
      status: 200,
    });
    notifySyncWaiters(params.state);
    params.recorderEvent.accepted = true;
    return jsonResponse(body);
  }

  match = /^\/rooms\/([^/]+)\/typing\/([^/]+)$/u.exec(relativePath);
  if (params.method === "PUT" && match) {
    const room = findRoom(params.state, match[1]!);
    if (!room) {
      return matrixError("M_NOT_FOUND", "Unknown room", 404);
    }
    const userId = decodeMatrixPathSegment(match[2]!);
    if (userId !== params.state.botUserId) {
      return matrixError("M_FORBIDDEN", "Cannot set typing state for another user", 403);
    }
    if (typeof params.body.typing !== "boolean") {
      return matrixError("M_BAD_JSON", "typing must be a boolean", 400);
    }
    const timeout =
      params.body.typing &&
      typeof params.body.timeout === "number" &&
      Number.isSafeInteger(params.body.timeout)
        ? params.body.timeout
        : undefined;
    if (
      params.body.typing &&
      (timeout === undefined || timeout < 1 || timeout > MAX_NODE_TIMER_DELAY_MS)
    ) {
      return matrixError(
        "M_BAD_JSON",
        `timeout must be a positive integer no greater than ${MAX_NODE_TIMER_DELAY_MS}`,
        400,
      );
    }
    const existingTimeout = room.typingTimeouts.get(userId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      room.typingTimeouts.delete(userId);
    }
    if (params.body.typing) {
      room.typingUsers.add(userId);
      const timer = setTimeout(() => {
        room.typingTimeouts.delete(userId);
        if (room.typingUsers.delete(userId)) {
          publishTypingState(params.state, room);
        }
      }, timeout!);
      timer.unref();
      room.typingTimeouts.set(userId, timer);
    } else {
      room.typingUsers.delete(userId);
    }
    publishTypingState(params.state, room);
    return jsonResponse({});
  }
  match = /^\/rooms\/([^/]+)\/receipt\/m\.read\/([^/]+)$/u.exec(relativePath);
  if (params.method === "POST" && match) {
    const room = findRoom(params.state, match[1]!);
    if (!room) {
      return matrixError("M_NOT_FOUND", "Unknown room", 404);
    }
    const receiptEventId = decodeMatrixPathSegment(match[2]!);
    appendEphemeralEvent(room, {
      event: {
        content: {
          [receiptEventId]: {
            "m.read": {
              [params.state.botUserId]: {
                ts: Date.now(),
                ...(readTrimmedString(params.body.thread_id)
                  ? { thread_id: readTrimmedString(params.body.thread_id) }
                  : {}),
              },
            },
          },
        },
        type: "m.receipt",
      },
      sequence: params.state.nextSequence++,
    });
    notifySyncWaiters(params.state);
    return jsonResponse({});
  }

  return matrixError("M_UNRECOGNIZED", "Unrecognized request", 404);
}

export async function startMatrixServer(
  params: StartMatrixServerParams = {},
): Promise<StartedMatrixServer> {
  const host = params.host ?? "127.0.0.1";
  const serverName = params.serverName ?? "matrix.test";
  const botUserId = params.botUserId ?? `@openclaw:${serverName}`;
  if (!isMatrixUserId(botUserId)) {
    throw new Error("botUserId must be a canonical Matrix user ID.");
  }
  const state: MatrixServerState = {
    accessToken: params.accessToken ?? `syt_crabline_${randomBytes(12).toString("hex")}`,
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    botUserId,
    deviceId: params.deviceId ?? "CRABLINE",
    directRooms: new Map(),
    directRoomsSequence: undefined,
    filterBytes: 0,
    filters: new Map(),
    maxCommittedRooms: resolvePositiveLimit(
      params.maxCommittedRooms,
      "maxCommittedRooms",
      DEFAULT_MAX_MATRIX_COMMITTED_ROOMS,
    ),
    maxCommittedUsers: resolvePositiveLimit(
      params.maxCommittedUsers,
      "maxCommittedUsers",
      DEFAULT_MAX_MATRIX_COMMITTED_USERS,
    ),
    maxSyncResponseBytes: resolvePositiveLimit(
      params.maxSyncResponseBytes,
      "maxSyncResponseBytes",
      DEFAULT_MAX_MATRIX_SYNC_RESPONSE_BYTES,
    ),
    nextEvent: 1,
    nextFilter: 1,
    nextSequence: 1,
    onEvent: params.onEvent,
    profiles: new Map([[botUserId, { display_name: "OpenClaw QA" }]]),
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
      if (error instanceof InvalidMatrixPathEncodingError) {
        return matrixError("M_INVALID_PARAM", "Invalid request path encoding", 400);
      }
      return matrixError("M_UNKNOWN", "Internal server error", 500);
    },
    host,
    maxResponseBodyBytes: Math.max(DEFAULT_MAX_RESPONSE_BODY_BYTES, state.maxSyncResponseBytes),
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
      const event: MatrixRecorderEvent = {
        at: new Date().toISOString(),
        ...(Object.keys(parsedBody).length > 0 ? { body: parsedBody } : {}),
        method,
        path: url.pathname,
        query: queryRecord(url),
        type,
      };
      const response = await handleMatrixApi({
        body: parsedBody,
        method,
        path: url.pathname,
        recorderEvent: event,
        state,
        url,
      });
      event.accepted ??= response.ok;
      await appendEvent(state, event, response.ok && ["DELETE", "POST", "PUT"].includes(method));
      return response;
    },
  });

  const clientApiRoot = `${server.baseUrl}/_matrix/client/v3`;
  return {
    async close() {
      for (const room of state.rooms.values()) {
        for (const timer of room.typingTimeouts.values()) {
          clearTimeout(timer);
        }
        room.typingTimeouts.clear();
      }
      await server.close();
    },
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
