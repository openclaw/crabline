import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import {
  adminAuthError,
  closeServer,
  drainRequestBody,
  formatUrlHost,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  jsonResponse,
  parseUnknownRequestBody,
  queryRecord,
  readInteger,
  readTrimmedString,
  RequestBodyTooLargeError,
  type ServerRequestEvent,
  writeResponse,
} from "./http.js";
import {
  recordCommittedServerEvent,
  recordServerEvent,
  ServerRecorderCommittedError,
  type ServerEventObserver,
} from "./recorder.js";
import { resolveMaxPendingInboundEvents } from "./pending-events.js";

type SignalServerState = {
  account: string;
  adminToken: string;
  clients: Set<ServerResponse>;
  clientBuffers: Map<ServerResponse, SignalClientBuffer>;
  maxPendingInboundEvents: number;
  maxSseClients: number;
  nextEventSequence: number;
  nextTimestamp: number;
  onEvent: ServerEventObserver | undefined;
  pendingEventBytes: number;
  pendingEvents: SignalSseChunk[];
  pendingRpcRequests: Promise<void>;
  pendingSseClients: number;
  recorderPath: string;
};

type SignalClientBuffer = {
  bytes: number;
  draining: boolean;
  events: SignalSseChunk[];
  inFlight: SignalSseChunk[];
};
type SignalSseChunk = {
  data: string;
  recipients?: Set<ServerResponse> | undefined;
  sequence?: number | undefined;
};
const SIGNAL_CLI_SSE_KEEPALIVE_MS = 15_000;
const DEFAULT_MAX_SIGNAL_SSE_CLIENTS = 32;
const MAX_SIGNAL_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const SIGNAL_PHONE_NUMBER_RE = /^\+[1-9]\d{2,14}$/u;
const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type SignalSseWriteResult = "accepted" | "queued" | "rejected";
type SignalRpcResult =
  | {
      accepted: true;
      record: true;
      response: Response;
      timestamp: number;
    }
  | {
      accepted: false;
      record: boolean;
      response: Response;
    };
type SignalRecorderEvent = ServerRequestEvent & {
  accepted?: boolean | undefined;
};

export type SignalServerManifest = {
  account: string;
  adminToken: string;
  baseUrl: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    eventsUrl: string;
    rpcUrl: string;
  };
  env: Record<string, never>;
  provider: "signal";
  recorderPath: string;
  version: 1;
};

export type StartedSignalServer = {
  close(): Promise<void>;
  manifest: SignalServerManifest;
};

export type StartSignalServerParams = {
  account?: string | undefined;
  adminToken?: string | undefined;
  allowedHosts?: string[] | undefined;
  host?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  maxPendingInboundEvents?: number | undefined;
  maxSseClients?: number | undefined;
};

async function appendEvent(
  state: SignalServerState,
  event: ServerRequestEvent,
  committed = false,
): Promise<void> {
  const params = { event, onEvent: state.onEvent, recorderPath: state.recorderPath };
  await (committed ? recordCommittedServerEvent(params) : recordServerEvent(params));
}

function rpcResponse(id: unknown, result: unknown): Response {
  return jsonResponse({ id: id ?? null, jsonrpc: "2.0", result });
}

function rpcError(code: number, message: string, id: unknown = null, status = 400): Response {
  return jsonResponse(
    {
      error: { code, message },
      id: id ?? null,
      jsonrpc: "2.0",
    },
    status,
  );
}

function removeSignalClient(
  state: SignalServerState,
  client: ServerResponse,
  destroy: boolean,
): void {
  const buffer = state.clientBuffers.get(client);
  state.clients.delete(client);
  state.clientBuffers.delete(client);
  if (buffer) {
    const undeliveredEvents = [...buffer.inFlight, ...buffer.events].filter((event) => {
      event.recipients?.delete(client);
      return event.sequence !== undefined && event.recipients?.size === 0;
    });
    const restoredEvents = undeliveredEvents.filter(
      (event) => !state.pendingEvents.includes(event),
    );
    if (restoredEvents.length > 0) {
      state.pendingEvents.push(...restoredEvents);
      state.pendingEvents.sort(
        (left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? 0),
      );
      state.pendingEventBytes += restoredEvents.reduce(
        (total, event) => total + Buffer.byteLength(event.data),
        0,
      );
    }
  }
  if (destroy) {
    client.destroy();
  }
  if (state.pendingEvents.length > 0 && state.clients.size > 0) {
    queueMicrotask(() => flushPendingSignalEvents(state));
  }
}

