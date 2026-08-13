import { discordDirectChannelId } from "../../servers/discord.js";
import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";
import { throwProbeHttpError } from "./probe-response.js";

const DISCORD_ID_PATTERN = /^\d{17,20}$/u;

function discordId(value: string, label: string): string {
  const id = value.trim();
  if (!DISCORD_ID_PATTERN.test(id)) {
    throw new Error(`${label} must be a Discord snowflake.`);
  }
  return id;
}

function providerTargetKey(channelId: string): string {
  return channelId;
}

export const DISCORD_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "discord",
  createAdapter(discord) {
    return {
      async probe(signal) {
        const response = await fetch(`${discord.endpoints.apiRoot}/v10/users/@me`, {
          headers: { authorization: `Bot ${discord.botToken}` },
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          await throwProbeHttpError(
            response,
            `Crabline Discord users/@me probe failed with HTTP ${response.status}.`,
          );
        }
        const payload: unknown = await response.json();
        if (
          !isRecord(payload) ||
          readString(payload.id) !== discord.botUserId ||
          payload.bot !== true ||
          !readNonBlankString(payload.username)
        ) {
          throw new Error("Crabline Discord users/@me probe returned an unexpected bot user.");
        }
        return payload;
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "discord",
          createProviderReadinessEnv: (env) => ({ ...env, ...discord.env }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const discordConfig = isRecord(channels.discord) ? channels.discord : {};
            const guilds = isRecord(discordConfig.guilds) ? discordConfig.guilds : {};
            const wildcardGuild = isRecord(guilds["*"]) ? guilds["*"] : {};
            const wildcardChannels = isRecord(wildcardGuild.channels) ? wildcardGuild.channels : {};
            const wildcardChannel = isRecord(wildcardChannels["*"]) ? wildcardChannels["*"] : {};
            return {
              ...openclawConfig,
              channels: {
                ...channels,
                discord: {
                  ...discordConfig,
                  applicationId: discord.applicationId,
                  dm: { enabled: true },
                  dmPolicy: "open",
                  enabled: true,
                  groupPolicy: "open",
                  guilds: {
                    ...guilds,
                    "*": {
                      ...wildcardGuild,
                      channels: {
                        ...wildcardChannels,
                        "*": {
                          ...wildcardChannel,
                          enabled: true,
                          requireMention: false,
                        },
                      },
                    },
                  },
                  replyToMode: "all",
                  streaming: { mode: "off" },
                  token: discord.botToken,
                  voice: { enabled: false },
                },
              },
            };
          },
          requiredPluginIds: ["discord"],
        };
      },
      createAgentDelivery(parsed) {
        const id = discordId(parsed.id, "Discord target");
        if (parsed.threadId) {
          const threadId = discordId(parsed.threadId, "Discord thread");
          const to = `channel:${threadId}`;
          return {
            channel: "discord",
            providerTargetKey: providerTargetKey(threadId),
            replyChannel: "discord",
            replyTo: to,
            to,
          };
        }
        const to = `${parsed.kind === "direct" ? "user" : "channel"}:${id}`;
        return {
          channel: "discord",
          providerTargetKey: providerTargetKey(
            parsed.kind === "direct" ? discordDirectChannelId(discord.botUserId, id) : id,
          ),
          replyChannel: "discord",
          replyTo: to,
          to,
        };
      },
      createInbound(input) {
        const conversationId = discordId(input.conversation.id, "Discord conversation");
        const senderId = discordId(input.senderId, "Discord sender");
        const threadId = input.threadId ? discordId(input.threadId, "Discord thread") : undefined;
        if (input.conversation.kind === "direct" && threadId) {
          throw new Error("Discord direct messages do not support thread targets.");
        }
        const channelId =
          input.conversation.kind === "direct"
            ? discordDirectChannelId(discord.botUserId, senderId)
            : (threadId ?? conversationId);
        return {
          ...createAdminInboundRequest(discord),
          providerBody: {
            channelId,
            content: input.text,
            ...(input.conversation.kind === "group"
              ? {
                  guildId: "135000000000000099",
                  ...(threadId ? { parentChannelId: conversationId } : {}),
                }
              : {}),
            senderId,
            ...(input.senderName ? { senderName: input.senderName } : {}),
          },
          providerTargetKey: providerTargetKey(channelId),
          qaTarget: qaTargetForInbound(input),
          stateConversation: { id: conversationId, kind: input.conversation.kind },
          ...(threadId ? { threadId } : {}),
        };
      },
      createOutboundObservation({ event }) {
        if (
          !isRecord(event) ||
          event.type !== "api" ||
          event.method !== "POST" ||
          typeof event.path !== "string" ||
          !isRecord(event.body)
        ) {
          return null;
        }
        const match = /^\/api\/v10\/channels\/(\d{17,20})\/messages$/u.exec(event.path);
        const channelId = match?.[1];
        const text = readNonBlankString(event.body.content);
        if (!channelId || !text) {
          return null;
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: discord.botUserId,
          senderName: "OpenClaw QA",
          text,
          providerTargetKeys: [providerTargetKey(channelId)],
          fallbackTarget: channelId,
        };
      },
    };
  },
});
