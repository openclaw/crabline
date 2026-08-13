import type { IncomingMessage } from "node:http";
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import path from "node:path";
import {
  adminAuthError,
  constantTimeTokenEqual,
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
import {
  recordServerEvent,
  ServerRecorderCommittedError,
  type ServerEventObserver,
} from "./recorder.js";
import {
  attachWhatsAppBaileysWebSocketServer,
  resolveMaxPendingWhatsAppInboundMessages,
  type PreparedWhatsAppBaileysInboundDelivery,
  type WhatsAppBaileysInboundMessage,
} from "./whatsapp-baileys-websocket.js";
import {
  canonicalizeWhatsAppChatJid,
  canonicalizeWhatsAppUserCorrelationJid,
  canonicalizeWhatsAppUserJid,
  isWhatsAppGroupJid,
} from "./whatsapp-jid.js";

const WHATSAPP_CLOUD_RECIPIENT_RE = /^\d{7,15}$/u;
const WHATSAPP_GRAPH_VERSION_RE = /^v\d+\.\d+$/u;
const WHATSAPP_GENERATED_MESSAGE_ID_RE = /^wamid\.FAKE(\d{8,})$/u;
const DEFAULT_GRAPH_VERSION = "v25.0";
const MAX_WHATSAPP_READABLE_MESSAGE_IDS = 10_000;
const MAX_WHATSAPP_RECENT_MESSAGE_IDS = 10_000;
const MAX_WHATSAPP_MESSAGE_ID_BYTES = 128;
const MAX_WHATSAPP_TEXT_MESSAGE_CHARACTERS = 4_096;
const MAX_WHATSAPP_MEDIA_FIXTURES = 1_000;
const MAX_WHATSAPP_MEDIA_BYTES = 16 * 1024 * 1024;
const WHATSAPP_MEDIA_TTL_MS = 5 * 60 * 1_000;
const WHATSAPP_MEDIA_DOWNLOAD_GRACE_MS = 30 * 1_000;

function createDefaultAccessToken(): string {
  return `EAA${randomBytes(24).toString("base64url")}`;
}

type WhatsAppServerState = {
  accessToken: string;
  adminToken: string;
  baseUrl: string;
  displayPhoneNumber: string;
  prepareInboundMessage(
    message: WhatsAppBaileysInboundMessage,
  ): PreparedWhatsAppBaileysInboundDelivery | undefined;
  graphVersion: string;
  inboundMessageIds: Set<string>;
  mediaByPath: Map<string, { content: Buffer; expiresAt: number; mimeType: string }>;
  mediaBytes: number;
  pendingMessageIds: Set<string>;
  recentMessageIds: Map<string, true>;
  nextMessageId: bigint;
  onEvent: ServerEventObserver | undefined;
  phoneNumberId: string;
  recorderPath: string;
  selfJid: string;
};

export type WhatsAppBaileysMessage = WhatsAppBaileysInboundMessage;

export type WhatsAppServerManifest = {
  accessToken: string;
  adminToken: string;
  baseUrl: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    baileysWebSocketUrl: string;
    messagesUrl: string;
    phoneNumberUrl: string;
  };
  env: {
    CLOUD_API_ACCESS_TOKEN: string;
    CLOUD_API_VERSION: string;
    WA_BASE_URL: string;
    WA_PHONE_NUMBER_ID: string;
  };
  graphVersion: string;
  phoneNumberId: string;
  provider: "whatsapp";
  recorderPath: string;
  selfJid: string;
  version: 1;
};

export type StartedWhatsAppServer = {
  close(): Promise<void>;
  manifest: WhatsAppServerManifest;
};

export type StartWhatsAppServerParams = {
  accessToken?: string | undefined;
  adminToken?: string | undefined;
  displayPhoneNumber?: string | undefined;
  graphVersion?: string | undefined;
  host?: string | undefined;
  maxPendingInboundMessages?: number | undefined;
  messageAcceptanceTimeoutMs?: number | undefined;
  onEvent?: ServerEventObserver | undefined;
  phoneNumberId?: string | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  selfJid?: string | undefined;
};

