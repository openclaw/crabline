import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, type LocalMockTargetCodec } from "../local-mock.js";
import type { NormalizedTarget, ProviderAdapter, ProviderContext } from "../types.js";

type DiscordEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "DISCORD_APPLICATION_ID" | "DISCORD_BOT_TOKEN" | "DISCORD_PUBLIC_KEY">
>;

export async function resolveDiscordAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: DiscordEnvironment = process.env,
) {
  return {
    ...((config.discord?.applicationId ?? env.DISCORD_APPLICATION_ID)
      ? { applicationId: config.discord?.applicationId ?? env.DISCORD_APPLICATION_ID! }
      : {}),
    ...((config.discord?.botToken ?? env.DISCORD_BOT_TOKEN)
      ? { botToken: config.discord?.botToken ?? env.DISCORD_BOT_TOKEN! }
      : {}),
    ...((config.discord?.mentionRoleIds?.length ?? 0) > 0
      ? { mentionRoleIds: config.discord?.mentionRoleIds }
      : {}),
    ...((config.discord?.publicKey ?? env.DISCORD_PUBLIC_KEY)
      ? { publicKey: config.discord?.publicKey ?? env.DISCORD_PUBLIC_KEY! }
      : {}),
    userName,
  };
}

function isDiscordEncodedId(value: string): boolean {
  return value.startsWith("discord:");
}

function normalizeDiscordChannelId(channelId: string, guildId?: string): string {
  if (isDiscordEncodedId(channelId)) {
    return channelId.split(":").slice(0, 3).join(":");
  }
  if (!guildId) {
    throw new CrablineError(
      "Discord guild channels require target.metadata.guildId unless target id is already encoded as discord:guild:channel.",
      { kind: "config" },
    );
  }
  return `discord:${guildId}:${channelId}`;
}

function normalizeDiscordThreadId(channelId: string, threadId: string): string {
  if (isDiscordEncodedId(threadId)) {
    return threadId;
  }
  return `${channelId}:${threadId}`;
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.discord?.recorder.path;
  return configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

const DISCORD_CODEC: LocalMockTargetCodec = {
  normalize(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    const normalized: NormalizedTarget = {
      id: target.id,
      metadata: target.metadata,
    };

    if (isDiscordEncodedId(target.id)) {
      const parts = target.id.split(":");
      if (parts.length >= 3) {
        normalized.channelId = parts.slice(0, 3).join(":");
      }
      if (parts.length >= 4) {
        normalized.threadId = target.id;
      }
    }

    if (target.channelId) {
      normalized.channelId = normalizeDiscordChannelId(target.channelId, target.metadata.guildId);
    } else if (!target.threadId && target.metadata.guildId && !normalized.channelId) {
      normalized.channelId = normalizeDiscordChannelId(target.id, target.metadata.guildId);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        normalized.channelId = target.metadata.guildId
          ? normalizeDiscordChannelId(target.id, target.metadata.guildId)
          : undefined;
      }
      if (!normalized.channelId) {
        throw new CrablineError(
          `Discord target "${target.id}" requires target.metadata.guildId or an encoded target.channelId for thread send.`,
          { kind: "config" },
        );
      }
      normalized.threadId = normalizeDiscordThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  },
  resolveThreadId(target) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? `discord:@me:dm-${normalized.id}`;
  },
};

export class DiscordProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string) {
    super({
      codec: DISCORD_CODEC,
      config,
      id,
      options: {
        defaultWebhook: {
          host: "127.0.0.1",
          path: "/discord/interactions",
          port: 8788,
        },
        endpointLabel: "interactions endpoint",
        platform: "discord",
        publicUrl: config.discord?.webhook.publicUrl,
        recorderPath: toRecorderPath(id, config),
        webhook: config.discord?.webhook,
      },
    });
  }
}
