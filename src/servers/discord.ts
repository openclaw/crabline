import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  adminAuthError,
  createServerClose,
  constantTimeTokenEqual,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  isLoopbackHost,
  parseUnknownRequestBody,
  queryRecord,
  readBody,
  readTrimmedString,
  RequestBodyTooLargeError,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";
import { createServerRecorder, type ServerRecorder, type ServerEventObserver } from "./recorder.js";
import { closeWebSocketServer } from "./websocket.js";
import { startDiscordVoiceServer, type DiscordVoiceSession } from "./discord-voice.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 45_000;
const DEFAULT_IDENTIFY_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACHMENT_URL_TTL_MS = 60 * 60 * 1_000;
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
  thread_metadata?: { archived: boolean; auto_archive_duration: number; archive_timestamp: string };
  type: number;
};

type DiscordMessage = {
  allowed_mentions?: unknown;
  attachments: unknown[];
  author: DiscordUser;
  channel_id: string;
  components: unknown[];
  content: string;
  edited_timestamp: string | null;
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
  reactions: Array<{
    count: number;
    count_details: { burst: number; normal: number };
    emoji: { id: string | null; name: string };
    me: boolean;
    me_burst: boolean;
  }>;
  referenced_message?: DiscordMessage | null;
  timestamp: string;
  thread?: DiscordChannel;
  tts: boolean;
  type: number;
};

type DiscordCommand = Record<string, unknown> & {
  application_id: string;
  id: string;
  version: string;
};

type StoredDiscordAttachment = {
  bytes: Buffer;
  capability: string;
  contentType: string;
  descriptor: Record<string, unknown>;
  expiresAt: number;
  filename: string;
  messageId?: string;
  uploadBatchId: string;
};

type GatewayClient = {
  identified: boolean;
  sessionId?: string;
  socket: WebSocket;
  user?: DiscordUser;
};

type GatewaySession = {
  lastSequence: number;
  token: string;
  userId: string;
};

type DiscordServerState = {
  adminToken: string;
  applicationId: string;
  attachmentUrlTtlMs: number;
  driverApplicationId: string;
  attachments: Map<string, StoredDiscordAttachment>;
  baseUrl?: string;
  botToken: string;
  botUser: DiscordUser;
  driverBotToken: string;
  driverBotUser: DiscordUser;
  channels: Map<string, DiscordChannel>;
  commands: Map<string, Map<string, DiscordCommand>>;
  gatewayClients: Set<GatewayClient>;
  gatewayUrl?: string;
  guildCommands: Map<string, Map<string, DiscordCommand>>;
  guilds: Map<string, Record<string, unknown>>;
  heartbeatIntervalMs: number;
  identifyTimeoutMs: number;
  maxGatewayPayloadBytes: number;
  messages: Map<string, DiscordMessage[]>;
  nextSequence: number;
  recorder: ServerRecorder;
  recorderPath: string;
  reactionActors: Map<string, Set<string>>;
  privateChannelBotUsers: Map<string, string>;
  sessions: Map<string, GatewaySession>;
  threadMembers: Map<string, Set<string>>;
  voiceStates: Map<string, Record<string, unknown>>;
  voiceEndpoint?: string;
  voiceSessions: Map<string, DiscordVoiceSession>;
  invalidateVoiceSession?: (sessionId: string) => void;
};

type DiscordRecorderEvent = ServerRequestEvent & { accepted?: boolean };

export type DiscordServerManifest = {
  adminToken: string;
  applicationId: string;
  baseUrl: string;
  botToken: string;
  botUserId: string;
  driverBotToken: string;
  driverBotUserId: string;
  driverApplicationId: string;
  fixture: {
    channelId: string;
    guildId: string;
    voiceChannelId: string;
  };
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    gatewayBotUrl: string;
    gatewayUrl: string;
    voiceCaCertificate: string;
    voiceEndpoint: string;
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
  attachmentUrlTtlMs?: number | undefined;
  botToken?: string | undefined;
  botUserId?: string | undefined;
  botUsername?: string | undefined;
  driverBotToken?: string | undefined;
  driverBotUserId?: string | undefined;
  driverBotUsername?: string | undefined;
  fixtureChannelId?: string | undefined;
  fixtureGuildId?: string | undefined;
  fixtureVoiceChannelId?: string | undefined;
  heartbeatIntervalMs?: number | undefined;
  host?: string | undefined;
  identifyTimeoutMs?: number | undefined;
  maxGatewayPayloadBytes?: number | undefined;
  onEvent?: ServerEventObserver | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
};

const attachmentUploadBatches = new WeakMap<Record<string, unknown>, string>();

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

function authorizedDiscordUser(
  request: IncomingMessage,
  state: DiscordServerState,
): DiscordUser | null {
  const authorization = request.headers.authorization?.trim();
  if (!authorization?.startsWith("Bot ")) {
    return null;
  }
  return discordUserForToken(authorization.slice(4), state);
}

function discordUserForToken(token: string, state: DiscordServerState): DiscordUser | null {
  if (constantTimeTokenEqual(token, state.botToken)) {
    return state.botUser;
  }
  return constantTimeTokenEqual(token, state.driverBotToken) ? state.driverBotUser : null;
}