function evictSignalClient(state: SignalServerState, client: ServerResponse): void {
  removeSignalClient(state, client, true);
}

function scheduleSignalDrain(state: SignalServerState, client: ServerResponse): void {
  const buffer = state.clientBuffers.get(client);
  if (!buffer || buffer.draining || client.destroyed || client.writableEnded) {
    return;
  }
  buffer.draining = true;
  client.once("drain", () => {
    const current = state.clientBuffers.get(client);
    if (current) {
      current.bytes -= current.inFlight.reduce(
        (total, event) => total + Buffer.byteLength(event.data),
        0,
      );
      current.inFlight.length = 0;
      current.draining = false;
      flushSignalClientEvents(state, client);
      const remaining = state.clientBuffers.get(client);
      if (remaining && remaining.events.length === 0 && !client.writableNeedDrain) {
        flushPendingSignalEvents(state);
      }
    }
  });
}

function queueSignalClientEvent(
  state: SignalServerState,
  client: ServerResponse,
  event: SignalSseChunk,
): SignalSseWriteResult {
  const buffer = state.clientBuffers.get(client);
  const eventBytes = Buffer.byteLength(event.data);
  const alreadyBuffered = isSignalEventBuffered(state, event);
  const pendingEventBytes = state.pendingEvents.includes(event) ? 0 : eventBytes;
  if (
    !buffer ||
    (!alreadyBuffered && signalBufferedEventCount(state) >= state.maxPendingInboundEvents) ||
    state.pendingEventBytes + buffer.bytes + pendingEventBytes > MAX_SIGNAL_SSE_BUFFER_BYTES
  ) {
    evictSignalClient(state, client);
    return "rejected";
  }
  buffer.events.push(event);
  buffer.bytes += eventBytes;
  event.recipients?.add(client);
  scheduleSignalDrain(state, client);
  return "queued";
}

function writeSignalSse(
  state: SignalServerState,
  client: ServerResponse,
  event: SignalSseChunk,
): SignalSseWriteResult {
  if (client.destroyed) {
    removeSignalClient(state, client, false);
    return "rejected";
  }
  if (client.writableEnded) {
    evictSignalClient(state, client);
    return "rejected";
  }
  const eventBytes = Buffer.byteLength(event.data);
  if (eventBytes > MAX_SIGNAL_SSE_BUFFER_BYTES) {
    return "rejected";
  }
  const buffer = state.clientBuffers.get(client);
  if (client.writableNeedDrain || buffer?.draining || buffer?.events.length) {
    return queueSignalClientEvent(state, client, event);
  }
  if (client.writableLength + eventBytes > MAX_SIGNAL_SSE_BUFFER_BYTES) {
    evictSignalClient(state, client);
    return "rejected";
  }
  const accepted = client.write(event.data);
  event.recipients?.add(client);
  if (!accepted) {
    if (buffer) {
      buffer.inFlight.push(event);
      buffer.bytes += eventBytes;
    }
    scheduleSignalDrain(state, client);
  }
  return "accepted";
}

function maxSignalClientBufferBytes(state: SignalServerState): number {
  let maxBytes = 0;
  for (const buffer of state.clientBuffers.values()) {
    maxBytes = Math.max(maxBytes, buffer.bytes);
  }
  return maxBytes;
}

function isSignalEventBuffered(state: SignalServerState, event: SignalSseChunk): boolean {
  return (
    state.pendingEvents.includes(event) ||
    [...state.clientBuffers.values()].some(
      (buffer) => buffer.inFlight.includes(event) || buffer.events.includes(event),
    )
  );
}

