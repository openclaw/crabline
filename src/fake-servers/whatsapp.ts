import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  adminAuthError,
  hasAdminToken,
  jsonResponse,
  parseRequestBody,
  queryRecord,
  readTrimmedString,
  startHttpJsonServer,
  type FakeServerRequestEvent,
} from "./http.js";
import {
  attachWhatsAppBaileysWebSocketServer,
  type WhatsAppBaileysInboundMessage,
} from "./whatsapp-baileys-websocket.js";

const WHATSAPP_USER_JID_RE = /^\d{7,15}(?::\d+)?@s\.whatsapp\.net$/iu;
const WHATSAPP_LEGACY_USER_JID_RE = /^\d{7,15}@c\.us$/iu;
const WHATSAPP_GROUP_JID_RE = /^\d{5,}@g\.us$/iu;
const WHATSAPP_LID_RE = /^\d{7,15}@lid$/iu;

type WhatsAppFakeServerState = {
  accessToken: string;
  adminToken: string;
  apiRoot: string;
  displayPhoneNumber: string;
  deliverInboundMessage(message: WhatsAppBaileysInboundMessage): void;
  nextMessageId: number;
  phoneNumberId: string;
  recorderPath: string;
  selfJid: string;
};

export type WhatsAppBaileysMessage = WhatsAppBaileysInboundMessage;

export type WhatsAppFakeServerManifest = {
  accessToken: string;
  adminToken: string;
  baseUrl: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    baileysWebSocketUrl: string;
    messagesUrl: string;
    presenceUrl: string;
  };
  env: {
    CRABLINE_WHATSAPP_ADMIN_TOKEN: string;
    CRABLINE_WHATSAPP_ACCESS_TOKEN: string;
    CRABLINE_WHATSAPP_API_ROOT: string;
    CRABLINE_WHATSAPP_BAILEYS_WEB_SOCKET_URL: string;
    CRABLINE_WHATSAPP_RECORDER_PATH: string;
    CRABLINE_WHATSAPP_SELF_JID: string;
  };
  provider: "whatsapp";
  recorderPath: string;
  selfJid: string;
  version: 1;
};

export type StartedWhatsAppFakeServer = {
  close(): Promise<void>;
  manifest: WhatsAppFakeServerManifest;
};

export type StartWhatsAppFakeServerParams = {
  accessToken?: string | undefined;
  adminToken?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
  selfJid?: string | undefined;
};

type WhatsAppAdminInboundResult = {
  message?: WhatsAppBaileysMessage | undefined;
  response: Response;
};