function authorizationError(request: IncomingMessage, state: DiscordServerState): Response | null {
  return authorizedDiscordUser(request, state)
    ? null
    : new Response(JSON.stringify({ code: 0, message: "401: Unauthorized" }), {
        headers: rateLimitHeaders({
          "content-type": "application/json",
          "www-authenticate": 'Bot realm="Discord"',
        }),
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

function voiceStateKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function applicationIdForUser(state: DiscordServerState, userId: string): string {
  return userId === state.driverBotUser.id ? state.driverApplicationId : state.applicationId;
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
      {
        deaf: false,
        joined_at: new Date().toISOString(),
        mute: false,
        pending: false,
        roles: [],
        user: state.driverBotUser,
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
  botUserId?: string;
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
        ...(params.parentId
          ? {
              thread_metadata: {
                archive_timestamp: new Date().toISOString(),
                archived: false,
                auto_archive_duration: 1_440,
              },
            }
          : {}),
        type: params.parentId ? 11 : 0,
      }
    : {
        id: params.channelId,
        last_message_id: null,
        recipients: params.sender ? [params.sender] : [],
        type: 1,
      };
  params.state.channels.set(params.channelId, channel);
  if (!params.guildId && params.botUserId) {
    params.state.privateChannelBotUsers.set(params.channelId, params.botUserId);
  }
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
    id === state.botUser.id
      ? state.botUser
      : id === state.driverBotUser.id
        ? state.driverBotUser
        : discordUser(id, `user-${id.slice(-6)}`),
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

function canAccessChannel(
  state: DiscordServerState,
  channel: DiscordChannel | undefined,
  userId: string,
): boolean {
  return Boolean(
    channel && (channel.type !== 1 || state.privateChannelBotUsers.get(channel.id) === userId),
  );
}

function resolveMessageAttachments(params: {
  body: Record<string, unknown>;
  existingAttachments?: unknown[];
  messageId: string;
  state: DiscordServerState;
}): unknown[] {
  if (!Array.isArray(params.body.attachments)) {
    return [];
  }
  const uploadBatchId = attachmentUploadBatches.get(params.body);
  const resolved = params.body.attachments.map((entry) => {
    if (!isJsonObject(entry)) {
      throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
    }
    const id = readTrimmedString(entry.id);
    const stored = id ? params.state.attachments.get(id) : undefined;
    const ownedByMessage = stored?.messageId === params.messageId;
    const uploadedInRequest = Boolean(
      stored && uploadBatchId && stored.uploadBatchId === uploadBatchId,
    );
    if (!stored || (!ownedByMessage && !uploadedInRequest)) {
      throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
    }
    const existingAttachment = params.existingAttachments?.find(
      (attachment) => isJsonObject(attachment) && attachment.id === id,
    );
    const description =
      typeof entry.description === "string"
        ? entry.description
        : entry.description === null
          ? undefined
          : isJsonObject(existingAttachment) && typeof existingAttachment.description === "string"
            ? existingAttachment.description
            : typeof stored.descriptor.description === "string"
              ? stored.descriptor.description
              : undefined;
    return { description, stored };
  });
  for (const { stored } of resolved) {
    stored.messageId = params.messageId;
  }
  return resolved.map(({ description, stored }) => ({
    ...stored.descriptor,
    ...(description !== undefined ? { description } : {}),
  }));
}

function createMessage(params: {
  author: DiscordUser;
  body: Record<string, unknown>;
  channel: DiscordChannel;
  referenceAuthorizerId?: string;
  state: DiscordServerState;
}): DiscordMessage {
  const content = typeof params.body.content === "string" ? params.body.content : "";
  const embeds = Array.isArray(params.body.embeds) ? params.body.embeds : [];
  const components = Array.isArray(params.body.components) ? params.body.components : [];
  const hasAttachments =
    Array.isArray(params.body.attachments) && params.body.attachments.length > 0;
  if (!content && embeds.length === 0 && components.length === 0 && !hasAttachments) {
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
    ? reference.channel_id === params.channel.id &&
      canAccessChannel(
        params.state,
        params.channel,
        params.referenceAuthorizerId ?? params.author.id,
      )
      ? (findMessage(params.state, reference.channel_id, reference.message_id) ?? null)
      : null
    : undefined;
  const failIfNotExists = isJsonObject(params.body.message_reference)
    ? params.body.message_reference.fail_if_not_exists
    : undefined;
  if (reference && referencedMessage === null && failIfNotExists !== false) {
    throw new DiscordRequestError(404, 10_008, "Unknown Message");
  }
  const messageId = discordSnowflake(params.state.nextSequence++);
  const attachments = resolveMessageAttachments({
    body: params.body,
    messageId,
    state: params.state,
  });
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
    id: messageId,
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
    reactions: [],
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

function removeMessage(
  state: DiscordServerState,
  channelId: string,
  messageId: string,
): DiscordMessage | undefined {
  const messages = state.messages.get(channelId) ?? [];
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    return undefined;
  }
  const [removed] = messages.splice(index, 1);
  const channel = state.channels.get(channelId);
  if (channel?.last_message_id === messageId) {
    channel.last_message_id = messages.at(-1)?.id ?? null;
  }
  return removed;
}

function updateMessage(params: {
  body: Record<string, unknown>;
  message: DiscordMessage;
  state: DiscordServerState;
}): DiscordMessage {
  const { body, message, state } = params;
  let content = message.content;
  let mentions = message.mentions;
  let mentionEveryone = message.mention_everyone;
  let mentionRoles = message.mention_roles;
  if (body.content !== undefined) {
    const nextContent = body.content === null ? "" : body.content;
    if (typeof nextContent !== "string" || nextContent.length > 2_000) {
      throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
    }
    content = nextContent;
    mentions = parseMentions(nextContent, state);
    mentionEveryone = /@(everyone|here)\b/u.test(nextContent);
    mentionRoles = [...nextContent.matchAll(/<@&(\d{17,20})>/gu)].map((match) => match[1]!);
  }
  let attachments = message.attachments;
  if (body.attachments !== undefined) {
    if (body.attachments === null) {
      attachments = [];
    } else if (Array.isArray(body.attachments)) {
      attachments = resolveMessageAttachments({
        body,
        existingAttachments: message.attachments,
        messageId: message.id,
        state,
      });
    } else {
      throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
    }
  }
  const resolveNullableArray = (value: unknown, current: unknown[]): unknown[] => {
    if (value === undefined) {
      return current;
    }
    if (value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
    }
    return value;
  };
  const components = resolveNullableArray(body.components, message.components);
  const embeds = resolveNullableArray(body.embeds, message.embeds);
  Object.assign(message, {
    attachments,
    components,
    content,
    edited_timestamp: new Date().toISOString(),
    embeds,
    flags: typeof body.flags === "number" ? body.flags : message.flags,
    mention_everyone: mentionEveryone,
    mention_roles: mentionRoles,
    mentions,
  });
  return message;
}

function updateReaction(params: {
  emoji: { id: string | null; name: string };
  message: DiscordMessage;
  present: boolean;
  state: DiscordServerState;
  userId: string;
}): void {
  const emojiKey = params.emoji.id ? `${params.emoji.name}:${params.emoji.id}` : params.emoji.name;
  const key = `${params.message.id}:${emojiKey}`;
  const actors = params.state.reactionActors.get(key) ?? new Set<string>();
  if (params.present) {
    actors.add(params.userId);
  } else {
    actors.delete(params.userId);
  }
  if (actors.size > 0) {
    params.state.reactionActors.set(key, actors);
  } else {
    params.state.reactionActors.delete(key);
  }
  const current = params.message.reactions.find(
    (reaction) =>
      reaction.emoji.name === params.emoji.name && reaction.emoji.id === params.emoji.id,
  );
  if (actors.size > 0) {
    if (current) {
      current.me = false;
      current.count = actors.size;
      current.count_details.normal = current.count;
      return;
    }
    params.message.reactions.push({
      count: 1,
      count_details: { burst: 0, normal: 1 },
      emoji: params.emoji,
      me: false,
      me_burst: false,
    });
    return;
  }
  params.message.reactions = params.message.reactions.filter((reaction) => reaction !== current);
}

function parseReactionEmoji(value: string): { id: string | null; name: string } {
  const custom = /^(.*):(\d{17,20})$/u.exec(value);
  return custom ? { id: custom[2]!, name: custom[1]! } : { id: null, name: value };
}

function reactionKey(messageId: string, emoji: { id: string | null; name: string }): string {
  return `${messageId}:${emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name}`;
}

function attachmentForAuthorizedRead(
  attachment: unknown,
  messageId: string,
  state: DiscordServerState,
): unknown {
  if (!isJsonObject(attachment)) {
    return attachment;
  }
  const id = readTrimmedString(attachment.id);
  const stored = id ? state.attachments.get(id) : undefined;
  if (!stored || stored.messageId !== messageId) {
    return attachment;
  }
  if (Date.now() > stored.expiresAt) {
    stored.capability = randomBytes(32).toString("base64url");
    stored.expiresAt = Date.now() + state.attachmentUrlTtlMs;
    const url = `${state.baseUrl}/attachments/${id}/${encodeURIComponent(stored.filename)}?ex=${stored.expiresAt}&sig=${stored.capability}`;
    stored.descriptor = { ...stored.descriptor, proxy_url: url, url };
  }
  return {
    ...attachment,
    proxy_url: stored.descriptor.proxy_url,
    url: stored.descriptor.url,
  };
}

function attachmentContentDisposition(filename: string): string {
  const wellFormed = Array.from(filename, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 0xd800 && codePoint <= 0xdfff ? "\uFFFD" : character;
  }).join("");
  const fallback = Array.from(wellFormed, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 0x20 && codePoint <= 0x7e && character !== '"' && character !== "\\"
      ? character
      : "_";
  }).join("");
  const encoded = encodeURIComponent(wellFormed).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "attachment"}"; filename*=UTF-8''${encoded}`;
}

function messageForUser(
  message: DiscordMessage,
  user: DiscordUser,
  state: DiscordServerState,
): DiscordMessage {
  const referencedMessage = message.message_reference
    ? canAccessChannel(state, state.channels.get(message.message_reference.channel_id), user.id)
      ? (findMessage(
          state,
          message.message_reference.channel_id,
          message.message_reference.message_id,
        ) ?? null)
      : null
    : undefined;
  return {
    ...message,
    attachments: message.attachments.map((attachment) =>
      attachmentForAuthorizedRead(attachment, message.id, state),
    ),
    reactions: message.reactions.map((reaction) => ({
      ...reaction,
      me: state.reactionActors.get(reactionKey(message.id, reaction.emoji))?.has(user.id) ?? false,
    })),
    ...(referencedMessage !== undefined
      ? {
          referenced_message: referencedMessage
            ? messageForUser(referencedMessage, user, state)
            : null,
        }
      : {}),
  };
}

async function parseDiscordRequestBody(
  request: IncomingMessage,
  state: DiscordServerState,
): Promise<unknown> {
  const contentTypeValue = request.headers["content-type"] ?? "";
  const contentType = Array.isArray(contentTypeValue)
    ? (contentTypeValue[0] ?? "")
    : contentTypeValue;
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return await parseUnknownRequestBody(request);
  }
  const body = await readBody(request);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    throw new InvalidJsonBodyError(error, "Malformed multipart form data.");
  }
  const payloadRaw = form.get("payload_json");
  let payload: Record<string, unknown> = {};
  if (typeof payloadRaw === "string" && payloadRaw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadRaw) as unknown;
    } catch (error) {
      throw new InvalidJsonBodyError(error, "payload_json must be valid JSON.");
    }
    if (!isJsonObject(parsed)) {
      throw new InvalidJsonBodyError(undefined, "payload_json must be a JSON object.");
    }
    payload = parsed;
  }
  const declared = Array.isArray(payload.attachments) ? payload.attachments : [];
  const uploadBatchId = randomUUID();
  const uploadedIds = new Set(
    [...form.keys()].flatMap((name) => /^files\[(\d+)\]$/u.exec(name)?.[1] ?? []),
  );
  const retained = declared.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }
    const id = String(entry.id ?? "");
    if (!id || uploadedIds.has(id)) {
      return [];
    }
    return [entry];
  });
  const files = await Promise.all(
    [...form.entries()].flatMap(([name, file]) => {
      if (typeof file === "string") {
        return [];
      }
      const uploadId = /^files\[(\d+)\]$/u.exec(name)?.[1] ?? String(declared.length);
      const declaredDescriptor = declared.find(
        (entry) => isJsonObject(entry) && String(entry.id) === uploadId,
      );
      return [
        (async () => {
          const id = discordSnowflake(state.nextSequence++);
          const uploadContentType = file.type || "application/octet-stream";
          const expiresAt = Date.now() + state.attachmentUrlTtlMs;
          const capability = randomBytes(32).toString("base64url");
          const url = `${state.baseUrl}/attachments/${id}/${encodeURIComponent(file.name)}?ex=${expiresAt}&sig=${capability}`;
          const descriptor = {
            ...declaredDescriptor,
            content_type: uploadContentType,
            filename: file.name,
            id,
            proxy_url: url,
            size: file.size,
            url,
          };
          state.attachments.set(id, {
            bytes: Buffer.from(await file.arrayBuffer()),
            capability,
            contentType: uploadContentType,
            descriptor,
            expiresAt,
            filename: file.name,
            uploadBatchId,
          });
          return descriptor;
        })(),
      ];
    }),
  );
  const parsedBody = {
    ...payload,
    ...(files.length > 0 || retained.length > 0 ? { attachments: [...retained, ...files] } : {}),
  };
  if (files.length > 0) {
    attachmentUploadBatches.set(parsedBody, uploadBatchId);
  }
  return parsedBody;
}