function signalBufferedEventCount(state: SignalServerState): number {
  const sequences = new Set<number>();
  for (const event of state.pendingEvents) {
    if (event.sequence !== undefined) {
      sequences.add(event.sequence);
    }
  }
  for (const buffer of state.clientBuffers.values()) {
    for (const event of [...buffer.inFlight, ...buffer.events]) {
      if (event.sequence !== undefined) {
        sequences.add(event.sequence);
      }
    }
  }
  return sequences.size;
}

function queueSignalEvent(state: SignalServerState, event: SignalSseChunk): boolean {
  const eventBytes = Buffer.byteLength(event.data);
  if (
    eventBytes > MAX_SIGNAL_SSE_BUFFER_BYTES ||
    state.pendingEventBytes + maxSignalClientBufferBytes(state) + eventBytes >
      MAX_SIGNAL_SSE_BUFFER_BYTES ||
    (!isSignalEventBuffered(state, event) &&
      signalBufferedEventCount(state) >= state.maxPendingInboundEvents)
  ) {
    return false;
  }
  state.pendingEvents.push(event);
  state.pendingEventBytes += eventBytes;
  return true;
}

function replayExclusiveSignalEvents(state: SignalServerState, client: ServerResponse): void {
  const events = new Map<number, SignalSseChunk>();
  for (const [owner, buffer] of state.clientBuffers) {
    if (owner === client) {
      continue;
    }
    for (const event of [...buffer.inFlight, ...buffer.events]) {
      if (
        event.sequence !== undefined &&
        event.recipients?.size === 1 &&
        event.recipients.has(owner)
      ) {
        events.set(event.sequence, event);
      }
    }
  }
  for (const event of [...events.values()].sort(
    (left, right) => left.sequence! - right.sequence!,
  )) {
    if (writeSignalSse(state, client, event) === "rejected") {
      break;
    }
  }
}

function flushSignalClientEvents(state: SignalServerState, client: ServerResponse): void {
  while (!client.writableNeedDrain) {
    const buffer = state.clientBuffers.get(client);
    if (!buffer || buffer.events.length === 0) {
      break;
    }
    const event = buffer.events.shift()!;
    if (!client.write(event.data)) {
      buffer.inFlight.push(event);
      scheduleSignalDrain(state, client);
      break;
    }
    buffer.bytes -= Buffer.byteLength(event.data);
  }
}

function flushPendingSignalEvents(state: SignalServerState): void {
  while (state.pendingEvents.length > 0 && state.clients.size > 0) {
    const event = state.pendingEvents[0]!;
    for (const client of [...state.clients]) {
      if (!event.recipients?.has(client)) {
        writeSignalSse(state, client, event);
      }
    }
    if (
      state.clients.size === 0 ||
      [...state.clients].some((client) => !event.recipients?.has(client))
    ) {
      break;
    }
    state.pendingEvents.shift();
    state.pendingEventBytes -= Buffer.byteLength(event.data);
  }
}

function emitSignalEvent(state: SignalServerState, payload: unknown): boolean {
  const event: SignalSseChunk = {
    data: `event:receive\ndata:${JSON.stringify(payload)}\n\n`,
    recipients: new Set(),
    sequence: state.nextEventSequence++,
  };
  if (state.clients.size === 0 || state.pendingEvents.length > 0) {
    return queueSignalEvent(state, event);
  }
  let delivered = false;
  for (const client of state.clients) {
    const result = writeSignalSse(state, client, event);
    delivered = result === "accepted" || result === "queued" || delivered;
  }
  return delivered || queueSignalEvent(state, event);
}