type WhatsAppAdminInboundResult = {
  mediaFixture?: WhatsAppMediaFixture | undefined;
  message?: WhatsAppBaileysMessage | undefined;
  messageIdReservation?: WhatsAppMessageIdReservation | undefined;
  response?: Response | undefined;
  webhook?: Record<string, unknown> | undefined;
};

type WhatsAppRecorderEvent = ServerRequestEvent & {
  accepted?: boolean | undefined;
  message?: WhatsAppBaileysMessage | undefined;
};

function whatsappOk(value: Record<string, unknown> = {}): Response {
  return jsonResponse({ ok: true, ...value });
}

function graphError(params: {
  code?: number | undefined;
  details?: string | undefined;
  message: string;
  status?: number | undefined;
  type?: string | undefined;
}): Response {
  return jsonResponse(
    {
      error: {
        code: params.code ?? 100,
        ...(params.details
          ? {
              error_data: {
                details: params.details,
                messaging_product: "whatsapp",
              },
            }
          : {}),
        fbtrace_id: "A1B2C3D4E5F",
        message: params.message,
        type: params.type ?? "OAuthException",
      },
    },
    params.status ?? 400,
  );
}

function graphParameterError(message: string, details?: string): Response {
  return graphError({ code: 100, details, message, status: 400 });
}

function graphAuthError(): Response {
  return graphError({
    code: 190,
    message: "Invalid OAuth access token.",
    status: 401,
  });
}

async function appendEvent(state: WhatsAppServerState, event: WhatsAppRecorderEvent) {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function requireWhatsAppChatJid(value: unknown): string | Response {
  const stringValue = readTrimmedString(value);
  const canonical = stringValue ? canonicalizeWhatsAppChatJid(stringValue) : undefined;
  if (!canonical) {
    return graphParameterError(
      "(#100) Invalid parameter: chatJid",
      "chatJid must be a WhatsApp user or group JID.",
    );
  }
  return canonical;
}

function requireWhatsAppSenderJid(value: unknown): string | Response {
  const stringValue = readTrimmedString(value);
  const canonical = stringValue ? canonicalizeWhatsAppUserJid(stringValue) : undefined;
  if (!canonical) {
    return graphParameterError(
      "(#100) Invalid parameter: senderJid",
      "senderJid must be a WhatsApp user JID.",
    );
  }
  return canonical;
}

function requireCloudRecipient(value: unknown): string | Response {
  const recipient = readTrimmedString(value);
  if (!recipient || !WHATSAPP_CLOUD_RECIPIENT_RE.test(recipient)) {
    return graphParameterError(
      "(#100) Invalid parameter: to",
      "to must be a WhatsApp phone number in international format without punctuation.",
    );
  }
  return recipient;
}

function requireAuth(request: IncomingMessage, state: WhatsAppServerState): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return false;
  }
  const match = /^Bearer +(.+)$/iu.exec(authorization.trimStart());
  const providedToken = match?.[1];
  return providedToken ? constantTimeTokenEqual(providedToken, state.accessToken) : false;
}

type WhatsAppMessageIdReservation = {
  cancel(): void;
  commit(): void;
  id: string;
};

/** @internal */
export function isWhatsAppMessageIdInUse(
  state: {
    inboundMessageIds: ReadonlySet<string>;
    pendingMessageIds: ReadonlySet<string>;
    recentMessageIds: ReadonlyMap<string, true>;
  },
  id: string,
): boolean {
  return (
    state.inboundMessageIds.has(id) ||
    state.pendingMessageIds.has(id) ||
    state.recentMessageIds.has(id)
  );
}

