import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  adminAuthError,
  constantTimeTokenEqual,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  isLoopbackHost,
  parseUnknownRequestBody,
  queryRecord,
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
import { closeWebSocketServer } from "./websocket.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 45_000;
const DEFAULT_IDENTIFY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_GATEWAY_PAYLOAD_BYTES = 4_096;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DISCORD_ID_PATTERN = /^\d{17,20}$/u;

type DiscordUser = {
  avatar: null;
  bot?: boolean;
  discriminator: "0";
  global_name: string | null;
  id: string;
  username: string;
};

type DiscordChannel = {
  guild_id?: string;
  id: string;
  last_message_id: string | null;
  name?: string;
  parent_id?: string | null;
  recipients?: DiscordUser[];
  type: number;
};

type DiscordMessage = {
  allowed_mentions?: unknown;
  attachments: unknown[];
  author: DiscordUser;
  channel_id: string;
  components: unknown[];
  content: string;
  edited_timestamp: null;
  embeds: unknown[];
  flags: number;
  guild_id?: string;
  id: string;
  mention_everyone: boolean;
  mention_roles: string[];
  mentions: DiscordUser[];
  message_reference?: {
    channel_id: string;
    guild_id?: string;
    message_id: string;
  };
  nonce?: string | number;
  pinned: boolean;
  referenced_message?: DiscordMessage | null;
  timestamp: string;
  tts: boolean;
  type: number;
};

type DiscordCommand = Record<string, unknown> & {
  application_id: string;
  id: string;
  version: string;
};

type GatewayClient = {
  identified: boolean;
  sessionId?: string;
  socket: WebSocket;
};

type GatewaySession = {
  lastSequence: number;
};

type DiscordServerState = {
  adminToken: string;
  applicationId: string;
  botToken: string;
  botUser: DiscordUser;
  channels: Map<string, DiscordChannel>;
  commands: Map<string, DiscordCommand>;
  gatewayClients: Set<GatewayClient>;
  gatewayUrl?: string;
  guildCommands: Map<string, Map<string, DiscordCommand>>;
  guilds: Map<string, Record<string, unknown>>;
  heartbeatIntervalMs: number;
  identifyTimeoutMs: number;
  maxGatewayPayloadBytes: number;
  messages: Map<string, DiscordMessage[]>;
  nextSequence: number;
  onEvent: ServerEventObserver | undefined;
  pendingRecorderEvents: Set<Promise<void>>;
  recorderPath: string;
  sessions: Map<string, GatewaySession>;
};

type DiscordRecorderEvent = ServerRequestEvent & { accepted?: boolean };

export type DiscordServerManifest = {
  adminToken: string;
  applicationId: string;
  baseUrl: string;
  botToken: string;
  botUserId: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    gatewayBotUrl: string;
    gatewayUrl: string;
  };
  env: {
    DISCORD_BOT_TOKEN: string;
  };
  provider: "discord";
  recorderPath: string;
  version: 1;
};

export type StartedDiscordServer = {
  close(): Promise<void>;
  manifest: DiscordServerManifest;
};

export type StartDiscordServerParams = {
  adminToken?: string | undefined;
  applicationId?: string | undefined;
  botToken?: string | undefined;
  botUserId?: string | undefined;
  botUsername?: string | undefined;
  heartbeatIntervalMs?: number | undefined;
  host?: string | undefined;
  identifyTimeoutMs?: number | undefined;
  maxGatewayPayloadBytes?: number | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
};

function discordSnowflake(seed = 0): string {
  const timestamp = BigInt(Math.max(Date.now(), Number(DISCORD_EPOCH_MS))) - DISCORD_EPOCH_MS;
  return ((timestamp << 22n) | BigInt(seed & 0x3f_ffff)).toString();
}

export function discordDirectChannelId(botUserId: string, recipientId: string): string {
  if (!DISCORD_ID_PATTERN.test(botUserId) || !DISCORD_ID_PATTERN.test(recipientId)) {
    throw new Error("Discord direct channel participants must be Discord snowflakes.");
  }
  const digest = createHash("sha256")
    .update([botUserId, recipientId].sort().join(":"))
    .digest("hex");
  return (
    100_000_000_000_000_000n +
    (BigInt(`0x${digest.slice(0, 16)}`) % 900_000_000_000_000_000n)
  ).toString();
}

