import { createPublicKey, verify, type KeyObject } from "node:crypto";
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
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

type DiscordEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "DISCORD_APPLICATION_ID" | "DISCORD_BOT_TOKEN" | "DISCORD_PUBLIC_KEY">
>;

type DiscordRuntime = {
  env?: DiscordEnvironment | undefined;
};

function resolveDiscordAdapterConfigValue(
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

export async function resolveDiscordAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: DiscordEnvironment = process.env,
) {
  return resolveDiscordAdapterConfigValue(config, userName, env);
}

function discordPublicKey(value: string): KeyObject {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    throw new CrablineError("Discord publicKey must be a 32-byte hexadecimal Ed25519 key.", {
      kind: "config",
    });
  }
  return createPublicKey({
    format: "der",
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(value, "hex")]),
    type: "spki",
  });
}

function authenticateDiscordWebhook(publicKey: KeyObject, request: Request, rawBody: string) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (
    !signature ||
    !timestamp ||
    !/^[0-9a-f]{128}$/iu.test(signature) ||
    !verify(null, Buffer.from(timestamp + rawBody), publicKey, Buffer.from(signature, "hex"))
  ) {
    return new Response("invalid request signature", { status: 401 });
  }
  return undefined;
}

function discordApplicationCommandText(data: Record<string, unknown>): string | undefined {
  const name = optionalString(data, "name");
  if (!name) {
    return undefined;
  }

  const values: string[] = [];
  const collectValues = (options: unknown): void => {
    if (!Array.isArray(options)) {
      return;
    }
    for (const option of options) {
      if (!isRecord(option)) {
        continue;
      }
      const value = option.value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        values.push(String(value));
      }
      collectValues(option.options);
    }
  };
  collectValues(data.options);
  return [name, ...values].join(" ");
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.discord?.recorder.path;
  return configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

export function normalizeDiscordWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Discord webhook payload must be an object", { kind: "inbound" });
  }

  const message = optionalRecord(payload, "message");
  if (
    (message && ("text" in message || "threadId" in message)) ||
    "text" in payload ||
    "threadId" in payload
  ) {
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
        discordApplicationCommandText(data) ??
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

export function createDiscordInteractionResponse(payload: unknown): Response {
  if (!isRecord(payload)) {
    return Response.json({ type: 5 }, { status: 200 });
  }
  if (payload.type === 3) {
    return Response.json({ type: 6 }, { status: 200 });
  }
  if (payload.type === 4) {
    return Response.json({ data: { choices: [] }, type: 8 }, { status: 200 });
  }
  return Response.json({ type: 5 }, { status: 200 });
}

export function handleDiscordWebhookPayload(payload: unknown): Response | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload.type === 1) {
    return Response.json({ type: 1 }, { status: 200 });
  }
  if (payload.type === 4) {
    return createDiscordInteractionResponse(payload);
  }
  return undefined;
}

export class DiscordProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, userName: string, runtime?: unknown) {
    const env = (runtime as DiscordRuntime | undefined)?.env ?? process.env;
    const resolvedConfig = resolveDiscordAdapterConfigValue(config, userName, env);
    const publicKey = resolvedConfig.publicKey
      ? discordPublicKey(resolvedConfig.publicKey)
      : undefined;
    requireExternalWebhookAuthentication({
      authenticated: Boolean(publicKey),
      provider: "Discord",
      requirement: "discord.publicKey or DISCORD_PUBLIC_KEY",
      webhook: config.discord?.webhook,
    });
    super({
      codec: getBuiltinTargetCodec("discord"),
      config,
      id,
      options: {
        ...(publicKey
          ? {
              authenticateWebhookRequest: (request: Request, rawBody: string) =>
                authenticateDiscordWebhook(publicKey, request, rawBody),
            }
          : {}),
        defaultWebhook: {
          host: "127.0.0.1",
          path: "/discord/interactions",
          port: 8788,
        },
        createWebhookSuccessResponse: createDiscordInteractionResponse,
        endpointLabel: "interactions endpoint",
        handleWebhookPayload: handleDiscordWebhookPayload,
        normalizeWebhookPayload: normalizeDiscordWebhookPayload,
        platform: "discord",
        publicUrl: config.discord?.webhook.publicUrl,
        recorderPath: toRecorderPath(id, config),
        webhook: config.discord?.webhook,
      },
    });
  }
}
