import type { CrablineServerManifest } from "../servers/index.js";
import { canonicalizeWhatsAppChatCorrelationJid } from "../servers/whatsapp-jid.js";
import { isRecord, readNonBlankString } from "./shared.js";

const MATRIX_SEND_PATH_RE =
  /^\/_matrix\/client\/(?:v3|r0)\/rooms\/[^/]+\/send\/m\.room\.message\/[^/]+$/u;
const TELEGRAM_SEND_PATH_RE =
  /^\/bot<redacted>\/(?:sendAnimation|sendAudio|sendDocument|sendMessage|sendPhoto|sendVideo)$/iu;
const ZALO_SEND_PATH_RE = /^\/bot<redacted>\/(?:sendMessage|sendPhoto)$/u;

export function isAcceptedOpenClawCrablineOutbound(params: {
  event: unknown;
  manifest: CrablineServerManifest;
}): boolean {
  if (!isRecord(params.event) || params.event.type !== "api" || params.event.accepted !== true) {
    return false;
  }
  const method = readNonBlankString(params.event.method);
  const requestPath = readNonBlankString(params.event.path);
  if (!method || !requestPath) {
    return false;
  }

  switch (params.manifest.provider) {
    case "mattermost":
      return method === "POST" && requestPath === "/api/v4/posts";
    case "matrix":
      return method === "PUT" && MATRIX_SEND_PATH_RE.test(requestPath);
    case "signal":
      return method === "POST" && requestPath === "/api/v1/rpc";
    case "slack":
      return method === "POST" && requestPath === "/api/chat.postMessage";
    case "telegram":
      return (method === "GET" || method === "POST") && TELEGRAM_SEND_PATH_RE.test(requestPath);
    case "whatsapp": {
      const messagesPath = new URL(params.manifest.endpoints.messagesUrl).pathname;
      const body = isRecord(params.event.body) ? params.event.body : undefined;
      const key = isRecord(body?.key) ? body.key : undefined;
      const webSocketTarget = canonicalizeWhatsAppChatCorrelationJid(
        readNonBlankString(key?.remoteJid) ?? "",
      );
      return (
        (method === "POST" && requestPath === messagesPath) ||
        (method === "WEBSOCKET" && requestPath === "/ws/chat" && webSocketTarget !== undefined)
      );
    }
    case "zalo":
      return (method === "GET" || method === "POST") && ZALO_SEND_PATH_RE.test(requestPath);
  }
}