function requireSnowflake(value: unknown, label: string): string {
  const id = readTrimmedString(value);
  if (!id || !DISCORD_ID_PATTERN.test(id)) {
    throw new DiscordRequestError(400, 50_035, `${label} must be a Discord snowflake.`);
  }
  return id;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

class DiscordRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DiscordRequestError";
  }
}

function discordError(status: number, code: number, message: string): Response {
  return discordJson({ code, message }, status);
}

function rateLimitHeaders(headers?: ConstructorParameters<typeof Headers>[0]): Headers {
  return new Headers({
    "x-ratelimit-bucket": "crabline-discord",
    "x-ratelimit-limit": "1000",
    "x-ratelimit-remaining": "999",
    "x-ratelimit-reset-after": "0",
    ...Object.fromEntries(new Headers(headers)),
  });
}

function discordJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: rateLimitHeaders({ "content-type": "application/json" }),
    status,
  });
}

function discordEmpty(status = 204): Response {
  return new Response(null, { headers: rateLimitHeaders(), status });
}

function authorizationError(request: IncomingMessage, state: DiscordServerState): Response | null {
  const authorization = request.headers.authorization?.trim();
  if (!authorization?.startsWith("Bot ")) {
    return new Response(JSON.stringify({ code: 0, message: "401: Unauthorized" }), {
      headers: rateLimitHeaders({
        "content-type": "application/json",
        "www-authenticate": 'Bot realm="Discord"',
      }),
      status: 401,
    });
  }
  const token = authorization.slice(4);
  return constantTimeTokenEqual(token, state.botToken)
    ? null
    : new Response(JSON.stringify({ code: 0, message: "401: Unauthorized" }), {
        headers: rateLimitHeaders({ "content-type": "application/json" }),
        status: 401,
      });
}

function discordUser(id: string, username: string, bot = false): DiscordUser {
  return {
    avatar: null,
    ...(bot ? { bot: true } : {}),
    discriminator: "0",
    global_name: username,
    id,
    username,
  };
}

function ensureGuild(state: DiscordServerState, guildId: string): Record<string, unknown> {
  const current = state.guilds.get(guildId);
  if (current) {
    return current;
  }
  const guild = {
    afk_timeout: 300,
    channels: [],
    emojis: [],
    features: [],
    id: guildId,
    joined_at: new Date().toISOString(),
    large: false,
    member_count: 1,
    members: [
      {
        deaf: false,
        joined_at: new Date().toISOString(),
        mute: false,
        pending: false,
        roles: [],
        user: state.botUser,
      },
    ],
    name: "Crabline Discord Guild",
    owner_id: state.botUser.id,
    presences: [],
    roles: [
      {
        color: 0,
        hoist: false,
        id: guildId,
        managed: false,
        mentionable: false,
        name: "@everyone",
        permissions: "0",
        position: 0,
      },
    ],
    unavailable: false,
    voice_states: [],
  };
  state.guilds.set(guildId, guild);
  return guild;
}

function ensureChannel(params: {
  channelId: string;
  guildId?: string;
  parentId?: string;
  sender?: DiscordUser;
  state: DiscordServerState;
}): DiscordChannel {
  const current = params.state.channels.get(params.channelId);
  if (current) {
    return current;
  }
  const channel: DiscordChannel = params.guildId
    ? {
        guild_id: params.guildId,
        id: params.channelId,
        last_message_id: null,
        name: params.parentId ? "crabline-thread" : "crabline-channel",
        parent_id: params.parentId ?? null,
        type: params.parentId ? 11 : 0,
      }
    : {
        id: params.channelId,
        last_message_id: null,
        recipients: params.sender ? [params.sender] : [],
        type: 1,
      };
  params.state.channels.set(params.channelId, channel);
  if (params.guildId) {
    const guild = ensureGuild(params.state, params.guildId);
    const channels = Array.isArray(guild.channels) ? guild.channels : [];
    guild.channels = [...channels, channel];
  }
  return channel;
}