function reserveMessageId(
  state: WhatsAppServerState,
  requestedId?: string,
): WhatsAppMessageIdReservation | Response {
  let id = requestedId;
  if (id) {
    if (Buffer.byteLength(id, "utf8") > MAX_WHATSAPP_MESSAGE_ID_BYTES) {
      return graphParameterError(
        "(#100) Invalid parameter: messageId",
        `messageId must not exceed ${MAX_WHATSAPP_MESSAGE_ID_BYTES} UTF-8 bytes.`,
      );
    }
    if (isWhatsAppMessageIdInUse(state, id)) {
      return graphParameterError(
        "(#100) Invalid parameter: messageId",
        "messageId must be unique within this WhatsApp server.",
      );
    }
  } else {
    do {
      id = `wamid.FAKE${String(state.nextMessageId++).padStart(8, "0")}`;
    } while (isWhatsAppMessageIdInUse(state, id));
  }
  state.pendingMessageIds.add(id);
  let settled = false;
  return {
    cancel() {
      if (!settled) {
        settled = true;
        state.pendingMessageIds.delete(id);
      }
    },
    commit() {
      if (settled) {
        return;
      }
      settled = true;
      state.pendingMessageIds.delete(id);
      state.recentMessageIds.delete(id);
      state.recentMessageIds.set(id, true);
      if (state.recentMessageIds.size > MAX_WHATSAPP_RECENT_MESSAGE_IDS) {
        const oldestId = state.recentMessageIds.keys().next().value;
        if (oldestId !== undefined) {
          state.recentMessageIds.delete(oldestId);
        }
      }
      const generatedSequence = WHATSAPP_GENERATED_MESSAGE_ID_RE.exec(id)?.[1];
      if (generatedSequence) {
        const sequence = BigInt(generatedSequence);
        if (sequence >= state.nextMessageId) {
          state.nextMessageId = sequence + 1n;
        }
      }
    },
    id,
  };
}

function waIdFromJid(jid: string): string {
  const correlationJid = canonicalizeWhatsAppUserCorrelationJid(jid);
  return correlationJid?.split("@", 1)[0] ?? jid;
}

function directPeerIdentity(jid: string): string {
  return canonicalizeWhatsAppUserCorrelationJid(jid) ?? jid;
}

function requireMessagingProduct(body: Record<string, unknown>): Response | undefined {
  const messagingProduct = readTrimmedString(body.messaging_product);
  if (messagingProduct !== "whatsapp") {
    return graphParameterError(
      "(#100) Invalid parameter: messaging_product",
      'messaging_product must be "whatsapp".',
    );
  }
  return undefined;
}

function readTextMessageBody(body: Record<string, unknown>): string | Response {
  const type = readTrimmedString(body.type);
  if (!type) {
    return graphParameterError(
      "(#100) Missing required parameter: type",
      'A WhatsApp text send requires type to be "text".',
    );
  }
  if (type !== "text") {
    return graphParameterError(
      "(#100) Unsupported message type",
      "This test API currently supports WhatsApp text message sends.",
    );
  }
  const textPayload = body.text;
  const text =
    textPayload && typeof textPayload === "object"
      ? readMessageText((textPayload as Record<string, unknown>).body)
      : undefined;
  if (text === undefined) {
    return graphParameterError(
      "(#100) Missing required parameter: text.body",
      "A WhatsApp text send requires text.body.",
    );
  }
  if ([...text].length > MAX_WHATSAPP_TEXT_MESSAGE_CHARACTERS) {
    return graphParameterError(
      "(#100) Invalid parameter: text.body",
      `text.body must not exceed ${MAX_WHATSAPP_TEXT_MESSAGE_CHARACTERS} characters.`,
    );
  }
  return text;
}

function createWhatsAppMessage(params: {
  fromMe: boolean;
  id: string;
  pushName?: string | undefined;
  remoteJid: string;
  senderJid?: string | undefined;
  text: string;
}) {
  return {
    key: {
      fromMe: params.fromMe,
      id: params.id,
      ...(params.senderJid ? { participant: params.senderJid } : {}),
      remoteJid: params.remoteJid,
    },
    message: {
      conversation: params.text,
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: params.pushName ?? (params.fromMe ? "Test Bot" : "Test User"),
  };
}

type WhatsAppAdminAudio = {
  content: Buffer;
  mimeType: string;
  ptt: boolean;
};

type WhatsAppMediaFixture = {
  content: Buffer;
  mimeType: string;
  path: string;
};

function readAdminAudio(value: unknown): WhatsAppAdminAudio | Response | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    return graphParameterError(
      "(#100) Invalid parameter: audio",
      "audio must be an object containing inline base64 content and an audio MIME type.",
    );
  }
  const contentBase64 = typeof value.contentBase64 === "string" ? value.contentBase64 : undefined;
  if (
    !contentBase64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(contentBase64)
  ) {
    return graphParameterError(
      "(#100) Invalid parameter: audio.contentBase64",
      "audio.contentBase64 must contain non-empty canonical base64.",
    );
  }
  const mimeType = readTrimmedString(value.mimeType);
  if (!mimeType?.toLowerCase().startsWith("audio/")) {
    return graphParameterError(
      "(#100) Invalid parameter: audio.mimeType",
      "audio.mimeType must be an audio MIME type.",
    );
  }
  if (value.ptt !== undefined && typeof value.ptt !== "boolean") {
    return graphParameterError(
      "(#100) Invalid parameter: audio.ptt",
      "audio.ptt must be a boolean when provided.",
    );
  }
  const content = Buffer.from(contentBase64, "base64");
  if (content.byteLength === 0 || content.toString("base64") !== contentBase64) {
    return graphParameterError(
      "(#100) Invalid parameter: audio.contentBase64",
      "audio.contentBase64 must decode to non-empty content.",
    );
  }
  return { content, mimeType, ptt: value.ptt ?? false };
}