function sendGatewayPayload(socket: WebSocket, payload: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function dispatchGatewayEvent(
  state: DiscordServerState,
  type: string,
  data: unknown,
  recipientUserIds?: ReadonlySet<string>,
  serializeForUser?: (data: unknown, user: DiscordUser) => unknown,
): void {
  const sequence = state.nextSequence++;
  let privateChannelOwner: string | undefined;
  if (isJsonObject(data)) {
    const channelId =
      typeof data.channel_id === "string"
        ? data.channel_id
        : type === "CHANNEL_CREATE" && typeof data.id === "string"
          ? data.id
          : undefined;
    if (channelId) {
      privateChannelOwner = state.privateChannelBotUsers.get(channelId);
    }
  }
  for (const client of state.gatewayClients) {
    if (
      client.identified &&
      client.user &&
      (!recipientUserIds || recipientUserIds.has(client.user.id)) &&
      (!privateChannelOwner || privateChannelOwner === client.user.id)
    ) {
      const payload = {
        d: serializeForUser ? serializeForUser(data, client.user) : data,
        op: 0,
        s: sequence,
        t: type,
      };
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

function dispatchMessageGatewayEvent(
  state: DiscordServerState,
  type: "MESSAGE_CREATE" | "MESSAGE_UPDATE",
  message: DiscordMessage,
): void {
  dispatchGatewayEvent(state, type, message, undefined, (_data, user) =>
    messageForUser(message, user, state),
  );
}

function recordGatewayEvent(state: DiscordServerState, body: unknown, accepted: boolean): void {
  void state.recorder.recordCommitted({
    accepted,
    at: new Date().toISOString(),
    body,
    method: "WS",
    path: "/gateway",
    query: {},
    type: "api",
  } as DiscordRecorderEvent);
}

function readyPayload(state: DiscordServerState, sessionId: string, user: DiscordUser) {
  return {
    application: { flags: 0, id: applicationIdForUser(state, user.id) },
    guilds: [...state.guilds.values()].map((guild) => ({ id: guild.id, unavailable: true })),
    resume_gateway_url: state.gatewayUrl!,
    session_id: sessionId,
    user,
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
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () =>
        socket.destroy(),
      );
      return;
    }
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
        const user = token ? discordUserForToken(token, params.state) : null;
        if (!token || !user) {
          socket.close(4_004, "Authentication failed");
          return;
        }
        clearTimeout(identifyTimeout);
        client.identified = true;
        client.user = user;
        client.sessionId = randomUUID();
        params.state.sessions.set(client.sessionId, {
          lastSequence: params.state.nextSequence,
          token,
          userId: user.id,
        });
        if (params.state.sessions.size > 128) {
          const oldestSessionId = params.state.sessions.keys().next().value as string | undefined;
          if (oldestSessionId) {
            params.state.sessions.delete(oldestSessionId);
          }
        }
        sendGatewayPayload(socket, {
          d: readyPayload(params.state, client.sessionId, user),
          op: 0,
          s: params.state.nextSequence++,
          t: "READY",
        });
        for (const guild of params.state.guilds.values()) {
          dispatchGatewayEvent(params.state, "GUILD_CREATE", guild, new Set([user.id]));
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
        const session = sessionId ? params.state.sessions.get(sessionId) : undefined;
        if (
          !token ||
          !sessionId ||
          !Number.isSafeInteger(payload.d.seq) ||
          (payload.d.seq as number) < 0 ||
          !session ||
          !constantTimeTokenEqual(token, session.token) ||
          payload.d.seq !== session.lastSequence
        ) {
          sendGatewayPayload(socket, { d: false, op: 9 });
          return;
        }
        clearTimeout(identifyTimeout);
        client.identified = true;
        client.user =
          session.userId === params.state.botUser.id
            ? params.state.botUser
            : params.state.driverBotUser;
        client.sessionId = sessionId;
        params.state.sessions.delete(sessionId);
        params.state.sessions.set(sessionId, session);
        const resumedSequence = params.state.nextSequence++;
        session.lastSequence = resumedSequence;
        sendGatewayPayload(socket, {
          d: {},
          op: 0,
          s: resumedSequence,
          t: "RESUMED",
        });
        return;
      }
      if (payload.op === 4) {
        if (!client.identified || !client.user || !isJsonObject(payload.d)) {
          socket.close(4_002, "Decode error");
          return;
        }
        let guildId: string;
        let channelId: string | null;
        try {
          guildId = requireSnowflake(payload.d.guild_id, "guild id");
          channelId =
            payload.d.channel_id === null
              ? null
              : requireSnowflake(payload.d.channel_id, "channel id");
        } catch {
          socket.close(4_002, "Decode error");
          return;
        }
        if (!params.state.guilds.has(guildId)) {
          socket.close(4_002, "Unknown guild");
          return;
        }
        const selectedChannel = channelId ? params.state.channels.get(channelId) : undefined;
        if (
          channelId &&
          (!selectedChannel || selectedChannel.guild_id !== guildId || selectedChannel.type !== 2)
        ) {
          socket.close(4_002, "Unknown voice channel");
          return;
        }
        const stateKey = voiceStateKey(guildId, client.user.id);
        const previous = params.state.voiceStates.get(stateKey);
        const previousSessionId = readTrimmedString(previous?.session_id);
        const previousSession = previousSessionId
          ? params.state.voiceSessions.get(previousSessionId)
          : undefined;
        const retainsVoiceSession =
          channelId !== null && previous?.channel_id === channelId && previousSession !== undefined;
        if (previousSessionId && !retainsVoiceSession) {
          params.state.voiceSessions.delete(previousSessionId);
          params.state.invalidateVoiceSession?.(previousSessionId);
        }
        const voiceSessionId = retainsVoiceSession ? previousSession.sessionId : randomUUID();
        const voiceToken = retainsVoiceSession
          ? previousSession.token
          : randomBytes(24).toString("base64url");
        const voiceState = {
          channel_id: channelId,
          deaf: previous?.deaf === true,
          guild_id: guildId,
          member: {
            deaf: false,
            joined_at: new Date().toISOString(),
            mute: false,
            pending: false,
            roles: [],
            user: client.user,
          },
          mute: previous?.mute === true,
          self_deaf: payload.d.self_deaf === true,
          self_mute: payload.d.self_mute === true,
          self_stream: false,
          self_video: false,
          session_id: voiceSessionId,
          suppress: false,
          user_id: client.user.id,
        };
        if (channelId) {
          params.state.voiceStates.set(stateKey, voiceState);
          params.state.voiceSessions.set(voiceSessionId, {
            guildId,
            sessionId: voiceSessionId,
            token: voiceToken,
            userId: client.user.id,
          });
        } else {
          params.state.voiceStates.delete(stateKey);
        }
        const guild = ensureGuild(params.state, guildId);
        guild.voice_states = [...params.state.voiceStates.values()].filter(
          (entry) => entry.guild_id === guildId,
        );
        dispatchGatewayEvent(params.state, "VOICE_STATE_UPDATE", voiceState);
        if (channelId && params.state.voiceEndpoint && !retainsVoiceSession) {
          dispatchGatewayEvent(
            params.state,
            "VOICE_SERVER_UPDATE",
            {
              endpoint: params.state.voiceEndpoint,
              guild_id: guildId,
              token: voiceToken,
            },
            new Set([client.user.id]),
          );
        }
        return;
      }
      if (payload.op === 3 || payload.op === 8) {
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
  applicationId: string,
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
    application_id: applicationId,
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
  const voiceChannelId =
    params.body.voiceChannelId === undefined
      ? undefined
      : requireSnowflake(params.body.voiceChannelId, "voiceChannelId");
  if (parentChannelId && !guildId) {
    throw new DiscordRequestError(400, 50_035, "Threads require guildId.");
  }
  const sender = discordUser(
    senderId,
    readTrimmedString(params.body.senderName) ?? `user-${senderId.slice(-6)}`,
  );
  const hadChannel = params.state.channels.has(requestedChannelId);
  const hadGuild = guildId ? params.state.guilds.has(guildId) : true;
  const directBotUserId = guildId
    ? undefined
    : [params.state.botUser, params.state.driverBotUser].find(
        (bot) => discordDirectChannelId(bot.id, sender.id) === requestedChannelId,
      )?.id;
  const channel = ensureChannel({
    ...(!guildId ? { botUserId: directBotUserId ?? params.state.botUser.id } : {}),
    channelId: requestedChannelId,
    ...(guildId ? { guildId } : {}),
    ...(parentChannelId ? { parentId: parentChannelId } : {}),
    sender,
    state: params.state,
  });
  if (guildId && voiceChannelId) {
    const voiceChannel = ensureChannel({ channelId: voiceChannelId, guildId, state: params.state });
    voiceChannel.name = "crabline-voice";
    voiceChannel.type = 2;
  }
  const message = createMessage({
    author: sender,
    body: params.body,
    channel,
    referenceAuthorizerId: directBotUserId ?? params.state.botUser.id,
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
  dispatchMessageGatewayEvent(params.state, "MESSAGE_CREATE", message);
  return discordJson({ event: { d: message, op: 0, t: "MESSAGE_CREATE" }, message });
}

async function handleDiscordApi(params: {
  authorizedUser: DiscordUser;
  body: unknown;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  state: DiscordServerState;
}): Promise<Response> {
  const pathParts = params.pathname.split("/").filter(Boolean);
  if (pathParts[0] !== "api" || pathParts[1] !== "v10") {
    return discordError(404, 0, "404: Not Found");
  }
  const route = pathParts.slice(2);
  if (params.method === "GET" && route.join("/") === "users/@me") {
    return discordJson(params.authorizedUser);
  }
  if (params.method === "GET" && route.join("/") === "oauth2/applications/@me") {
    const applicationId = applicationIdForUser(params.state, params.authorizedUser.id);
    return discordJson({
      bot: params.authorizedUser,
      flags: 0,
      id: applicationId,
      name: "Crabline Discord Application",
      owner: params.authorizedUser,
      verify_key: "crabline",
    });
  }
  if (params.method === "GET" && route.join("/") === "gateway") {
    return discordJson({ url: params.state.gatewayUrl });
  }
  if (params.method === "GET" && route.join("/") === "gateway/bot") {
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
    if (channel && !canAccessChannel(params.state, channel, params.authorizedUser.id)) {
      return discordError(404, 10_003, "Unknown Channel");
    }
    if (route.length === 2 && params.method === "GET") {
      return channel ? discordJson(channel) : discordError(404, 10_003, "Unknown Channel");
    }
    if (route.length === 2 && params.method === "PATCH") {
      if (!channel) {
        return discordError(404, 10_003, "Unknown Channel");
      }
      if (!isJsonObject(params.body)) {
        throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
      }
      if (typeof params.body.archived === "boolean") {
        if (!channel.thread_metadata) {
          return discordError(400, 50_035, "Channel is not a thread");
        }
        channel.thread_metadata.archived = params.body.archived;
        channel.thread_metadata.archive_timestamp = new Date().toISOString();
        dispatchGatewayEvent(params.state, "THREAD_UPDATE", channel);
      }
      return discordJson(channel);
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
          author: params.authorizedUser,
          body: params.body,
          channel,
          state: params.state,
        });
        dispatchMessageGatewayEvent(params.state, "MESSAGE_CREATE", message);
        return discordJson(messageForUser(message, params.authorizedUser, params.state));
      }
      if (route.length === 3 && params.method === "GET") {
        const after = params.searchParams.get("after");
        if (after) {
          requireSnowflake(after, "after");
        }
        const requestedLimit = Number(params.searchParams.get("limit") ?? "50");
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
          throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
        }
        return discordJson(
          [...(params.state.messages.get(channelId) ?? [])]
            .filter((message) => !after || BigInt(message.id) > BigInt(after))
            .reverse()
            .slice(0, requestedLimit)
            .map((message) => messageForUser(message, params.authorizedUser, params.state)),
        );
      }
      const messageId = route[3] ? requireSnowflake(route[3], "message id") : undefined;
      if (messageId && route[4] === "threads" && route.length === 5 && params.method === "POST") {
        const sourceMessage = findMessage(params.state, channelId, messageId);
        if (!sourceMessage) {
          return discordError(404, 10_008, "Unknown Message");
        }
        if (!channel.guild_id) {
          throw new DiscordRequestError(400, 50_035, "Threads require a guild channel.");
        }
        if (!isJsonObject(params.body)) {
          throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
        }
        if (params.state.channels.has(messageId)) {
          return discordError(400, 16_009, "A thread has already been created for this message");
        }
        const threadId = messageId;
        const thread = ensureChannel({
          channelId: threadId,
          guildId: channel.guild_id,
          parentId: channelId,
          state: params.state,
        });
        const threadName = readTrimmedString(params.body.name);
        if (threadName) {
          thread.name = threadName;
        }
        sourceMessage.thread = thread;
        params.state.threadMembers.set(threadId, new Set([params.authorizedUser.id]));
        dispatchMessageGatewayEvent(params.state, "MESSAGE_UPDATE", sourceMessage);
        dispatchGatewayEvent(params.state, "THREAD_CREATE", thread);
        return discordJson(thread, 201);
      }
      if (
        messageId &&
        route[4] === "reactions" &&
        route[5] &&
        route[6] === "@me" &&
        (params.method === "PUT" || params.method === "DELETE")
      ) {
        const message = findMessage(params.state, channelId, messageId);
        if (!message) {
          return discordError(404, 10_008, "Unknown Message");
        }
        const emoji = parseReactionEmoji(decodeURIComponent(route[5]));
        updateReaction({
          emoji,
          message,
          present: params.method === "PUT",
          state: params.state,
          userId: params.authorizedUser.id,
        });
        dispatchGatewayEvent(
          params.state,
          params.method === "PUT" ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE",
          {
            channel_id: channelId,
            emoji,
            ...(channel.guild_id ? { guild_id: channel.guild_id } : {}),
            message_id: messageId,
            user_id: params.authorizedUser.id,
          },
        );
        return discordEmpty();
      }
      if (messageId && route.length === 4 && params.method === "PATCH") {
        const message = findMessage(params.state, channelId, messageId);
        if (!message) {
          return discordError(404, 10_008, "Unknown Message");
        }
        if (!isJsonObject(params.body)) {
          throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
        }
        if (message.author.id !== params.authorizedUser.id) {
          return discordError(403, 50_013, "Missing Permissions");
        }
        updateMessage({ body: params.body, message, state: params.state });
        dispatchMessageGatewayEvent(params.state, "MESSAGE_UPDATE", message);
        return discordJson(messageForUser(message, params.authorizedUser, params.state));
      }
      if (messageId && route.length === 4 && params.method === "DELETE") {
        const message = removeMessage(params.state, channelId, messageId);
        if (!message) {
          return discordError(404, 10_008, "Unknown Message");
        }
        dispatchGatewayEvent(params.state, "MESSAGE_DELETE", {
          channel_id: channelId,
          ...(channel.guild_id ? { guild_id: channel.guild_id } : {}),
          id: messageId,
        });
        return discordEmpty();
      }
      if (messageId && params.method === "GET") {
        const message = findMessage(params.state, channelId, messageId);
        return message
          ? discordJson(messageForUser(message, params.authorizedUser, params.state))
          : discordError(404, 10_008, "Unknown Message");
      }
    }
    if (
      route[2] === "thread-members" &&
      route[3] === "@me" &&
      route.length === 4 &&
      params.method === "PUT"
    ) {
      if (channel?.type !== 11 || !channel.thread_metadata) {
        return discordError(404, 10_003, "Unknown Channel");
      }
      if (channel.thread_metadata.archived) {
        return discordError(403, 50_013, "Missing Permissions");
      }
      const members = params.state.threadMembers.get(channel.id) ?? new Set<string>();
      members.add(params.authorizedUser.id);
      params.state.threadMembers.set(channel.id, members);
      const joinedAt = new Date().toISOString();
      dispatchGatewayEvent(
        params.state,
        "THREAD_CREATE",
        channel,
        new Set([params.authorizedUser.id]),
      );
      dispatchGatewayEvent(params.state, "THREAD_MEMBERS_UPDATE", {
        added_members: [
          {
            flags: 0,
            join_timestamp: joinedAt,
            user_id: params.authorizedUser.id,
          },
        ],
        guild_id: channel.guild_id,
        id: channel.id,
        member_count: members.size,
        removed_member_ids: [],
      });
      return discordEmpty();
    }
  }
  if (params.method === "POST" && route.join("/") === "users/@me/channels") {
    if (!isJsonObject(params.body)) {
      throw new InvalidJsonBodyError(undefined, "Request body must be a JSON object.");
    }
    const recipientId = requireSnowflake(params.body.recipient_id, "recipient_id");
    const recipient = discordUser(recipientId, `user-${recipientId.slice(-6)}`);
    const channelId = discordDirectChannelId(params.authorizedUser.id, recipientId);
    return discordJson(
      ensureChannel({
        botUserId: params.authorizedUser.id,
        channelId,
        sender: recipient,
        state: params.state,
      }),
    );
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
          : userId === params.state.driverBotUser.id
            ? params.state.driverBotUser
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
    if (
      route[2] === "voice-states" &&
      route[3] === "@me" &&
      route.length === 4 &&
      params.method === "GET"
    ) {
      const state = params.state.voiceStates.get(voiceStateKey(guildId, params.authorizedUser.id));
      return state ? discordJson(state) : discordError(404, 10_065, "Unknown Voice State");
    }
  }
  if (route[0] === "applications" && route[1]) {
    const applicationId = applicationIdForUser(params.state, params.authorizedUser.id);
    if (route[1] !== applicationId) {
      return discordError(403, 50_013, "Missing Permissions");
    }
    let commandOffset = 2;
    let guildId: string | undefined;
    if (route[2] === "guilds" && route[3] && route[4] === "commands") {
      guildId = requireSnowflake(route[3], "guild id");
      commandOffset = 4;
    }
    if (route[commandOffset] === "commands") {
      const commandStore = guildId ? params.state.guildCommands : params.state.commands;
      const commandStoreKey = guildId ? `${applicationId}:${guildId}` : applicationId;
      const commands = commandStore.get(commandStoreKey) ?? new Map<string, DiscordCommand>();
      if (!commandStore.has(commandStoreKey)) {
        commandStore.set(commandStoreKey, commands);
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
          const command = commandBody(params.state, applicationId, body, undefined, guildId);
          commands.set(command.id, command);
        }
        return discordJson([...commands.values()]);
      }
      if (!commandId && params.method === "POST") {
        if (!isJsonObject(params.body)) {
          throw new DiscordRequestError(400, 50_035, "Invalid Form Body");
        }
        const name = readTrimmedString(params.body.name);
        const type = typeof params.body.type === "number" ? params.body.type : 1;
        const existing = [...commands.values()].find(
          (command) => command.name === name && command.type === type,
        );
        const command = commandBody(params.state, applicationId, params.body, existing, guildId);
        commands.set(command.id, command);
        return discordJson(command, existing ? 200 : 201);
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
          const command = commandBody(params.state, applicationId, params.body, existing, guildId);
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
  const attachmentMatch = /^\/attachments\/(\d{17,20})\/([^/]+)$/u.exec(url.pathname);
  if (method === "GET" && attachmentMatch) {
    const attachment = params.state.attachments.get(attachmentMatch[1]!);
    let filename: string | undefined;
    try {
      filename = decodeURIComponent(attachmentMatch[2]!);
    } catch {
      filename = undefined;
    }
    const capability = url.searchParams.get("sig") ?? "";
    const expiresAt = url.searchParams.get("ex") ?? "";
    const authorized = Boolean(
      attachment &&
      filename === attachment.filename &&
      expiresAt === String(attachment.expiresAt) &&
      Date.now() <= attachment.expiresAt &&
      constantTimeTokenEqual(attachment.capability, capability),
    );
    return attachment && authorized
      ? new Response(attachment.bytes, {
          headers: {
            "content-disposition": attachmentContentDisposition(attachment.filename),
            "content-type": attachment.contentType,
          },
        })
      : new Response("not found", { status: 404 });
  }
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
    await params.state.recorder.recordCommitted(event);
    return response;
  }
  const authError =
    method === "GET" && url.pathname === "/api/v10/gateway"
      ? null
      : authorizationError(params.request, params.state);
  if (authError) {
    params.request.resume();
    return authError;
  }
  const body =
    method === "GET" || method === "DELETE"
      ? {}
      : await parseDiscordRequestBody(params.request, params.state);
  const event: DiscordRecorderEvent = {
    at: new Date().toISOString(),
    ...(isJsonObject(body) && Object.keys(body).length > 0 ? { body } : {}),
    method,
    path: url.pathname,
    query: queryRecord(url),
    type: "api",
  };
  const response = await handleDiscordApi({
    authorizedUser: authorizedDiscordUser(params.request, params.state) ?? params.state.botUser,
    body,
    method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    state: params.state,
  });
  event.accepted = response.ok;
  await (response.ok
    ? params.state.recorder.recordCommitted(event)
    : params.state.recorder.record(event));
  return response;
}

export async function startDiscordServer(
  params: StartDiscordServerParams = {},
): Promise<StartedDiscordServer> {
  const host = params.host ?? "127.0.0.1";
  const applicationId = params.applicationId ?? "135000000000000001";
  const botUserId = params.botUserId ?? applicationId;
  const driverBotUserId = params.driverBotUserId ?? "135000000000000002";
  const driverApplicationId = driverBotUserId;
  const fixtureGuildId = params.fixtureGuildId ?? "135000000000000011";
  const fixtureChannelId = params.fixtureChannelId ?? "135000000000000010";
  const fixtureVoiceChannelId = params.fixtureVoiceChannelId ?? "135000000000000013";
  requireSnowflake(applicationId, "applicationId");
  requireSnowflake(botUserId, "botUserId");
  requireSnowflake(driverBotUserId, "driverBotUserId");
  requireSnowflake(fixtureGuildId, "fixtureGuildId");
  requireSnowflake(fixtureChannelId, "fixtureChannelId");
  requireSnowflake(fixtureVoiceChannelId, "fixtureVoiceChannelId");
  const encodedApplicationId = Buffer.from(applicationId, "utf8").toString("base64url");
  const externallyBound = !isLoopbackHost(host);
  const recorderPath = params.recorderPath ?? path.resolve(".crabline", "servers", "discord.jsonl");
  const state: DiscordServerState = {
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    applicationId,
    attachmentUrlTtlMs: positiveInteger(
      params.attachmentUrlTtlMs,
      DEFAULT_ATTACHMENT_URL_TTL_MS,
      "attachmentUrlTtlMs",
    ),
    attachments: new Map(),
    botToken:
      params.botToken ??
      (externallyBound
        ? `${encodedApplicationId}.${randomBytes(6).toString("base64url")}.${randomBytes(24).toString("base64url")}`
        : `${encodedApplicationId}.crabline.discord`),
    botUser: discordUser(botUserId, params.botUsername ?? "crabline", true),
    driverBotToken:
      params.driverBotToken ??
      (externallyBound
        ? `${Buffer.from(driverBotUserId, "utf8").toString("base64url")}.${randomBytes(6).toString("base64url")}.${randomBytes(24).toString("base64url")}`
        : `${Buffer.from(driverBotUserId, "utf8").toString("base64url")}.crabline.discord`),
    driverBotUser: discordUser(
      driverBotUserId,
      params.driverBotUsername ?? "crabline-driver",
      true,
    ),
    driverApplicationId,
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
    reactionActors: new Map(),
    privateChannelBotUsers: new Map(),
    recorder: createServerRecorder({ recorderPath, onEvent: params.onEvent }),
    recorderPath,
    sessions: new Map(),
    threadMembers: new Map(),
    voiceStates: new Map(),
    voiceSessions: new Map(),
  };
  ensureGuild(state, fixtureGuildId);
  ensureChannel({ channelId: fixtureChannelId, guildId: fixtureGuildId, state });
  const fixtureVoiceChannel = ensureChannel({
    channelId: fixtureVoiceChannelId,
    guildId: fixtureGuildId,
    state,
  });
  fixtureVoiceChannel.name = "crabline-voice";
  fixtureVoiceChannel.type = 2;
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
  state.baseUrl = httpServer.baseUrl;
  state.gatewayUrl = `${httpServer.baseUrl.replace(/^http/u, "ws")}/gateway`;
  let voiceServer: Awaited<ReturnType<typeof startDiscordVoiceServer>>;
  try {
    voiceServer = await startDiscordVoiceServer({
      authorize: (session) => {
        const active = state.voiceSessions.get(session.sessionId);
        return (
          active !== undefined &&
          active.guildId === session.guildId &&
          (!session.userId || active.userId === session.userId) &&
          constantTimeTokenEqual(active.token, session.token)
        );
      },
      host,
      recorder: state.recorder,
    });
  } catch (error) {
    await httpServer.close();
    throw error;
  }
  state.voiceEndpoint = voiceServer.endpoint;
  state.invalidateVoiceSession = (sessionId) => voiceServer.invalidateSession(sessionId);
  const closeGateway = attachGatewayServer({ server: httpServer.server, state });
  return {
    close: createServerClose(
      state.recorder,
      async () => {
        try {
          await closeGateway();
        } finally {
          try {
            await voiceServer.close();
          } finally {
            state.sessions.clear();
          }
        }
      },
      () => httpServer.close(),
    ),
    manifest: {
      adminToken: state.adminToken,
      applicationId: state.applicationId,
      baseUrl: httpServer.baseUrl,
      botToken: state.botToken,
      botUserId: state.botUser.id,
      driverBotToken: state.driverBotToken,
      driverBotUserId: state.driverBotUser.id,
      driverApplicationId: state.driverApplicationId,
      fixture: {
        channelId: fixtureChannelId,
        guildId: fixtureGuildId,
        voiceChannelId: fixtureVoiceChannelId,
      },
      endpoints: {
        adminInboundUrl: `${httpServer.baseUrl}/crabline/discord/inbound`,
        apiRoot: `${httpServer.baseUrl}/api`,
        gatewayBotUrl: `${httpServer.baseUrl}/api/v10/gateway/bot`,
        gatewayUrl: state.gatewayUrl,
        voiceCaCertificate: voiceServer.caCertificate,
        voiceEndpoint: voiceServer.endpoint,
      },
      env: { DISCORD_BOT_TOKEN: state.botToken },
      provider: "discord",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