function normalizeSignalPhoneNumber(value: unknown): string | undefined {
  const number = readTrimmedString(value)?.replace(/[\s().-]/gu, "");
  return number && SIGNAL_PHONE_NUMBER_RE.test(number) ? number : undefined;
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: SignalServerState;
}): Promise<Response> {
  const text = typeof params.body.text === "string" ? params.body.text : undefined;
  const sourceNumberValue = params.body.sourceNumber ?? params.body.senderId;
  const sourceNumber = normalizeSignalPhoneNumber(sourceNumberValue);
  const sourceUuidValue = readTrimmedString(params.body.sourceUuid);
  const sourceUuid =
    sourceUuidValue && SIGNAL_UUID_RE.test(sourceUuidValue)
      ? sourceUuidValue.toLowerCase()
      : undefined;
  if (sourceNumberValue !== undefined && sourceNumber === undefined) {
    return jsonResponse(
      { error: "sourceNumber must be an E.164 telephone number", ok: false },
      400,
    );
  }
  if (params.body.sourceUuid !== undefined && sourceUuid === undefined) {
    return jsonResponse({ error: "sourceUuid must be a UUID", ok: false }, 400);
  }
  if (!text || text.trim().length === 0 || (!sourceNumber && !sourceUuid)) {
    return jsonResponse(
      { error: "text and at least one source identity are required", ok: false },
      400,
    );
  }
  const suppliedTimestamp =
    params.body.timestamp === undefined ? undefined : readInteger(params.body.timestamp);
  if (
    params.body.timestamp !== undefined &&
    (suppliedTimestamp === undefined ||
      suppliedTimestamp < 0 ||
      suppliedTimestamp >= Number.MAX_SAFE_INTEGER)
  ) {
    return jsonResponse(
      { error: "timestamp must be a non-negative safe integer with room to advance", ok: false },
      400,
    );
  }
  const timestamp = suppliedTimestamp ?? params.state.nextTimestamp;
  if (timestamp >= Number.MAX_SAFE_INTEGER) {
    return jsonResponse({ error: "timestamp capacity exhausted", ok: false }, 503);
  }
  params.state.nextTimestamp = Math.max(params.state.nextTimestamp, timestamp + 1);
  const groupId = readTrimmedString(params.body.groupId);
  const payload = {
    envelope: {
      sourceName: readTrimmedString(params.body.sourceName ?? params.body.senderName),
      ...(sourceNumber ? { sourceNumber } : {}),
      ...(sourceUuid ? { sourceUuid } : {}),
      timestamp,
      dataMessage: {
        message: text,
        timestamp,
        ...(groupId ? { groupInfo: { groupId } } : {}),
      },
    },
  };
  if (!emitSignalEvent(params.state, payload)) {
    return jsonResponse(
      {
        error: `Pending inbound queue is full (${params.state.maxPendingInboundEvents} events)`,
        ok: false,
      },
      503,
    );
  }
  return jsonResponse({ event: payload, ok: true });
}

async function handleRpc(params: {
  body: Record<string, unknown>;
  state: SignalServerState;
}): Promise<SignalRpcResult> {
  const hasId = Object.hasOwn(params.body, "id");
  const id = params.body.id;
  const validId =
    !hasId ||
    id === null ||
    typeof id === "string" ||
    (typeof id === "number" && Number.isFinite(id));
  const method = params.body.method;
  if (typeof method !== "string" || !validId) {
    return {
      accepted: false,
      record: false,
      response: rpcError(-32600, "Invalid Request", validId ? id : null),
    };
  }
  if (params.body.jsonrpc !== "2.0") {
    return {
      accepted: false,
      record: false,
      response: rpcError(-32600, "Invalid Request", id),
    };
  }
  const notification = !hasId;
  if (
    params.body.params !== undefined &&
    !Array.isArray(params.body.params) &&
    !isJsonObject(params.body.params)
  ) {
    return {
      accepted: false,
      record: false,
      response: rpcError(-32600, "Invalid Request", id),
    };
  }
  if (method === "version") {
    return {
      accepted: false,
      record: true,
      response: notification
        ? new Response(null, { status: 204 })
        : rpcResponse(id, { version: "crabline-signal-1" }),
    };
  }
  if (["send", "sendReaction", "sendReceipt", "sendTyping"].includes(method)) {
    if (!validSignalRpcParams(method, params.body.params)) {
      return {
        accepted: false,
        record: false,
        response: notification
          ? new Response(null, { status: 204 })
          : rpcError(-32602, "Invalid params", id),
      };
    }
    const timestamp = params.state.nextTimestamp;
    if (timestamp >= Number.MAX_SAFE_INTEGER) {
      return {
        accepted: false,
        record: false,
        response: notification
          ? new Response(null, { status: 204 })
          : rpcError(-32603, "Timestamp capacity exhausted", id),
      };
    }
    return {
      accepted: true,
      record: true,
      response: notification
        ? new Response(null, { status: 204 })
        : rpcResponse(id, method === "sendTyping" ? {} : { timestamp }),
      timestamp,
    };
  }
  return {
    accepted: false,
    record: false,
    response: notification
      ? new Response(null, { status: 204 })
      : jsonResponse({
          error: { code: -32601, message: `Method not found: ${method}` },
          id: id ?? null,
          jsonrpc: "2.0",
        }),
  };
}