function createWhatsAppAudioFixture(params: {
  audio: WhatsAppAdminAudio;
  messageId: string;
  state: WhatsAppServerState;
}) {
  const mediaKey = randomBytes(32);
  const expandedKey = Buffer.from(
    hkdfSync("sha256", mediaKey, Buffer.alloc(32), Buffer.from("WhatsApp Audio Keys", "utf8"), 112),
  );
  const iv = expandedKey.subarray(0, 16);
  const cipherKey = expandedKey.subarray(16, 48);
  const macKey = expandedKey.subarray(48, 80);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(params.audio.content), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  const encrypted = Buffer.concat([ciphertext, mac]);
  const mediaCapability = randomBytes(32).toString("base64url");
  const encodedMessageId = Buffer.from(params.messageId, "utf8").toString("base64url");
  const mediaPath = `/_crabline/media/whatsapp/${encodedMessageId}/${mediaCapability}`;
  return {
    audioMessage: {
      fileEncSha256: createHash("sha256").update(encrypted).digest(),
      fileLength: params.audio.content.byteLength,
      fileSha256: createHash("sha256").update(params.audio.content).digest(),
      mediaKey,
      mediaKeyTimestamp: Math.floor(Date.now() / 1_000),
      mimetype: params.audio.mimeType,
      ptt: params.audio.ptt,
      url: `${params.state.baseUrl}${mediaPath}`,
    },
    mediaFixture: {
      content: encrypted,
      mimeType: "application/octet-stream",
      path: mediaPath,
    },
  };
}

function removeWhatsAppMedia(state: WhatsAppServerState, mediaPath: string): void {
  const fixture = state.mediaByPath.get(mediaPath);
  if (!fixture) {
    return;
  }
  state.mediaByPath.delete(mediaPath);
  state.mediaBytes -= fixture.content.byteLength;
}

function purgeExpiredWhatsAppMedia(state: WhatsAppServerState, now = Date.now()): void {
  for (const [mediaPath, fixture] of state.mediaByPath) {
    if (fixture.expiresAt <= now) {
      removeWhatsAppMedia(state, mediaPath);
    }
  }
}

function reserveWhatsAppMedia(state: WhatsAppServerState, fixture: WhatsAppMediaFixture): boolean {
  purgeExpiredWhatsAppMedia(state);
  if (
    state.mediaByPath.size >= MAX_WHATSAPP_MEDIA_FIXTURES ||
    state.mediaBytes + fixture.content.byteLength > MAX_WHATSAPP_MEDIA_BYTES
  ) {
    return false;
  }
  state.mediaByPath.set(fixture.path, {
    content: fixture.content,
    expiresAt: Date.now() + WHATSAPP_MEDIA_TTL_MS,
    mimeType: fixture.mimeType,
  });
  state.mediaBytes += fixture.content.byteLength;
  return true;
}

type PreparedWhatsAppSend = {
  commit(): Response;
};