function parseMentions(content: string, state: DiscordServerState): DiscordUser[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(/<@!?(\d{17,20})>/gu)) {
    ids.add(match[1]!);
  }
  return [...ids].map((id) =>
    id === state.botUser.id ? state.botUser : discordUser(id, `user-${id.slice(-6)}`),
  );
}

function resolveMessageReference(
  state: DiscordServerState,
  channelId: string,
  value: unknown,
): DiscordMessage["message_reference"] | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const messageId = readTrimmedString(value.message_id);
  if (!messageId) {
    return undefined;
  }
  const referencedChannelId = readTrimmedString(value.channel_id) ?? channelId;
  const channel = state.channels.get(referencedChannelId);
  return {
    channel_id: referencedChannelId,
    ...(channel?.guild_id ? { guild_id: channel.guild_id } : {}),
    message_id: messageId,
  };
}

function findMessage(
  state: DiscordServerState,
  channelId: string,
  messageId: string,
): DiscordMessage | undefined {
  return state.messages.get(channelId)?.find((message) => message.id === messageId);
}

function createMessage(params: {
  author: DiscordUser;
  body: Record<string, unknown>;
  channel: DiscordChannel;
  state: DiscordServerState;
}): DiscordMessage {
  const content = typeof params.body.content === "string" ? params.body.content : "";
  const embeds = Array.isArray(params.body.embeds) ? params.body.embeds : [];
  const components = Array.isArray(params.body.components) ? params.body.components : [];
  const attachments = Array.isArray(params.body.attachments) ? params.body.attachments : [];
  if (!content && embeds.length === 0 && components.length === 0 && attachments.length === 0) {
    throw new DiscordRequestError(400, 50_006, "Cannot send an empty message");
  }
  if (content.length > 2_000) {
    throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
  }
  const reference = resolveMessageReference(
    params.state,
    params.channel.id,
    params.body.message_reference,
  );
  const referencedMessage = reference
    ? (findMessage(params.state, reference.channel_id, reference.message_id) ?? null)
    : undefined;
  const failIfNotExists = isJsonObject(params.body.message_reference)
    ? params.body.message_reference.fail_if_not_exists
    : undefined;
  if (reference && referencedMessage === null && failIfNotExists !== false) {
    throw new DiscordRequestError(404, 10_008, "Unknown Message");
  }
  const message: DiscordMessage = {
    ...(params.body.allowed_mentions !== undefined
      ? { allowed_mentions: params.body.allowed_mentions }
      : {}),
    attachments,
    author: params.author,
    channel_id: params.channel.id,
    components,
    content,
    edited_timestamp: null,
    embeds,
    flags: typeof params.body.flags === "number" ? params.body.flags : 0,
    ...(params.channel.guild_id ? { guild_id: params.channel.guild_id } : {}),
    id: discordSnowflake(params.state.nextSequence),
    mention_everyone: /@(everyone|here)\b/u.test(content),
    mention_roles: [...content.matchAll(/<@&(\d{17,20})>/gu)].map((match) => match[1]!),
    mentions: parseMentions(content, params.state),
    ...(reference
      ? {
          message_reference: reference,
          ...(referencedMessage !== undefined ? { referenced_message: referencedMessage } : {}),
        }
      : {}),
    ...(typeof params.body.nonce === "string" || typeof params.body.nonce === "number"
      ? { nonce: params.body.nonce }
      : {}),
    pinned: false,
    timestamp: new Date().toISOString(),
    tts: params.body.tts === true,
    type: reference ? 19 : 0,
  };
  params.state.messages.set(params.channel.id, [
    ...(params.state.messages.get(params.channel.id) ?? []),
    message,
  ]);
  params.channel.last_message_id = message.id;
  return message;
}