function hasRecipients(params: Record<string, unknown>): boolean {
  const values = [
    params.recipient,
    params.recipients,
    params.groupId,
    params.groupIds,
    params.username,
    params.usernames,
  ];
  return (
    params.noteToSelf === true ||
    values.some(
      (value) =>
        (typeof value === "string" && value.trim().length > 0) ||
        (Array.isArray(value) &&
          value.length > 0 &&
          value.every((entry) => typeof entry === "string" && entry.trim().length > 0)),
    )
  );
}

function hasTypingRecipients(params: Record<string, unknown>): boolean {
  if (
    params.noteToSelf !== undefined ||
    params.username !== undefined ||
    params.usernames !== undefined ||
    (params.stop !== undefined && typeof params.stop !== "boolean")
  ) {
    return false;
  }
  return [params.recipient, params.recipients, params.groupId, params.groupIds].some(
    (value) =>
      (typeof value === "string" && value.trim().length > 0) ||
      (Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => typeof entry === "string" && entry.trim().length > 0)),
  );
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function validSignalRpcParams(method: string, value: unknown): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  if (method === "send") {
    return (
      hasRecipients(value) &&
      (readTrimmedString(value.message) !== undefined ||
        readTrimmedString(value.attachment) !== undefined ||
        hasStringArray(value.attachments))
    );
  }
  if (method === "sendReaction") {
    return (
      hasRecipients(value) &&
      readTrimmedString(value.emoji) !== undefined &&
      readTrimmedString(value.targetAuthor) !== undefined &&
      validTimestamp(value.targetTimestamp)
    );
  }
  if (method === "sendReceipt") {
    const targetTimestamps = value.targetTimestamps ?? value.targetTimestamp;
    const timestamps = Array.isArray(targetTimestamps) ? targetTimestamps : [targetTimestamps];
    return (
      (readTrimmedString(value.recipient) !== undefined ||
        readTrimmedString(value.username) !== undefined ||
        hasStringArray(value.usernames)) &&
      timestamps.length > 0 &&
      timestamps.every(validTimestamp) &&
      (value.type === undefined || value.type === "read" || value.type === "viewed")
    );
  }
  return method === "sendTyping" && hasTypingRecipients(value);
}

async function processSignalRpc(params: {
  body: Record<string, unknown>;
  state: SignalServerState;
  url: URL;
}): Promise<Response> {
  const run = params.state.pendingRpcRequests
    .catch(() => {})
    .then(async () => {
      const rpc = await handleRpc({ body: params.body, state: params.state });
      if (rpc.record) {
        const event: SignalRecorderEvent = {
          accepted: rpc.accepted,
          at: new Date().toISOString(),
          body: params.body,
          method: "POST",
          path: params.url.pathname,
          query: queryRecord(params.url),
          type: "api",
        };
        if (rpc.accepted) {
          try {
            await appendEvent(params.state, event);
          } catch (error) {
            if (!(error instanceof ServerRecorderCommittedError)) {
              throw error;
            }
          }
          params.state.nextTimestamp = Math.max(params.state.nextTimestamp, rpc.timestamp + 1);
        } else {
          await appendEvent(params.state, event, rpc.response.status === 204);
        }
      }
      return rpc.response;
    });
  params.state.pendingRpcRequests = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hasSignalJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  const values = Array.isArray(contentType) ? contentType : [contentType];
  return values.some(
    (value) => value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json",
  );
}