function prepareSendMessage(params: {
  body: Record<string, unknown>;
  state: WhatsAppServerState;
}): PreparedWhatsAppSend | Response {
  const productError = requireMessagingProduct(params.body);
  if (productError) {
    return productError;
  }
  const recipientType = readTrimmedString(params.body.recipient_type);
  if (recipientType && recipientType !== "individual") {
    return graphParameterError(
      "(#100) Invalid parameter: recipient_type",
      'recipient_type must be "individual".',
    );
  }
  const to = requireCloudRecipient(params.body.to);
  if (to instanceof Response) {
    return to;
  }
  const text = readTextMessageBody(params.body);
  if (text instanceof Response) {
    return text;
  }
  return {
    commit() {
      const reservation = reserveMessageId(params.state);
      if (reservation instanceof Response) {
        return reservation;
      }
      reservation.commit();
      const message = createWhatsAppMessage({
        fromMe: true,
        id: reservation.id,
        remoteJid: `${to}@s.whatsapp.net`,
        text,
      });
      return jsonResponse({
        contacts: [
          {
            input: to,
            wa_id: to,
          },
        ],
        messages: [{ id: message.key.id }],
        messaging_product: "whatsapp",
      });
    },
  };
}

function handleMessageStatus(state: WhatsAppServerState, body: Record<string, unknown>): Response {
  const productError = requireMessagingProduct(body);
  if (productError) {
    return productError;
  }
  if (readTrimmedString(body.status) !== "read") {
    return graphParameterError(
      "(#100) Invalid parameter: status",
      'status must be "read" for message status updates.',
    );
  }
  const messageId = readTrimmedString(body.message_id);
  if (!messageId) {
    return graphParameterError(
      "(#100) Missing required parameter: message_id",
      "A message status update requires message_id.",
    );
  }
  if (!state.inboundMessageIds.has(messageId)) {
    return graphParameterError(
      "(#100) Invalid parameter: message_id",
      "message_id must reference an accepted inbound message.",
    );
  }
  return jsonResponse({ success: true });
}

function rememberInboundMessageId(state: WhatsAppServerState, messageId: string): void {
  state.inboundMessageIds.delete(messageId);
  state.inboundMessageIds.add(messageId);
  if (state.inboundMessageIds.size > MAX_WHATSAPP_READABLE_MESSAGE_IDS) {
    const oldest = state.inboundMessageIds.values().next().value;
    if (oldest !== undefined) {
      state.inboundMessageIds.delete(oldest);
    }
  }
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: WhatsAppServerState;
}): Promise<WhatsAppAdminInboundResult> {
  const chatJid = requireWhatsAppChatJid(params.body.chatJid ?? params.body.chatId);
  if (chatJid instanceof Response) {
    return { response: chatJid };
  }
  const senderJid = requireWhatsAppSenderJid(params.body.senderJid ?? params.body.from);
  if (senderJid instanceof Response) {
    return { response: senderJid };
  }
  if (directPeerIdentity(senderJid) === directPeerIdentity(params.state.selfJid)) {
    return {
      response: graphParameterError(
        "(#100) Invalid parameter: senderJid",
        "senderJid must not identify the configured WhatsApp self identity.",
      ),
    };
  }
  const isGroupChat = isWhatsAppGroupJid(chatJid);
  if (!isGroupChat && directPeerIdentity(chatJid) !== directPeerIdentity(senderJid)) {
    return {
      response: graphParameterError(
        "(#100) Invalid parameter: senderJid",
        "senderJid must identify the direct chat peer.",
      ),
    };
  }
  const text = readMessageText(params.body.text);
  const audio = readAdminAudio(params.body.audio);
  if (audio instanceof Response) {
    return { response: audio };
  }
  if ((text === undefined) === (audio === undefined)) {
    return {
      response: graphParameterError(
        "(#100) Invalid inbound WhatsApp event",
        "An inbound WhatsApp event requires exactly one of text or audio.",
      ),
    };
  }
  const messageIdReservation = reserveMessageId(
    params.state,
    readTrimmedString(params.body.messageId),
  );
  if (messageIdReservation instanceof Response) {
    return { response: messageIdReservation };
  }
  const messageBase = {
    key: {
      fromMe: false,
      id: messageIdReservation.id,
      ...(isGroupChat ? { participant: senderJid } : {}),
      remoteJid: isGroupChat ? chatJid : directPeerIdentity(chatJid),
    },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    pushName: readTrimmedString(params.body.pushName) ?? "Test User",
  };
  const audioFixture = audio
    ? createWhatsAppAudioFixture({ audio, messageId: messageIdReservation.id, state: params.state })
    : undefined;
  const message: WhatsAppBaileysMessage = text
    ? createWhatsAppMessage({
        fromMe: false,
        id: messageIdReservation.id,
        pushName: messageBase.pushName,
        remoteJid: messageBase.key.remoteJid,
        senderJid: isGroupChat ? senderJid : undefined,
        text,
      })
    : {
        ...messageBase,
        message: { audioMessage: audioFixture!.audioMessage },
      };
  const timestamp = String(message.messageTimestamp);
  const webhook = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [
                {
                  profile: { name: readTrimmedString(params.body.pushName) ?? "Test User" },
                  wa_id: waIdFromJid(senderJid),
                },
              ],
              messages: [
                {
                  from: waIdFromJid(senderJid),
                  id: message.key.id,
                  ...(text
                    ? { text: { body: text }, type: "text" }
                    : {
                        audio: {
                          id: message.key.id,
                          mime_type: audio!.mimeType,
                        },
                        type: "audio",
                      }),
                  timestamp,
                },
              ],
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: params.state.displayPhoneNumber,
                phone_number_id: params.state.phoneNumberId,
              },
            },
          },
        ],
        id: "TEST_WABA",
      },
    ],
    object: "whatsapp_business_account",
  };
  return {
    mediaFixture: audioFixture?.mediaFixture,
    message,
    messageIdReservation,
    webhook,
  };
}

