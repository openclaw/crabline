import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  adminAuthError,
  hasAdminToken,
  InvalidJsonBodyError,
  jsonResponse,
  parseRequestBody,
  queryRecord,
  readTrimmedString,
  startHttpJsonServer,
  type ServerRequestEvent,
} from "./http.js";
import { recordServerEvent, type ServerEventObserver } from "./recorder.js";
import {
  attachWhatsAppBaileysWebSocketServer,
  type WhatsAppBaileysInboundMessage,
} from "./whatsapp-baileys-websocket.js";

const WHATSAPP_USER_JID_RE = /^\d{7,15}(?::\d+)?@s\.whatsapp\.net$/iu;
const WHATSAPP_LEGACY_USER_JID_RE = /^\d{7,15}@c\.us$/iu;
const WHATSAPP_GROUP_JID_RE = /^\d{5,}@g\.us$/iu;
const WHATSAPP_LID_RE = /^\d{7,15}@lid$/iu;
const WHATSAPP_CLOUD_RECIPIENT_RE = /^\d{7,15}$/u;
const WHATSAPP_GRAPH_VERSION_RE = /^v\d+\.\d+$/u;
const DEFAULT_GRAPH_VERSION = "v25.0";

type WhatsAppServerState = {
  accessToken: string;
  adminToken: string;
  displayPhoneNumber: string;
  deliverInboundMessage(message: WhatsAppBaileysInboundMessage): "delivered" | "queued";
  graphVersion: string;
  nextMessageId: number;
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
    statusUrl: string;
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
  onEvent?: ServerEventObserver | undefined;
  phoneNumberId?: string | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  selfJid?: string | undefined;
};

type WhatsAppAdminInboundResult = {
  message?: WhatsAppBaileysMessage | undefined;
  response?: Response | undefined;
  webhook?: Record<string, unknown> | undefined;
};