async function handleRequest(params: {
  request: IncomingMessage;
  response: ServerResponse;
  state: SignalServerState;
}): Promise<void> {
  const url = new URL(params.request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/v1/events" && params.request.method === "GET") {
    if (params.state.clients.size + params.state.pendingSseClients >= params.state.maxSseClients) {
      await writeResponse(
        params.response,
        jsonResponse({ error: "Too many event stream clients", ok: false }, 503),
      );
      return;
    }
    params.state.pendingSseClients += 1;
    try {
      await appendEvent(params.state, {
        at: new Date().toISOString(),
        method: "GET",
        path: url.pathname,
        query: queryRecord(url),
        type: "api",
      });
    } finally {
      params.state.pendingSseClients -= 1;
    }
    if (params.request.destroyed || params.response.destroyed) {
      return;
    }
    params.response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    params.response.flushHeaders();
    params.response.once("close", () => {
      removeSignalClient(params.state, params.response, false);
    });
    params.state.clients.add(params.response);
    params.state.clientBuffers.set(params.response, {
      bytes: 0,
      draining: false,
      events: [],
      inFlight: [],
    });
    replayExclusiveSignalEvents(params.state, params.response);
    if (params.state.clients.has(params.response)) {
      flushPendingSignalEvents(params.state);
    }
    return;
  }

  let fetchResponse: Response;
  if (url.pathname === "/crabline/signal/inbound" && params.request.method === "POST") {
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      drainRequestBody(params.request);
      fetchResponse = adminAuthError();
    } else {
      const body = await parseUnknownRequestBody(params.request);
      if (!isJsonObject(body)) {
        fetchResponse = jsonResponse(
          { error: "Request body must be a JSON object", ok: false },
          400,
        );
        await writeResponse(params.response, fetchResponse);
        return;
      }
      await appendEvent(params.state, {
        at: new Date().toISOString(),
        body,
        method: "POST",
        path: url.pathname,
        query: queryRecord(url),
        type: "admin",
      });
      fetchResponse = await handleAdminInbound({ body, state: params.state });
    }
  } else if (url.pathname === "/api/v1/check" && params.request.method === "GET") {
    await appendEvent(params.state, {
      at: new Date().toISOString(),
      method: "GET",
      path: url.pathname,
      query: queryRecord(url),
      type: "api",
    });
    fetchResponse = new Response(null, { status: 200 });
  } else if (url.pathname === "/api/v1/rpc" && params.request.method === "POST") {
    if (!hasSignalJsonContentType(params.request)) {
      drainRequestBody(params.request);
      fetchResponse = new Response(null, { status: 415 });
    } else {
      const body = await parseUnknownRequestBody(params.request);
      if (!isJsonObject(body)) {
        await writeResponse(params.response, rpcError(-32600, "Invalid Request"));
        return;
      }
      fetchResponse = await processSignalRpc({ body, state: params.state, url });
    }
  } else {
    fetchResponse = new Response("not found", { status: 404 });
  }
  await writeResponse(params.response, fetchResponse);
}

