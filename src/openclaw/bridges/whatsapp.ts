import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readString,
} from "../shared.js";

const WHATSAPP_JID_RE =
  /^(?:\d{7,15}(?::\d+)?@s\.whatsapp\.net|\d{7,15}@c\.us|\d{5,}@g\.us|\d{7,15}@lid)$/iu;

function requireWhatsAppJid(value: string, label: string): string {
  const trimmed = value.trim();
  if (!WHATSAPP_JID_RE.test(trimmed)) {
    throw new Error(`${label} must be a native WhatsApp JID.`);
  }
  return trimmed;
}

export const WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "whatsapp",
  createAdapter(whatsapp) {
    return {
      async probe() {
        const response = await fetch(`${whatsapp.endpoints.apiRoot}/health`);
        if (!response.ok) {
          throw new Error(`Crabline WhatsApp health probe failed with HTTP ${response.status}.`);
        }
        return await response.json();
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
        const to = requireWhatsAppJid(parsed.id, "WhatsApp target");
        return {
          channel: "whatsapp",
          to,
          replyChannel: "whatsapp",
          replyTo: to,
        };
      },
      createInbound(input) {
        const chatJid = requireWhatsAppJid(input.conversation.id, "WhatsApp conversation");
        const senderJid = requireWhatsAppJid(input.senderId, "WhatsApp sender");
        return {
          ...createAdminInboundRequest(whatsapp),
          providerBody: {
            chatJid,
            senderJid,
            ...(input.senderName ? { pushName: input.senderName } : {}),
            text: input.text,
          },
          providerTargetKey: chatJid,
          qaTarget: qaTargetForInbound(input),
          stateConversation: {
            id: chatJid,
            kind: chatJid.endsWith("@g.us") ? "group" : "direct",
          },
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (!isRecord(event) || event.type !== "api" || typeof event.path !== "string") {
          return null;
        }
        if (!event.path.endsWith("/crabline/whatsapp/messages") || !isRecord(event.body)) {
          return null;
        }
        const to = readString(event.body.to ?? event.body.jid);
        const textPayload = event.body.text;
        const text = isRecord(textPayload) ? readString(textPayload.body) : readString(textPayload);
        if (!to || !text) {
          return null;
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: "openclaw",
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(to) ?? to,
        };
      },
    };
  },
});
