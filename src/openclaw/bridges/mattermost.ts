import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readString,
} from "../shared.js";
import { mattermostId } from "../../servers/mattermost.js";

function nativeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Mattermost target is required.");
  }
  return /^[a-z0-9]{26}$/u.test(trimmed) ? trimmed : mattermostId(trimmed);
}

function directChannelId(botUserId: string, userId: string): string {
  return mattermostId(`dm:${[botUserId, userId].sort().join(":")}`);
}

function targetKey(channelId: string, rootId?: string): string {
  return rootId ? `${channelId}:thread:${rootId}` : channelId;
}

export const MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "mattermost",
  createAdapter(mattermost) {
    return {
      async probe() {
        const response = await fetch(`${mattermost.endpoints.apiRoot}/users/me`, {
          headers: { authorization: `Bearer ${mattermost.botToken}` },
        });
        if (!response.ok) {
          throw new Error(`Crabline Mattermost probe failed with HTTP ${response.status}.`);
        }
        return await response.json();
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "mattermost",
          createChannelDriverSmokeEnv: (env) => ({ ...env, ...mattermost.env }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const mattermostConfig = isRecord(channels.mattermost) ? channels.mattermost : {};
            return {
              ...openclawConfig,
              channels: {
                ...channels,
                mattermost: {
                  ...mattermostConfig,
                  allowFrom: ["*"],
                  baseUrl: mattermost.baseUrl,
                  botToken: mattermost.botToken,
                  chatmode: "onmessage",
                  dmPolicy: "open",
                  enabled: true,
                  groupAllowFrom: ["*"],
                  groupPolicy: "open",
                  network: { dangerouslyAllowPrivateNetwork: true },
                  streaming: "off",
                },
              },
            };
          },
          requiredPluginIds: ["mattermost"],
        };
      },
      createAgentDelivery(parsed) {
        if (parsed.threadId) {
          throw new Error("Mattermost thread targets require OpenClaw QA thread forwarding.");
        }
        const id = nativeId(parsed.id);
        const to = parsed.kind === "direct" ? `user:${id}` : `channel:${id}`;
        return { channel: "mattermost", replyChannel: "mattermost", replyTo: to, to };
      },
      createInbound(input) {
        const kind = input.conversation.kind === "direct" ? "direct" : "group";
        const senderId = nativeId(input.senderId);
        const channelId =
          kind === "direct"
            ? directChannelId(mattermost.botUserId, senderId)
            : nativeId(input.conversation.id);
        const rootId = input.threadId ? nativeId(input.threadId) : undefined;
        return {
          ...createAdminInboundRequest(mattermost),
          providerBody: {
            channelId,
            channelType: kind === "direct" ? "D" : "O",
            ...(rootId ? { rootId } : {}),
            senderId,
            ...(input.senderName ? { senderName: input.senderName } : {}),
            text: input.text,
          },
          providerTargetKey: targetKey(channelId, rootId),
          qaTarget: qaTargetForInbound(input),
          stateConversation: { id: input.conversation.id, kind },
          ...(input.threadId ? { threadId: input.threadId } : {}),
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (
          !isRecord(event) ||
          event.type !== "api" ||
          event.method !== "POST" ||
          event.path !== "/api/v4/posts" ||
          !isRecord(event.body)
        ) {
          return null;
        }
        const channelId = readString(event.body.channel_id);
        const rootId = readString(event.body.root_id);
        const text = readString(event.body.message);
        if (!channelId || !text) {
          return null;
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: mattermost.botUserId,
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(targetKey(channelId, rootId)) ?? channelId,
        };
      },
    };
  },
});
