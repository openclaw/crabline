import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import { DISCORD_SNOWFLAKE_RULE, getBuiltinTargetCodec } from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

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

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.discord?.recorder.path;
  return configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function normalizeDiscordWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Discord webhook payload must be an object", { kind: "inbound" });
  }

  const message = optionalRecord(payload, "message");
  if (message && ("text" in message || "threadId" in message)) {
    return genericMockPayloadWithNativeThread({
      channelRule: DISCORD_SNOWFLAKE_RULE,
      payload,
      threadRule: DISCORD_SNOWFLAKE_RULE,
    });
  }

  const data = optionalRecord(payload, "data");
  const author = optionalRecord(payload, "author") ?? optionalRecord(payload, "member")?.user;
  const channelId = optionalString(payload, "channel_id");
  const text =
    optionalString(payload, "content") ??
    (data
      ? (optionalString(data, "content") ??
        optionalString(data, "name") ??
        optionalString(data, "custom_id"))
      : undefined) ??
    (message ? optionalString(message, "content") : undefined);
  if (!channelId || !text) {
    throw new CrablineError("Discord event payload requires channel_id and content", {
      kind: "inbound",
    });
  }

  const authorRecord = isRecord(author) ? author : undefined;
  const threadId = optionalString(payload, "thread_id") ?? channelId;
  return {
    author: authorFromBotFlag(authorRecord?.bot === true),
    ...(optionalString(payload, "id") ? { id: optionalString(payload, "id") } : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(threadId, DISCORD_SNOWFLAKE_RULE, "Discord thread_id"),
  };
}

export class DiscordProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string) {
    super({
      codec: getBuiltinTargetCodec("discord"),
      config,
      id,
      options: {
        defaultWebhook: {
          host: "127.0.0.1",
          path: "/discord/interactions",
          port: 8788,
        },
        endpointLabel: "interactions endpoint",
        normalizeWebhookPayload: normalizeDiscordWebhookPayload,
        platform: "discord",
        publicUrl: config.discord?.webhook.publicUrl,
        recorderPath: toRecorderPath(id, config),
        webhook: config.discord?.webhook,
      },
    });
  }
}