function sendGatewayPayload(socket: WebSocket, payload: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function dispatchGatewayEvent(state: DiscordServerState, type: string, data: unknown): void {
  const payload = { d: data, op: 0, s: state.nextSequence++, t: type };
  for (const client of state.gatewayClients) {
    if (client.identified) {
      sendGatewayPayload(client.socket, payload);
      if (client.sessionId) {
        const session = state.sessions.get(client.sessionId);
        if (session) {
          session.lastSequence = payload.s;
        }
      }
    }
  }
}

function recordGatewayEvent(state: DiscordServerState, body: unknown, accepted: boolean): void {
  const pending = recordCommittedServerEvent({
    event: {
      accepted,
      at: new Date().toISOString(),
      body,
      method: "WS",
      path: "/gateway",
      query: {},
      type: "api",
    } as DiscordRecorderEvent,
    onEvent: state.onEvent,
    recorderPath: state.recorderPath,
  });
  state.pendingRecorderEvents.add(pending);
  void pending.then(
    () => state.pendingRecorderEvents.delete(pending),
    () => state.pendingRecorderEvents.delete(pending),
  );
}

function readyPayload(state: DiscordServerState, sessionId: string) {
  return {
    application: { flags: 0, id: state.applicationId },
    guilds: [...state.guilds.values()].map((guild) => ({ id: guild.id, unavailable: true })),
    resume_gateway_url: state.gatewayUrl!,
    session_id: sessionId,
    user: state.botUser,
    v: 10,
  };
}

function attachGatewayServer(params: {
  server: import("node:http").Server;
  state: DiscordServerState;
}) {
  const gatewayServer = new WebSocketServer({
    maxPayload: params.state.maxGatewayPayloadBytes,
    noServer: true,
  });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/gateway") {
      socket.destroy();
      return;
    }
    if ((url.searchParams.get("v") ?? "10") !== "10") {
      socket.destroy();
      return;
    }
    const encoding = url.searchParams.get("encoding") ?? "json";
    if (encoding !== "json") {
      socket.destroy();
      return;
    }
    gatewayServer.handleUpgrade(request, socket, head, (client) => {
      gatewayServer.emit("connection", client, request);
    });
  };
  params.server.on("upgrade", onUpgrade);

  gatewayServer.on("connection", (socket) => {
    const client: GatewayClient = { identified: false, socket };
    params.state.gatewayClients.add(client);
    sendGatewayPayload(socket, {
      d: { heartbeat_interval: params.state.heartbeatIntervalMs },
      op: 10,
    });
    const identifyTimeout = setTimeout(() => {
      if (!client.identified) {
        socket.close(4_003, "Not authenticated");
      }
    }, params.state.identifyTimeoutMs);
    identifyTimeout.unref();

    socket.on("message", (raw: RawData) => {
      if (Buffer.byteLength(raw.toString()) > params.state.maxGatewayPayloadBytes) {
        socket.close(4_002, "Decode error");
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString()) as unknown;
      } catch {
        socket.close(4_002, "Decode error");
        return;
      }
      if (!isJsonObject(payload) || typeof payload.op !== "number") {
        socket.close(4_002, "Decode error");
        return;
      }
      recordGatewayEvent(params.state, payload, true);
      if (payload.op === 1) {
        sendGatewayPayload(socket, { d: null, op: 11 });
        return;
      }
      if (payload.op === 2) {
        if (client.identified || !isJsonObject(payload.d)) {
          socket.close(4_005, "Already authenticated");
          return;
        }
        const token = readTrimmedString(payload.d.token);
        if (!token || !constantTimeTokenEqual(token, params.state.botToken)) {
          socket.close(4_004, "Authentication failed");
          return;
        }
        clearTimeout(identifyTimeout);
        client.identified = true;
        client.sessionId = randomUUID();
        params.state.sessions.set(client.sessionId, { lastSequence: params.state.nextSequence });
        if (params.state.sessions.size > 128) {
          const oldestSessionId = params.state.sessions.keys().next().value as string | undefined;
          if (oldestSessionId) {
            params.state.sessions.delete(oldestSessionId);
          }
        }
        sendGatewayPayload(socket, {
          d: readyPayload(params.state, client.sessionId),
          op: 0,
          s: params.state.nextSequence++,
          t: "READY",
        });
        for (const guild of params.state.guilds.values()) {
          dispatchGatewayEvent(params.state, "GUILD_CREATE", guild);
        }
        return;
      }
      if (payload.op === 6) {
        if (!isJsonObject(payload.d)) {
          sendGatewayPayload(socket, { d: false, op: 9 });
          return;
        }
        const token = readTrimmedString(payload.d.token);
        const sessionId = readTrimmedString(payload.d.session_id);
        if (
          !token ||
          !constantTimeTokenEqual(token, params.state.botToken) ||
          !sessionId ||
          !params.state.sessions.has(sessionId)
        ) {
          sendGatewayPayload(socket, { d: false, op: 9 });
          return;
        }
        clearTimeout(identifyTimeout);
        client.identified = true;
        client.sessionId = sessionId;
        const session = params.state.sessions.get(sessionId)!;
        params.state.sessions.delete(sessionId);
        params.state.sessions.set(sessionId, session);
        sendGatewayPayload(socket, {
          d: {},
          op: 0,
          s: params.state.nextSequence++,
          t: "RESUMED",
        });
        return;
      }
      if (payload.op === 3 || payload.op === 4 || payload.op === 8) {
        return;
      }
      socket.close(4_001, "Unknown opcode");
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clearTimeout(identifyTimeout);
      params.state.gatewayClients.delete(client);
    });
  });

  return async () => {
    params.server.off("upgrade", onUpgrade);
    await closeWebSocketServer(gatewayServer);
  };
}