type WhatsAppRecorderEvent = ServerRequestEvent & {
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function appendEvent(state: WhatsAppServerState, event: ServerRequestEvent) {
  await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}

function isWhatsAppJid(value: string): boolean {
  return (
    WHATSAPP_USER_JID_RE.test(value) ||
    WHATSAPP_LEGACY_USER_JID_RE.test(value) ||
    WHATSAPP_GROUP_JID_RE.test(value) ||
    WHATSAPP_LID_RE.test(value)
  );
}

function requireWhatsAppJid(value: unknown, label: string): string | Response {
  const stringValue = readTrimmedString(value);
  if (!stringValue || !isWhatsAppJid(stringValue)) {
    return graphParameterError(
      `(#100) Invalid parameter: ${label}`,
      `${label} must be a WhatsApp JID such as 15551234567@s.whatsapp.net or 120363001234567890@g.us.`,
    );
  }
  return stringValue;
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
  return (
    typeof authorization === "string" && authorization.trim() === `Bearer ${state.accessToken}`
  );
}

function nextMessageId(state: WhatsAppServerState): string {
  return `wamid.FAKE${String(state.nextMessageId++).padStart(8, "0")}`;
}

function waIdFromJid(jid: string): string {
  return jid.split("@", 1)[0]?.split(":", 1)[0] ?? jid;
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
  if (type && type !== "text") {
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

async function handleSendMessage(params: {
  body: Record<string, unknown>;
  state: WhatsAppServerState;
}): Promise<Response> {
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
  const message = createWhatsAppMessage({
    fromMe: true,
    id: nextMessageId(params.state),
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
}

function handleMessageStatus(body: Record<string, unknown>): Response {
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
  if (!readTrimmedString(body.message_id)) {
    return graphParameterError(
      "(#100) Missing required parameter: message_id",
      "A message status update requires message_id.",
    );
  }
  return jsonResponse({ success: true });
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: WhatsAppServerState;
}): Promise<WhatsAppAdminInboundResult> {
  const chatJid = requireWhatsAppJid(params.body.chatJid ?? params.body.chatId, "chatJid");
  if (chatJid instanceof Response) {
    return { response: chatJid };
  }
  const senderJid = requireWhatsAppJid(params.body.senderJid ?? params.body.from, "senderJid");
  if (senderJid instanceof Response) {
    return { response: senderJid };
  }
  const text = readMessageText(params.body.text);
  if (text === undefined) {
    return {
      response: graphParameterError(
        "(#100) Missing required parameter: text",
        "An inbound WhatsApp event requires text.",
      ),
    };
  }
  const message = createWhatsAppMessage({
    fromMe: false,
    id: readTrimmedString(params.body.messageId) ?? nextMessageId(params.state),
    pushName: readTrimmedString(params.body.pushName) ?? "Test User",
    remoteJid: chatJid,
    senderJid,
    text,
  });
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
                  text: { body: text },
                  timestamp,
                  type: "text",
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
  return { message, webhook };
}

async function handleRequest(params: { request: IncomingMessage; state: WhatsAppServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/_crabline/admin/whatsapp/inbound") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      return adminAuthError();
    }
    const body = await parseRequestBody(params.request);
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
    if (result.message) {
      event.message = result.message;
    }
    await appendEvent(params.state, event);
    if (result.message) {
      const delivery = params.state.deliverInboundMessage(result.message);
      return whatsappOk({ delivery, message: result.message, webhook: result.webhook });
    }
    return graphParameterError("(#100) Invalid inbound WhatsApp event");
  }

  const phoneNumberPath = `/${params.state.graphVersion}/${params.state.phoneNumberId}`;
  const messagesPath = `${phoneNumberPath}/messages`;
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

  if (!requireAuth(params.request, params.state)) {
    return graphAuthError();
  }
  if (url.pathname === phoneNumberPath && params.request.method === "GET") {
    return jsonResponse({
      display_phone_number: params.state.displayPhoneNumber,
      id: params.state.phoneNumberId,
      quality_rating: "GREEN",
      verified_name: "Crabline Test Bot",
    });
  }
  if (url.pathname === messagesPath) {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!isJsonObject(body)) {
      return graphParameterError(
        "(#100) Invalid parameter: request body",
        "The request body must be a JSON object.",
      );
    }
    if ("status" in body || "message_id" in body) {
      return handleMessageStatus(body);
    }
    return await handleSendMessage({ body, state: params.state });
  }
  return new Response("not found", { status: 404 });
}

export async function startWhatsAppServer(
  params: StartWhatsAppServerParams = {},
): Promise<StartedWhatsAppServer> {
  const graphVersion = params.graphVersion ?? DEFAULT_GRAPH_VERSION;
  if (!WHATSAPP_GRAPH_VERSION_RE.test(graphVersion)) {
    throw new Error(`Invalid WhatsApp Graph API version: ${graphVersion}.`);
  }
  const phoneNumberId = params.phoneNumberId ?? "100000000000000";
  if (!/^\d+$/u.test(phoneNumberId)) {
    throw new Error("WhatsApp phoneNumberId must contain only digits.");
  }
  const state: WhatsAppServerState = {
    accessToken: params.accessToken ?? "crabline-whatsapp-access-token",
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    deliverInboundMessage: () => "queued",
    displayPhoneNumber: params.displayPhoneNumber ?? "15550000000",
    graphVersion,
    nextMessageId: 1,
    onEvent: params.onEvent,
    phoneNumberId,
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "whatsapp.jsonl"),
    selfJid: params.selfJid ?? "15550000000@s.whatsapp.net",
  };
  const host = params.host ?? "127.0.0.1";
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest({ request, state }),
    handleError: (error) =>
      error instanceof InvalidJsonBodyError
        ? graphParameterError(
            "(#100) Invalid parameter: request body",
            "The request body must be valid JSON.",
          )
        : undefined,
    host,
    port: params.port ?? 0,
    serverName: "WhatsApp",
  });
  const baseUrl = httpServer.baseUrl;
  const apiRoot = `${baseUrl}/${state.graphVersion}`;
  const phoneNumberUrl = `${apiRoot}/${state.phoneNumberId}`;
  const messagesUrl = `${phoneNumberUrl}/messages`;
  const baileysWebSocketUrl = `${baseUrl.replace(
    /^http/u,
    "ws",
  )}/ws/chat?access_token=${encodeURIComponent(state.accessToken)}`;
  const baileysWebSocketServer = attachWhatsAppBaileysWebSocketServer({
    accessToken: state.accessToken,
    appendEvent: (event) => appendEvent(state, event),
    httpServer: httpServer.server,
    path: "/ws/chat",
    selfJid: state.selfJid,
  });
  state.deliverInboundMessage = (message) => baileysWebSocketServer.deliverInboundMessage(message);
  return {
    async close() {
      await baileysWebSocketServer.close();
      await httpServer.close();
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
        statusUrl: messagesUrl,
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