async function handleRequest(params: { request: IncomingMessage; state: WhatsAppServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");

  if (url.pathname.startsWith("/_crabline/media/whatsapp/")) {
    if (params.request.method !== "GET") {
      drainRequestBody(params.request);
      return new Response("not found", { status: 404 });
    }
    purgeExpiredWhatsAppMedia(params.state);
    const fixture = params.state.mediaByPath.get(url.pathname);
    if (fixture) {
      fixture.expiresAt = Math.min(
        fixture.expiresAt,
        Date.now() + WHATSAPP_MEDIA_DOWNLOAD_GRACE_MS,
      );
    }
    return fixture
      ? new Response(new Uint8Array(fixture.content), {
          headers: { "content-type": fixture.mimeType },
        })
      : new Response("not found", { status: 404 });
  }

  if (url.pathname === "/_crabline/admin/whatsapp/inbound") {
    if (params.request.method !== "POST") {
      drainRequestBody(params.request);
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      drainRequestBody(params.request);
      return adminAuthError();
    }
    const body = await parseUnknownRequestBody(params.request);
    if (!isJsonObject(body)) {
      return graphParameterError(
        "(#100) Invalid parameter: request body",
        "The request body must be a JSON object.",
      );
    }
    const result = await handleAdminInbound({ body, state: params.state });
    if (result.response) {
      return result.response;
    }
    const event: WhatsAppRecorderEvent = {
      at: new Date().toISOString(),
      body,
      method: params.request.method,
      path: url.pathname,
      query: queryRecord(url),
      type: "admin",
    };
    const preparedDelivery = result.message
      ? params.state.prepareInboundMessage(result.message)
      : undefined;
    if (result.message && !preparedDelivery) {
      result.messageIdReservation?.cancel();
      return graphError({
        code: 4,
        details: "The pending WhatsApp inbound queue is full.",
        message: "(#4) Application request limit reached.",
        status: 503,
        type: "OAuthException",
      });
    }
    if (result.mediaFixture && !reserveWhatsAppMedia(params.state, result.mediaFixture)) {
      preparedDelivery?.cancel();
      result.messageIdReservation?.cancel();
      return graphError({
        code: 4,
        details: "The WhatsApp media fixture capacity is full.",
        message: "(#4) Application request limit reached.",
        status: 503,
        type: "OAuthException",
      });
    }
    if (result.message) {
      event.message = result.message;
    }
    try {
      await appendEvent(params.state, event);
    } catch (error) {
      if (!(error instanceof ServerRecorderCommittedError)) {
        preparedDelivery?.cancel();
        if (result.mediaFixture) {
          removeWhatsAppMedia(params.state, result.mediaFixture.path);
        }
        result.messageIdReservation?.cancel();
        throw error;
      }
      result.messageIdReservation?.commit();
      if (result.message && preparedDelivery) {
        try {
          await preparedDelivery.commit();
          rememberInboundMessageId(params.state, result.message.key.id);
        } catch (deliveryError) {
          const reconciliationError = new AggregateError(
            [error, deliveryError],
            "WhatsApp recorder append committed, but inbound delivery reconciliation failed.",
          );
          reconciliationError.cause = deliveryError;
          throw reconciliationError;
        }
      }
      throw error;
    }
    if (result.message && preparedDelivery) {
      try {
        const delivery = await preparedDelivery.commit();
        result.messageIdReservation?.commit();
        rememberInboundMessageId(params.state, result.message.key.id);
        return whatsappOk({ delivery, message: result.message, webhook: result.webhook });
      } catch (error) {
        if (result.mediaFixture) {
          removeWhatsAppMedia(params.state, result.mediaFixture.path);
        }
        result.messageIdReservation?.cancel();
        throw error;
      }
    }
    if (result.mediaFixture) {
      removeWhatsAppMedia(params.state, result.mediaFixture.path);
    }
    result.messageIdReservation?.cancel();
    return graphParameterError("(#100) Invalid inbound WhatsApp event");
  }

  const phoneNumberPath = `/${params.state.graphVersion}/${params.state.phoneNumberId}`;
  const messagesPath = `${phoneNumberPath}/messages`;
  if (!requireAuth(params.request, params.state)) {
    drainRequestBody(params.request);
    return graphAuthError();
  }
  if (url.pathname === phoneNumberPath && params.request.method === "GET") {
    const body = queryRecord(url);
    await appendEvent(params.state, {
      accepted: true,
      at: new Date().toISOString(),
      body,
      method: params.request.method,
      path: url.pathname,
      query: body,
      type: "api",
    });
    return jsonResponse({
      display_phone_number: params.state.displayPhoneNumber,
      id: params.state.phoneNumberId,
      quality_rating: "GREEN",
      verified_name: "Crabline Test Bot",
    });
  }
  if (url.pathname === messagesPath) {
    if (params.request.method !== "POST") {
      drainRequestBody(params.request);
      return new Response("not found", { status: 404 });
    }
    const body = await parseUnknownRequestBody(params.request);
    const event: WhatsAppRecorderEvent = {
      at: new Date().toISOString(),
      body,
      method: params.request.method,
      path: url.pathname,
      query: queryRecord(url),
      type: "api",
    };
    let response: Response;
    if (!isJsonObject(body)) {
      response = graphParameterError(
        "(#100) Invalid parameter: request body",
        "The request body must be a JSON object.",
      );
    } else if ("status" in body || "message_id" in body) {
      response = handleMessageStatus(params.state, body);
      event.accepted = response.ok;
    } else {
      const prepared = prepareSendMessage({ body, state: params.state });
      if (!(prepared instanceof Response)) {
        response = prepared.commit();
        event.accepted = true;
        await appendEvent(params.state, event);
        return response;
      }
      response = prepared;
    }
    event.accepted ??= false;
    await appendEvent(params.state, event);
    return response;
  }
  drainRequestBody(params.request);
  return new Response("not found", { status: 404 });
}

export async function startWhatsAppServer(
  params: StartWhatsAppServerParams = {},
): Promise<StartedWhatsAppServer> {
  const host = params.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      "WhatsApp server requires a loopback host because its HTTP and WebSocket endpoints carry credentials over cleartext.",
    );
  }
  if (
    params.accessToken !== undefined &&
    (!params.accessToken.trim() || params.accessToken !== params.accessToken.trim())
  ) {
    throw new Error("WhatsApp accessToken must not be empty or whitespace-padded.");
  }
  if (
    params.adminToken !== undefined &&
    (!params.adminToken.trim() || params.adminToken !== params.adminToken.trim())
  ) {
    throw new Error("WhatsApp adminToken must not be empty or whitespace-padded.");
  }
  const graphVersion = params.graphVersion ?? DEFAULT_GRAPH_VERSION;
  if (!WHATSAPP_GRAPH_VERSION_RE.test(graphVersion)) {
    throw new Error(`Invalid WhatsApp Graph API version: ${graphVersion}.`);
  }
  const phoneNumberId = params.phoneNumberId ?? "100000000000000";
  if (!/^\d+$/u.test(phoneNumberId)) {
    throw new Error("WhatsApp phoneNumberId must contain only digits.");
  }
  const maxPendingInboundMessages = resolveMaxPendingWhatsAppInboundMessages(
    params.maxPendingInboundMessages,
  );
  const selfJid = canonicalizeWhatsAppUserJid(params.selfJid ?? "15550000000@s.whatsapp.net");
  if (!selfJid) {
    throw new Error("WhatsApp selfJid must be a WhatsApp user JID.");
  }
  const state: WhatsAppServerState = {
    accessToken: params.accessToken ?? createDefaultAccessToken(),
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    baseUrl: "",
    prepareInboundMessage: () => undefined,
    displayPhoneNumber: params.displayPhoneNumber ?? "15550000000",
    graphVersion,
    inboundMessageIds: new Set(),
    mediaByPath: new Map(),
    mediaBytes: 0,
    pendingMessageIds: new Set(),
    recentMessageIds: new Map(),
    nextMessageId: 1n,
    onEvent: params.onEvent,
    phoneNumberId,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "whatsapp.jsonl"),
    selfJid,
  };
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest({ request, state }),
    handleError: (error) => {
      if (error instanceof InvalidJsonBodyError) {
        return graphParameterError(
          "(#100) Invalid parameter: request body",
          "The request body must be valid JSON.",
        );
      }
      if (error instanceof RequestBodyTooLargeError) {
        return graphError({
          code: 100,
          details: "The request body exceeds the supported size limit.",
          message: "(#100) Request body is too large.",
          status: 413,
        });
      }
      return undefined;
    },
    host,
    port: params.port ?? 0,
    serverName: "WhatsApp",
  });
  const baseUrl = httpServer.baseUrl;
  state.baseUrl = baseUrl;
  const apiRoot = `${baseUrl}/${state.graphVersion}`;
  const phoneNumberUrl = `${apiRoot}/${state.phoneNumberId}`;
  const messagesUrl = `${phoneNumberUrl}/messages`;
  const baileysWebSocketUrl = `${baseUrl.replace(
    /^http/u,
    "ws",
  )}/ws/chat?access_token=${encodeURIComponent(state.accessToken)}`;
  const baileysWebSocketOptions = {
    accessToken: state.accessToken,
    appendEvent: (event: ServerRequestEvent) => appendEvent(state, event),
    httpServer: httpServer.server,
    maxPendingInboundMessages,
    messageAcceptanceTimeoutMs: params.messageAcceptanceTimeoutMs,
    path: "/ws/chat",
    selfJid: state.selfJid,
  };
  let baileysWebSocketServer;
  try {
    baileysWebSocketServer = attachWhatsAppBaileysWebSocketServer(baileysWebSocketOptions);
  } catch (error) {
    try {
      await httpServer.close();
    } catch (closeError) {
      const aggregateError = new AggregateError(
        [error, closeError],
        "WhatsApp WebSocket startup failed and HTTP rollback also failed.",
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  }
  state.prepareInboundMessage = (message) => baileysWebSocketServer.prepareInboundMessage(message);
  return {
    async close() {
      const results = await Promise.allSettled([
        baileysWebSocketServer.close(),
        httpServer.close(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      state.mediaByPath.clear();
      state.mediaBytes = 0;
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "WhatsApp server shutdown failed.");
      }
    },
    manifest: {
      accessToken: state.accessToken,
      adminToken: state.adminToken,
      baseUrl,
      endpoints: {
        adminInboundUrl: `${baseUrl}/_crabline/admin/whatsapp/inbound`,
        apiRoot,
        baileysWebSocketUrl,
        messagesUrl,
        phoneNumberUrl,
      },
      env: {
        CLOUD_API_ACCESS_TOKEN: state.accessToken,
        CLOUD_API_VERSION: state.graphVersion,
        WA_BASE_URL: baseUrl,
        WA_PHONE_NUMBER_ID: state.phoneNumberId,
      },
      graphVersion: state.graphVersion,
      phoneNumberId: state.phoneNumberId,
      provider: "whatsapp",
      recorderPath: state.recorderPath,
      selfJid: state.selfJid,
      version: 1,
    },
  };
}

function readMessageText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