function commandBody(
  state: DiscordServerState,
  body: Record<string, unknown>,
  existing?: DiscordCommand,
  guildId?: string,
): DiscordCommand {
  const name = readTrimmedString(body.name ?? existing?.name);
  if (!name || name.length > 32 || !/^[\w-]+$/u.test(name)) {
    throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
  }
  return {
    ...existing,
    ...body,
    application_id: state.applicationId,
    description: readTrimmedString(body.description ?? existing?.description) ?? "",
    ...(guildId ? { guild_id: guildId } : {}),
    id: existing?.id ?? discordSnowflake(state.nextSequence++),
    name,
    type: typeof body.type === "number" ? body.type : (existing?.type ?? 1),
    version: discordSnowflake(state.nextSequence++),
  };
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: DiscordServerState;
}): Promise<Response> {
  const requestedChannelId = requireSnowflake(params.body.channelId, "channelId");
  const guildId =
    params.body.guildId === undefined
      ? undefined
      : requireSnowflake(params.body.guildId, "guildId");
  const senderId = requireSnowflake(params.body.senderId, "senderId");
  const parentChannelId =
    params.body.parentChannelId === undefined
      ? undefined
      : requireSnowflake(params.body.parentChannelId, "parentChannelId");
  if (parentChannelId && !guildId) {
    throw new DiscordRequestError(400, 50_035, "Threads require guildId.");
  }
  const sender = discordUser(
    senderId,
    readTrimmedString(params.body.senderName) ?? `user-${senderId.slice(-6)}`,
  );
  const hadChannel = params.state.channels.has(requestedChannelId);
  const hadGuild = guildId ? params.state.guilds.has(guildId) : true;
  const channel = ensureChannel({
    channelId: requestedChannelId,
    ...(guildId ? { guildId } : {}),
    ...(parentChannelId ? { parentId: parentChannelId } : {}),
    sender,
    state: params.state,
  });
  const message = createMessage({
    author: sender,
    body: params.body,
    channel,
    state: params.state,
  });
  if (guildId) {
    const guild = params.state.guilds.get(guildId)!;
    const members = Array.isArray(guild.members) ? guild.members : [];
    if (
      !members.some(
        (member) =>
          isJsonObject(member) && isJsonObject(member.user) && member.user.id === sender.id,
      )
    ) {
      members.push({
        deaf: false,
        joined_at: new Date().toISOString(),
        mute: false,
        pending: false,
        roles: [],
        user: sender,
      });
      guild.members = members;
      guild.member_count = members.length;
    }
    (message as DiscordMessage & { member: Record<string, unknown> }).member = {
      deaf: false,
      joined_at: new Date().toISOString(),
      mute: false,
      pending: false,
      roles: [],
    };
  }
  if (!hadGuild && guildId) {
    dispatchGatewayEvent(params.state, "GUILD_CREATE", params.state.guilds.get(guildId));
  }
  if (!hadChannel) {
    dispatchGatewayEvent(params.state, "CHANNEL_CREATE", channel);
  }
  dispatchGatewayEvent(params.state, "MESSAGE_CREATE", message);
  return discordJson({ event: { d: message, op: 0, t: "MESSAGE_CREATE" }, message });
}