type WhatsAppRecorderEvent = FakeServerRequestEvent & {
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
      ok: false,
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

async function appendEvent(state: WhatsAppFakeServerState, event: FakeServerRequestEvent) {
  await fs.mkdir(path.dirname(state.recorderPath), { recursive: true });
  await fs.appendFile(state.recorderPath, `${JSON.stringify(event)}\n`, "utf8");
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

function requireAuth(request: IncomingMessage, state: WhatsAppFakeServerState): boolean {
  const authorization = request.headers.authorization;
  return (
    typeof authorization === "string" && authorization.trim() === `Bearer ${state.accessToken}`
  );
}

function nextMessageId(state: WhatsAppFakeServerState): string {
  return `wamid.FAKE${String(state.nextMessageId++).padStart(8, "0")}`;
}

function waIdFromJid(jid: string): string {
  return jid.split("@", 1)[0]?.split(":", 1)[0] ?? jid;
}

function requireMessagingProduct(body: Record<string, unknown>): Response | undefined {
  const messagingProduct = readTrimmedString(body.messaging_product);
  if (messagingProduct && messagingProduct !== "whatsapp") {
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
  const textBody =
    textPayload && typeof textPayload === "object"
      ? readTrimmedString((textPayload as Record<string, unknown>).body)
      : readTrimmedString(textPayload);
  const content = body.content;
  const contentText =
    content && typeof content === "object"
      ? readTrimmedString((content as Record<string, unknown>).text)
      : undefined;
  const text = textBody ?? contentText;
  if (!text) {
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
  state: WhatsAppFakeServerState;
}): Promise<Response> {
  const productError = requireMessagingProduct(params.body);
  if (productError) {
    return productError;
  }
  const to = requireWhatsAppJid(params.body.to ?? params.body.jid, "to");
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
    remoteJid: to,
    text,
  });
  const waId = waIdFromJid(to);
  return whatsappOk({
    contacts: [
      {
        input: to,
        wa_id: waId,
      },
    ],
    key: message.key,
    message,
    messageId: message.key.id,
    messages: [{ id: message.key.id }],
    messaging_product: "whatsapp",
    toJid: to,
  });
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: WhatsAppFakeServerState;
}): Promise<WhatsAppAdminInboundResult> {
  const chatJid = requireWhatsAppJid(params.body.chatJid ?? params.body.chatId, "chatJid");
  if (chatJid instanceof Response) {
    return { response: chatJid };
  }
  const senderJid = requireWhatsAppJid(params.body.senderJid ?? params.body.from, "senderJid");
  if (senderJid instanceof Response) {
    return { response: senderJid };
  }
  const text = readTrimmedString(params.body.text);
  if (!text) {
    return {
      response: graphParameterError(
        "(#100) Missing required parameter: text",
        "An inbound WhatsApp fake event requires text.",
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
  return { message, response: whatsappOk({ message, webhook }) };
}

async function handleRequest(params: { request: IncomingMessage; state: WhatsAppFakeServerState }) {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/crabline/whatsapp/health") {
    return whatsappOk({ selfJid: params.state.selfJid });
  }

  if (url.pathname === "/crabline/whatsapp/inbound") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      return adminAuthError();
    }
    const body = await parseRequestBody(params.request);
    const result = await handleAdminInbound({ body, state: params.state });
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
      params.state.deliverInboundMessage(result.message);
    }
    return result.response;
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

  if (!requireAuth(params.request, params.state)) {
    return graphAuthError();
  }
  if (url.pathname === "/crabline/whatsapp/messages") {
    if (params.request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    return await handleSendMessage({ body, state: params.state });
  }
  if (url.pathname === "/crabline/whatsapp/presence") {
    const presence = readTrimmedString(body.presence) ?? "composing";
    if (!["available", "composing", "paused", "unavailable"].includes(presence)) {
      return graphParameterError(
        "(#100) Invalid parameter: presence",
        "presence must be available, composing, paused, or unavailable.",
      );
    }
    return whatsappOk({ presence });
  }
  return new Response("not found", { status: 404 });
}

export async function startWhatsAppFakeServer(
  params: StartWhatsAppFakeServerParams = {},
): Promise<StartedWhatsAppFakeServer> {
  const state: WhatsAppFakeServerState = {
    accessToken: params.accessToken ?? "crabline-whatsapp-access-token",
    adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
    apiRoot: "",
    deliverInboundMessage: () => undefined,
    displayPhoneNumber: "15550000000",
    nextMessageId: 1,
    phoneNumberId: "TEST_PHONE_NUMBER_ID",
    recorderPath:
      params.recorderPath ?? path.resolve(".crabline", "fake-servers", "whatsapp.jsonl"),
    selfJid: params.selfJid ?? "15550000000@s.whatsapp.net",
  };
  const host = params.host ?? "127.0.0.1";
  const httpServer = await startHttpJsonServer({
    handle: (request) => handleRequest({ request, state }),
    host,
    port: params.port ?? 0,
    serverName: "WhatsApp",
  });
  const baseUrl = httpServer.baseUrl;
  const apiRoot = `${baseUrl}/crabline/whatsapp`;
  const baileysWebSocketUrl = `${baseUrl.replace(/^http/u, "ws")}/crabline/whatsapp/ws/chat`;
  state.apiRoot = apiRoot;
  const baileysWebSocketServer = attachWhatsAppBaileysWebSocketServer({
    appendEvent: (event) => appendEvent(state, event),
    httpServer: httpServer.server,
    path: "/crabline/whatsapp/ws/chat",
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
        adminInboundUrl: `${apiRoot}/inbound`,
        apiRoot,
        baileysWebSocketUrl,
        messagesUrl: `${apiRoot}/messages`,
        presenceUrl: `${apiRoot}/presence`,
      },
      env: {
        CRABLINE_WHATSAPP_ADMIN_TOKEN: state.adminToken,
        CRABLINE_WHATSAPP_ACCESS_TOKEN: state.accessToken,
        CRABLINE_WHATSAPP_API_ROOT: apiRoot,
        CRABLINE_WHATSAPP_BAILEYS_WEB_SOCKET_URL: baileysWebSocketUrl,
        CRABLINE_WHATSAPP_RECORDER_PATH: state.recorderPath,
        CRABLINE_WHATSAPP_SELF_JID: state.selfJid,
      },
      provider: "whatsapp",
      recorderPath: state.recorderPath,
      selfJid: state.selfJid,
      version: 1,
    },
  };
}
