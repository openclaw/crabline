import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";
import {
  canonicalizeWhatsAppChatCorrelationJid,
  canonicalizeWhatsAppChatJid,
  canonicalizeWhatsAppUserCorrelationJid,
  canonicalizeWhatsAppUserJid,
} from "../../servers/whatsapp-jid.js";

function requireWhatsAppJid(value: string, label: string, userOnly = false): string {
  const canonical = userOnly
    ? canonicalizeWhatsAppUserJid(value)
    : canonicalizeWhatsAppChatJid(value);
  if (!canonical) {
    throw new Error(`${label} must be a native WhatsApp JID.`);
  }
  return canonical;
}

function requireWhatsAppTargetKind(
  parsed: { kind: "direct" | "group"; native: boolean },
  targetId: string,
): void {
  if (parsed.native) {
    return;
  }
  const nativeKind = targetId.endsWith("@g.us") ? "group" : "direct";
  if (parsed.kind !== nativeKind) {
    throw new Error("WhatsApp target kind does not match the native JID.");
  }
}

function requireWhatsAppConversationKind(kind: "direct" | "group", targetId: string): void {
  const nativeKind = targetId.endsWith("@g.us") ? "group" : "direct";
  if (kind !== nativeKind) {
    throw new Error("WhatsApp inbound conversation kind does not match the native JID.");
  }
}

export const WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "whatsapp",
  createAdapter(whatsapp) {
    const messagesPath = new URL(whatsapp.endpoints.messagesUrl).pathname;
    return {
      async probe(signal) {
        const response = await fetch(whatsapp.endpoints.phoneNumberUrl, {
          headers: {
            authorization: `Bearer ${whatsapp.accessToken}`,
          },
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          throw new Error(`Crabline WhatsApp probe failed with HTTP ${response.status}.`);
        }
        const payload: unknown = await response.json();
        if (!isRecord(payload) || readString(payload.id) !== whatsapp.phoneNumberId) {
          throw new Error("Crabline WhatsApp probe returned an unexpected phone number.");
        }
        return payload;
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "whatsapp",
          createChannelDriverSmokeEnv: (env) => ({
            ...env,
            CRABLINE_WHATSAPP_ADMIN_TOKEN: whatsapp.adminToken,
            CRABLINE_WHATSAPP_RECORDER_PATH: whatsapp.recorderPath,
            CRABLINE_WHATSAPP_SELF_JID: whatsapp.selfJid,
            OPENCLAW_WHATSAPP_WEB_SOCKET_URL: whatsapp.endpoints.baileysWebSocketUrl,
          }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const whatsappConfig = isRecord(channels.whatsapp) ? channels.whatsapp : {};
            const groups = isRecord(whatsappConfig.groups) ? whatsappConfig.groups : {};
            const defaultGroup = isRecord(groups["*"]) ? groups["*"] : {};

            return {
              ...openclawConfig,
              channels: {
                ...channels,
                whatsapp: {
                  ...whatsappConfig,
                  enabled: true,
                  dmPolicy: "open",
                  groupPolicy: "open",
                  allowFrom: ["*"],
                  groupAllowFrom: ["*"],
                  groups: {
                    ...groups,
                    "*": {
                      ...defaultGroup,
                      requireMention: false,
                    },
                  },
                },
              },
            };
          },
          requiredPluginIds: ["whatsapp"],
        };
      },
      createAgentDelivery(parsed) {
        if (parsed.threadId !== undefined) {
          throw new Error("WhatsApp does not support thread targets.");
        }
        const nativeTo = requireWhatsAppJid(parsed.id, "WhatsApp target");
        requireWhatsAppTargetKind(parsed, nativeTo);
        if (nativeTo.endsWith("@g.us")) {
          throw new Error("WhatsApp Crabline WebSocket outbound supports direct targets only.");
        }
        const to = canonicalizeWhatsAppUserCorrelationJid(nativeTo)!;
        return {
          channel: "whatsapp",
          to,
          replyChannel: "whatsapp",
          replyTo: to,
        };
      },
      createInbound(input) {
        if (input.threadId !== undefined) {
          throw new Error("WhatsApp does not support thread targets.");
        }
        const nativeChatJid = requireWhatsAppJid(input.conversation.id, "WhatsApp conversation");
        requireWhatsAppConversationKind(input.conversation.kind, nativeChatJid);
        const nativeSenderJid = requireWhatsAppJid(input.senderId, "WhatsApp sender", true);
        const providerTargetKey = canonicalizeWhatsAppChatCorrelationJid(nativeChatJid)!;
        if (
          input.conversation.kind === "direct" &&
          canonicalizeWhatsAppUserCorrelationJid(nativeChatJid) !==
            canonicalizeWhatsAppUserCorrelationJid(nativeSenderJid)
        ) {
          throw new Error(
            "WhatsApp direct conversation and sender must identify the same recipient.",
          );
        }
        return {
          ...createAdminInboundRequest(whatsapp),
          providerBody: {
            chatJid: nativeChatJid,
            senderJid: nativeSenderJid,
            ...(input.senderName ? { pushName: input.senderName } : {}),
            text: input.text,
          },
          providerTargetKey,
          qaTarget: qaTargetForInbound({
            ...input,
            conversation: { ...input.conversation, id: providerTargetKey },
          }),
          stateConversation: {
            id: nativeChatJid,
            kind: nativeChatJid.endsWith("@g.us") ? "group" : "direct",
          },
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (
          !isRecord(event) ||
          event.type !== "api" ||
          event.accepted !== true ||
          typeof event.path !== "string"
        ) {
          return null;
        }
        if (!isRecord(event.body)) {
          return null;
        }
        const baileysKey = isRecord(event.body.key) ? event.body.key : undefined;
        const baileysMessage = isRecord(event.body.message) ? event.body.message : undefined;
        const isBaileysSend = event.method === "WEBSOCKET" && event.path === "/ws/chat";
        const messagingProduct = readString(event.body.messaging_product);
        const messageType = readString(event.body.type);
        const isCloudTextSend =
          event.method === "POST" &&
          event.path === messagesPath &&
          (messagingProduct === undefined || messagingProduct === "whatsapp") &&
          (messageType === undefined || messageType === "text") &&
          !("status" in event.body) &&
          !("message_id" in event.body);
        if (!isBaileysSend && !isCloudTextSend) {
          return null;
        }
        const to = isBaileysSend ? readString(baileysKey?.remoteJid) : readString(event.body.to);
        const textPayload = event.body.text;
        const text = isBaileysSend
          ? readNonBlankString(baileysMessage?.conversation)
          : isRecord(textPayload)
            ? readNonBlankString(textPayload.body)
            : undefined;
        if (!to || !text) {
          return null;
        }
        const providerTarget = isBaileysSend
          ? canonicalizeWhatsAppUserCorrelationJid(to)
          : (canonicalizeWhatsAppChatJid(to) ??
            (/^\d{7,15}$/u.test(to) ? `${to}@s.whatsapp.net` : to));
        if (!providerTarget) {
          return null;
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: "openclaw",
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(providerTarget) ?? providerTarget,
        };
      },
    };
  },
});