async function handleDiscordApi(params: {
  body: unknown;
  method: string;
  pathname: string;
  state: DiscordServerState;
}): Promise<Response> {
  const pathParts = params.pathname.split("/").filter(Boolean);
  if (pathParts[0] !== "api" || pathParts[1] !== "v10") {
    return discordError(404, 0, "404: Not Found");
  }
  const route = pathParts.slice(2);
  if (params.method === "GET" && route.join("/") === "users/@me") {
    return discordJson(params.state.botUser);
  }
  if (params.method === "GET" && route.join("/") === "oauth2/applications/@me") {
    return discordJson({
      bot: params.state.botUser,
      flags: 0,
      id: params.state.applicationId,
      name: "Crabline Discord Application",
      owner: params.state.botUser,
      verify_key: "crabline",
    });
  }
  if (
    params.method === "GET" &&
    (route.join("/") === "gateway/bot" || route.join("/") === "gateway")
  ) {
    return discordJson({
      session_start_limit: {
        max_concurrency: 1,
        remaining: 1_000,
        reset_after: 0,
        total: 1_000,
      },
      shards: 1,
      url: params.state.gatewayUrl,
    });
  }
  if (route[0] === "channels" && route.length >= 2) {
    const channelId = requireSnowflake(route[1], "channel id");
    const channel = params.state.channels.get(channelId);
    if (route.length === 2 && params.method === "GET") {
      return channel ? discordJson(channel) : discordError(404, 10_003, "Unknown Channel");
    }
    if (route[2] === "typing" && route.length === 3 && params.method === "POST") {
      return channel ? discordEmpty() : discordError(404, 10_003, "Unknown Channel");
    }
    if (route[2] === "messages") {
      if (!channel) {
        return discordError(404, 10_003, "Unknown Channel");
      }
      if (route.length === 3 && params.method === "POST") {
        if (!isJsonObject(params.body)) {
          throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
        }
        const message = createMessage({
          author: params.state.botUser,
          body: params.body,
          channel,
          state: params.state,
        });
        dispatchGatewayEvent(params.state, "MESSAGE_CREATE", message);
        return discordJson(message);
      }
      if (route.length === 3 && params.method === "GET") {
        return discordJson(
          [...(params.state.messages.get(channelId) ?? [])].reverse().slice(0, 50),
        );
      }
      const messageId = route[3] ? requireSnowflake(route[3], "message id") : undefined;
      if (
        messageId &&
        route[4] === "reactions" &&
        route[5] &&
        route[6] === "@me" &&
        (params.method === "PUT" || params.method === "DELETE")
      ) {
        return findMessage(params.state, channelId, messageId)
          ? discordEmpty()
          : discordError(404, 10_008, "Unknown Message");
      }
      if (messageId && params.method === "GET") {
        const message = findMessage(params.state, channelId, messageId);
        return message ? discordJson(message) : discordError(404, 10_008, "Unknown Message");
      }
    }
  }
  if (params.method === "POST" && route.join("/") === "users/@me/channels") {
    if (!isJsonObject(params.body)) {
      throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
    }
    const recipientId = requireSnowflake(params.body.recipient_id, "recipient_id");
    const recipient = discordUser(recipientId, `user-${recipientId.slice(-6)}`);
    const channelId = discordDirectChannelId(params.state.botUser.id, recipientId);
    return discordJson(ensureChannel({ channelId, sender: recipient, state: params.state }));
  }
  if (route[0] === "guilds" && route[1]) {
    const guildId = requireSnowflake(route[1], "guild id");
    const guild = params.state.guilds.get(guildId);
    if (!guild) {
      return discordError(404, 10_004, "Unknown Guild");
    }
    if (route.length === 2 && params.method === "GET") {
      return discordJson(guild);
    }
    if (route[2] === "channels" && params.method === "GET") {
      return discordJson(
        [...params.state.channels.values()].filter((channel) => channel.guild_id === guildId),
      );
    }
    if (route[2] === "roles" && params.method === "GET") {
      return discordJson(guild.roles ?? []);
    }
    if (route[2] === "members" && route[3] && params.method === "GET") {
      const userId = requireSnowflake(route[3], "user id");
      const user =
        userId === params.state.botUser.id
          ? params.state.botUser
          : discordUser(userId, `user-${userId.slice(-6)}`);
      return discordJson({
        deaf: false,
        joined_at: new Date().toISOString(),
        mute: false,
        pending: false,
        roles: [],
        user,
      });
    }
  }
  if (route[0] === "applications" && route[1] === params.state.applicationId) {
    let commandOffset = 2;
    let guildId: string | undefined;
    if (route[2] === "guilds" && route[3] && route[4] === "commands") {
      guildId = requireSnowflake(route[3], "guild id");
      commandOffset = 4;
    }
    if (route[commandOffset] === "commands") {
      const commands = guildId
        ? (params.state.guildCommands.get(guildId) ?? new Map<string, DiscordCommand>())
        : params.state.commands;
      if (guildId && !params.state.guildCommands.has(guildId)) {
        params.state.guildCommands.set(guildId, commands);
      }
      const commandId = route[commandOffset + 1];
      if (!commandId && params.method === "GET") {
        return discordJson([...commands.values()]);
      }
      if (!commandId && params.method === "PUT") {
        if (!Array.isArray(params.body) || params.body.some((entry) => !isJsonObject(entry))) {
          throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
        }
        commands.clear();
        for (const body of params.body as Record<string, unknown>[]) {
          const command = commandBody(params.state, body, undefined, guildId);
          commands.set(command.id, command);
        }
        return discordJson([...commands.values()]);
      }
      if (!commandId && params.method === "POST") {
        if (!isJsonObject(params.body)) {
          throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
        }
        const command = commandBody(params.state, params.body, undefined, guildId);
        commands.set(command.id, command);
        return discordJson(command, 201);
      }
      if (commandId) {
        const existing = commands.get(commandId);
        if (!existing) {
          return discordError(404, 10_063, "Unknown application command");
        }
        if (params.method === "PATCH") {
          if (!isJsonObject(params.body)) {
            throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
          }
          const command = commandBody(params.state, params.body, existing, guildId);
          commands.set(commandId, command);
          return discordJson(command);
        }
        if (params.method === "DELETE") {
          commands.delete(commandId);
          return discordEmpty();
        }
      }
    }
  }
  return discordError(404, 0, "404: Not Found");
}

