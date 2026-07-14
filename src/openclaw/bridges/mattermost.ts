import {
  canonicalConversationIdForInbound,
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";
import { mattermostId } from "../../servers/mattermost.js";
import { throwProbeHttpError } from "./probe-response.js";

function nativeId(value: string, label = "Mattermost target"): string {
  const trimmed = value.trim();
  if (!/^[a-z0-9]{26}$/u.test(trimmed)) {
    throw new Error(`${label} must be exactly 26 lowercase alphanumeric characters.`);
  }
  return trimmed;
}

function directChannelId(botUserId: string, userId: string): string {
  return mattermostId(`dm:${[botUserId, userId].sort().join(":")}`);
}

function targetKey(channelId: string, rootId?: string): string {
  return rootId ? `${channelId}:thread:${rootId}` : channelId;
}

function threadRootId(channelId: string, value: string): string {
  return nativeId(value, `Mattermost root post for channel ${channelId}`);
}

export const MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "mattermost",
  createAdapter(mattermost) {
    return {
      async probe(signal) {
        const response = await fetch(`${mattermost.endpoints.apiRoot}/users/me`, {
          headers: { authorization: `Bearer ${mattermost.botToken}` },
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          await throwProbeHttpError(
            response,
            `Crabline Mattermost probe failed with HTTP ${response.status}.`,
          );
        }
        const payload: unknown = await response.json();
        if (
          !isRecord(payload) ||
          readString(payload.id) !== mattermost.botUserId ||
          !readNonBlankString(payload.username) ||
          typeof payload.update_at !== "number" ||
          !Number.isSafeInteger(payload.update_at) ||
          payload.update_at < 0
        ) {
          throw new Error("Crabline Mattermost users/me probe returned an unexpected user.");
        }
        return payload;
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
                  streaming: { mode: "off" },
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
        const conversationId = canonicalConversationIdForInbound(input);
        if (!conversationId) {
          throw new Error("Mattermost conversation id is required.");
        }
        const senderId = nativeId(input.senderId);
        const recipientId = kind === "direct" ? nativeId(conversationId) : undefined;
        if (recipientId !== undefined && recipientId !== senderId) {
          throw new Error(
            "Mattermost direct conversation and sender must identify the same recipient.",
          );
        }
        const channelId =
          kind === "direct"
            ? directChannelId(mattermost.botUserId, senderId)
            : nativeId(conversationId);
        const threadId = input.threadId?.trim();
        const rootId = threadId ? threadRootId(channelId, threadId) : undefined;
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
          stateConversation: { id: conversationId, kind },
          ...(rootId ? { threadId: rootId } : {}),
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
        const text = readNonBlankString(event.body.message);
        if (!channelId || !text) {
          return null;
        }
        const target = targetByProviderTarget.get(targetKey(channelId, rootId));
        if (!target) {
          return null;
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: mattermost.botUserId,
          senderName: "OpenClaw QA",
          text,
          to: target,
        };
      },
    };
  },
});
