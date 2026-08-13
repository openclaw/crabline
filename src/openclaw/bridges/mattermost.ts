import {
  canonicalConversationIdForInbound,
  createAdminInboundRequest,
  createProviderIdRegistry,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";
import { mattermostId } from "../../servers/mattermost.js";
import { throwProbeHttpError } from "./probe-response.js";

const MATTERMOST_ID_PATTERN = /^[a-z0-9]{26}$/u;

function nativeId(value: string, label = "Mattermost target"): string {
  const trimmed = value.trim();
  if (!MATTERMOST_ID_PATTERN.test(trimmed)) {
    throw new Error(`${label} must be exactly 26 lowercase alphanumeric characters.`);
  }
  return trimmed;
}

function providerId(
  value: string,
  label: string,
  registry: ReturnType<typeof createProviderIdRegistry>,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return MATTERMOST_ID_PATTERN.test(trimmed)
    ? registry.reserveNative(trimmed)
    : registry.resolveLogical(trimmed);
}

function directTargetKey(userId: string): string {
  return `user:${userId}`;
}

function targetKey(channelId: string, rootId?: string): string {
  return rootId ? `${channelId}:thread:${rootId}` : channelId;
}

export const MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "mattermost",
  createAdapter(mattermost) {
    const createRegistry = (label: string) =>
      createProviderIdRegistry({
        candidate: mattermostId,
        conflictLabel: label,
      });
    const userIds = createRegistry("Mattermost user target");
    const channelIds = createRegistry("Mattermost channel target");
    const postIds = createRegistry("Mattermost post target");
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
          createProviderReadinessEnv: (env) => ({ ...env, ...mattermost.env }),
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
        const registry = parsed.kind === "direct" ? userIds : channelIds;
        const targetId = parsed.id.trim();
        const id =
          parsed.native || MATTERMOST_ID_PATTERN.test(targetId)
            ? registry.reserveNative(nativeId(targetId))
            : registry.resolveLogical(targetId);
        const to = parsed.kind === "direct" ? `user:${id}` : `channel:${id}`;
        return {
          channel: "mattermost",
          providerTargetKey: parsed.kind === "direct" ? directTargetKey(id) : id,
          replyChannel: "mattermost",
          replyTo: to,
          to,
        };
      },
      createInbound(input) {
        const kind = input.conversation.kind === "direct" ? "direct" : "group";
        const conversationId = canonicalConversationIdForInbound(input);
        if (!conversationId) {
          throw new Error("Mattermost conversation id is required.");
        }
        const senderId = providerId(input.senderId, "Mattermost sender", userIds);
        const recipientId =
          kind === "direct"
            ? providerId(conversationId, "Mattermost conversation", userIds)
            : undefined;
        if (recipientId !== undefined && recipientId !== senderId) {
          throw new Error(
            "Mattermost direct conversation and sender must identify the same recipient.",
          );
        }
        const channelId =
          kind === "group"
            ? providerId(conversationId, "Mattermost conversation", channelIds)
            : undefined;
        const threadId = input.threadId?.trim();
        const rootId = threadId
          ? MATTERMOST_ID_PATTERN.test(threadId)
            ? postIds.reserveNative(threadId)
            : postIds.resolveLogical(
                `thread:${kind === "group" ? channelId : senderId}:${threadId}`,
              )
          : undefined;
        return {
          ...createAdminInboundRequest(mattermost),
          providerBody: {
            ...(channelId ? { channelId } : {}),
            channelType: kind === "direct" ? "D" : "O",
            ...(rootId ? { rootId } : {}),
            senderId,
            ...(input.senderName ? { senderName: input.senderName } : {}),
            text: input.text,
          },
          providerTargetKey:
            kind === "direct"
              ? targetKey(directTargetKey(senderId), rootId)
              : targetKey(channelId!, rootId),
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
        const providerTargetKey = targetKey(channelId, rootId);
        const channel = isRecord(event.channel) ? event.channel : undefined;
        const directUserId =
          channel?.type === "D"
            ? readString(channel.name)
                ?.split("__")
                .find((participant) => participant !== mattermost.botUserId)
            : undefined;
        const target =
          targetByProviderTarget.get(providerTargetKey) ??
          (directUserId
            ? targetByProviderTarget.get(targetKey(directTargetKey(directUserId), rootId))
            : undefined);
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
      resolveInboundProviderTargetKey({ response }) {
        const post = isRecord(response) && isRecord(response.post) ? response.post : undefined;
        const channelId = post ? readString(post.channel_id) : undefined;
        const rootId = post ? readString(post.root_id) : undefined;
        if (!channelId) {
          throw new Error(
            "Crabline Mattermost inbound response did not identify its provider channel.",
          );
        }
        return targetKey(channelId, rootId);
      },
    };
  },
});