async function handleRequest(params: {
  request: IncomingMessage;
  state: DiscordServerState;
}): Promise<Response> {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");
  const method = params.request.method ?? "GET";
  if (url.pathname === "/crabline/discord/inbound") {
    if (method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      params.request.resume();
      return adminAuthError();
    }
    const body = await parseUnknownRequestBody(params.request);
    if (!isJsonObject(body)) {
      throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
    }
    const event: DiscordRecorderEvent = {
      at: new Date().toISOString(),
      body,
      method,
      path: url.pathname,
      query: queryRecord(url),
      type: "admin",
    };
    const response = await handleAdminInbound({ body, state: params.state });
    event.accepted = response.ok;
    await recordCommittedServerEvent({
      event,
      onEvent: params.state.onEvent,
      recorderPath: params.state.recorderPath,
    });
    return response;
  }
  const authError = authorizationError(params.request, params.state);
  if (authError) {
    params.request.resume();
    return authError;
  }
  const body =
    method === "GET" || method === "DELETE" ? {} : await parseUnknownRequestBody(params.request);
  const event: DiscordRecorderEvent = {
    at: new Date().toISOString(),
    ...(isJsonObject(body) && Object.keys(body).length > 0 ? { body } : {}),
    method,
    path: url.pathname,
    query: queryRecord(url),
    type: "api",
  };
  const response = await handleDiscordApi({
    body,
    method,
    pathname: url.pathname,
    state: params.state,
  });
  event.accepted = response.ok;
  await (response.ok ? recordCommittedServerEvent : recordServerEvent)({
    event,
    onEvent: params.state.onEvent,
    recorderPath: params.state.recorderPath,
  });
  return response;
}