function normalizeSignalHost(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\[(.*)\]$/u, "$1")
    .toLowerCase()
    .replace(/\.$/u, "");
  if (isIP(normalized) !== 6) {
    return normalized;
  }
  const canonical = new URL(`http://[${normalized}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (!mapped?.[1] || !mapped[2]) {
    return canonical;
  }
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function parseSignalHostHeader(value: string): string | undefined {
  const match = value.startsWith("[")
    ? /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value)
    : /^([^:]+)(?::(\d{1,5}))?$/u.exec(value);
  if (!match?.[1]) {
    return undefined;
  }
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && port > 65_535) {
    return undefined;
  }
  const hostname = normalizeSignalHost(match[1]);
  if (isIP(hostname) !== 0) {
    return hostname;
  }
  const labels = hostname.split(".");
  return hostname.length <= 253 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    ? hostname
    : undefined;
}

function signalRequestHostAllowed(
  request: IncomingMessage,
  bindHost: string,
  allowedHosts: ReadonlySet<string>,
): boolean {
  const hostHeader = request.headers.host;
  if (!hostHeader) {
    return false;
  }
  const requestedHost = parseSignalHostHeader(hostHeader);
  if (requestedHost === undefined) {
    return false;
  }
  const normalizedBindHost = normalizeSignalHost(bindHost);
  if (allowedHosts.has(requestedHost)) {
    return true;
  }
  if (normalizedBindHost !== "0.0.0.0" && normalizedBindHost !== "::") {
    return false;
  }
  const localAddress = normalizeSignalHost(request.socket.localAddress ?? "");
  return isIP(requestedHost) !== 0 && requestedHost === localAddress;
}

export async function startSignalServer(
  params: StartSignalServerParams = {},
): Promise<StartedSignalServer> {
  const state: SignalServerState = {
    account: params.account ?? "+15550000000",
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    clients: new Set(),
    clientBuffers: new Map(),
    maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
    maxSseClients:
      Number.isSafeInteger(params.maxSseClients) && (params.maxSseClients ?? 0) > 0
        ? params.maxSseClients!
        : DEFAULT_MAX_SIGNAL_SSE_CLIENTS,
    nextEventSequence: 1,
    nextTimestamp: Date.now(),
    onEvent: params.onEvent,
    pendingEventBytes: 0,
    pendingEvents: [],
    pendingRpcRequests: Promise.resolve(),
    pendingSseClients: 0,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "signal.jsonl"),
  };
  const host = params.host ?? "127.0.0.1";
  const normalizedHost = normalizeSignalHost(host);
  const allowedHosts = new Set([
    ...(normalizedHost === "0.0.0.0" || normalizedHost === "::" ? [] : [normalizedHost]),
    ...(params.allowedHosts ?? []).map((allowedHost) => normalizeSignalHost(allowedHost)),
  ]);
  const server = createServer((request, response) => {
    if (!signalRequestHostAllowed(request, host, allowedHosts)) {
      drainRequestBody(request);
      void writeResponse(
        response,
        jsonResponse({ error: "Host header is not allowed", ok: false }, 400),
      ).catch(() => response.destroy());
      return;
    }
    void handleRequest({ request, response, state }).catch(async (error) => {
      if (!response.headersSent) {
        let errorResponse: Response;
        const isAdminRequest =
          new URL(request.url ?? "/", "http://localhost").pathname === "/crabline/signal/inbound";
        if (error instanceof InvalidJsonBodyError) {
          errorResponse = isAdminRequest
            ? jsonResponse({ error: "Request body is not valid JSON", ok: false }, 400)
            : rpcError(-32700, "Parse error");
        } else if (error instanceof RequestBodyTooLargeError) {
          errorResponse = isAdminRequest
            ? jsonResponse({ error: "Request body is too large", ok: false }, 413)
            : rpcError(-32600, "Request body is too large", null, 413);
        } else {
          errorResponse = jsonResponse({ error: "internal server error", ok: false }, 500);
        }
        try {
          await writeResponse(response, errorResponse);
        } catch (writeError) {
          response.destroy(
            writeError instanceof Error ? writeError : new Error(String(writeError)),
          );
        }
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to resolve Signal local server address.");
  }
  const keepalive = setInterval(() => {
    for (const client of state.clients) {
      writeSignalSse(state, client, { data: ":\n" });
    }
  }, SIGNAL_CLI_SSE_KEEPALIVE_MS);
  keepalive.unref();
  const advertisedHost =
    normalizedHost === "0.0.0.0" ? "127.0.0.1" : normalizedHost === "::" ? "::1" : host;
  const baseUrl = `http://${formatUrlHost(advertisedHost)}:${address.port}`;
  return {
    async close() {
      clearInterval(keepalive);
      for (const client of state.clients) {
        client.end();
      }
      await closeServer(server);
    },
    manifest: {
      account: state.account,
      adminToken: state.adminToken,
      baseUrl,
      endpoints: {
        adminInboundUrl: `${baseUrl}/crabline/signal/inbound`,
        apiRoot: baseUrl,
        eventsUrl: `${baseUrl}/api/v1/events`,
        rpcUrl: `${baseUrl}/api/v1/rpc`,
      },
      env: {},
      provider: "signal",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
