import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readString,
} from "../shared.js";

function nativeId(value: string): string {
  const id = value.trim();
  if (!id) {
    throw new Error("Zalo target is required.");
  }
  return id;
}

export const ZALO_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "zalo",
  createAdapter(zalo) {
    return {
      async probe() {
        const response = await fetch(`${zalo.endpoints.apiRoot}/bot${zalo.botToken}/getMe`, {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`Crabline Zalo getMe probe failed with HTTP ${response.status}.`);
        }
        return await response.json();
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "zalo",
          createChannelDriverSmokeEnv: (env) => ({ ...env, ...zalo.env }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const zaloConfig = isRecord(channels.zalo) ? channels.zalo : {};
            return {
              ...openclawConfig,
              channels: {
                ...channels,
                zalo: {
                  ...zaloConfig,
                  allowFrom: ["*"],
                  botToken: zalo.botToken,
                  dmPolicy: "open",
                  enabled: true,
                  groupAllowFrom: ["*"],
                  groupPolicy: "open",
                },
              },
            };
          },
          requiredPluginIds: ["zalo"],
        };
      },
      createAgentDelivery(parsed) {
        if (parsed.threadId) {
          throw new Error("Zalo does not support thread targets.");
        }
        const to = nativeId(parsed.id);
        return { channel: "zalo", replyChannel: "zalo", replyTo: to, to };
      },
      createInbound(input) {
        if (input.threadId) {
          throw new Error("Zalo does not support thread targets.");
        }
        const kind = input.conversation.kind === "direct" ? "direct" : "group";
        const chatId = nativeId(input.conversation.id);
        return {
          ...createAdminInboundRequest(zalo),
          providerBody: {
            chatId,
            chatType: kind === "direct" ? "PRIVATE" : "GROUP",
            senderId: nativeId(input.senderId),
            ...(input.senderName ? { senderName: input.senderName } : {}),
            text: input.text,
          },
          providerTargetKey: chatId,
          qaTarget: qaTargetForInbound(input),
          stateConversation: { id: chatId, kind },
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (
          !isRecord(event) ||
          event.type !== "api" ||
          (event.method !== "GET" && event.method !== "POST") ||
          !isRecord(event.body) ||
          (event.path !== "/bot<redacted>/sendMessage" && event.path !== "/bot<redacted>/sendPhoto")
        ) {
          return null;
        }
        const chatId = readString(event.body.chat_id);
        const text =
          event.path === "/bot<redacted>/sendMessage"
            ? readString(event.body.text)
            : readString(event.body.caption);
        if (!chatId || !text) {
          return null;
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: zalo.botId,
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(chatId) ?? chatId,
        };
      },
    };
  },
});