export async function startDiscordServer(
  params: StartDiscordServerParams = {},
): Promise<StartedDiscordServer> {
  const host = params.host ?? "127.0.0.1";
  const applicationId = params.applicationId ?? "135000000000000001";
  const botUserId = params.botUserId ?? applicationId;
  requireSnowflake(applicationId, "applicationId");
  requireSnowflake(botUserId, "botUserId");
  const encodedApplicationId = Buffer.from(applicationId, "utf8").toString("base64url");
  const externallyBound = !isLoopbackHost(host);
  const state: DiscordServerState = {
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    applicationId,
    botToken:
      params.botToken ??
      (externallyBound
        ? `${encodedApplicationId}.${randomBytes(6).toString("base64url")}.${randomBytes(24).toString("base64url")}`
        : `${encodedApplicationId}.crabline.discord`),
    botUser: discordUser(botUserId, params.botUsername ?? "crabline", true),
    channels: new Map(),
    commands: new Map(),
    gatewayClients: new Set(),
    guildCommands: new Map(),
    guilds: new Map(),
    heartbeatIntervalMs: positiveInteger(
      params.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    ),
    identifyTimeoutMs: positiveInteger(
      params.identifyTimeoutMs,
      DEFAULT_IDENTIFY_TIMEOUT_MS,
      "identifyTimeoutMs",
    ),
    maxGatewayPayloadBytes: positiveInteger(
      params.maxGatewayPayloadBytes,
      DEFAULT_MAX_GATEWAY_PAYLOAD_BYTES,
      "maxGatewayPayloadBytes",
    ),
    messages: new Map(),
    nextSequence: 1,
    onEvent: params.onEvent,
    pendingRecorderEvents: new Set(),
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "discord.jsonl"),
    sessions: new Map(),
  };
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest({ request, state }),
    handleError: (error) => {
      if (error instanceof DiscordRequestError) {
        return discordError(error.status, error.code, error.message);
      }
      if (error instanceof InvalidJsonBodyError) {
        return discordError(400, 50_035, "Invalid Form Body");
      }
      if (error instanceof RequestBodyTooLargeError) {
        return discordError(413, 40_005, "Request entity too large");
      }
      return undefined;
    },
    host,
    port: params.port ?? 0,
    serverName: "Discord",
  });
  state.gatewayUrl = `${httpServer.baseUrl.replace(/^http/u, "ws")}/gateway`;
  const closeGateway = attachGatewayServer({ server: httpServer.server, state });
  return {
    async close() {
      await closeGateway();
      await httpServer.close();
      await Promise.all([...state.pendingRecorderEvents]);
      state.sessions.clear();
    },
    manifest: {
      adminToken: state.adminToken,
      applicationId: state.applicationId,
      baseUrl: httpServer.baseUrl,
      botToken: state.botToken,
      botUserId: state.botUser.id,
      endpoints: {
        adminInboundUrl: `${httpServer.baseUrl}/crabline/discord/inbound`,
        apiRoot: `${httpServer.baseUrl}/api`,
        gatewayBotUrl: `${httpServer.baseUrl}/api/v10/gateway/bot`,
        gatewayUrl: state.gatewayUrl,
      },
      env: { DISCORD_BOT_TOKEN: state.botToken },
      provider: "discord",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
