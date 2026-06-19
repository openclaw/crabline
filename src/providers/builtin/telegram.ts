import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, type LocalMockTargetCodec } from "../local-mock.js";
import type { NormalizedTarget, ProviderAdapter, ProviderContext } from "../types.js";

type TelegramEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    "TELEGRAM_API_BASE_URL" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET_TOKEN"
  >
>;

export function resolveTelegramAdapterConfig(
  config: ProviderConfig,
  env: TelegramEnvironment = process.env,
) {
  const telegramConfig = config.telegram;
  return {
    mode: telegramConfig?.mode ?? "auto",
    ...((telegramConfig?.apiUrl ?? env.TELEGRAM_API_BASE_URL)
      ? { apiUrl: telegramConfig?.apiUrl ?? env.TELEGRAM_API_BASE_URL! }
      : {}),
    ...((telegramConfig?.secretToken ?? env.TELEGRAM_WEBHOOK_SECRET_TOKEN)
      ? { secretToken: telegramConfig?.secretToken ?? env.TELEGRAM_WEBHOOK_SECRET_TOKEN! }
      : {}),
    ...((telegramConfig?.userName ?? env.TELEGRAM_BOT_USERNAME)
      ? { userName: telegramConfig?.userName ?? env.TELEGRAM_BOT_USERNAME! }
      : {}),
  };
}

function isTelegramEncodedId(value: string): boolean {
  return value.startsWith("telegram:");
}

function normalizeTelegramChannelId(value: string): string {
  return isTelegramEncodedId(value) ? value : `telegram:${value}`;
}

function normalizeTelegramThreadId(channelId: string, threadId: string): string {
  if (isTelegramEncodedId(threadId)) {
    return threadId;
  }
  const chatId = channelId.replace(/^telegram:/u, "");
  return `telegram:${chatId}:${threadId}`;
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.telegram?.recorder.path;
  return configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

const TELEGRAM_CODEC: LocalMockTargetCodec = {
  normalize(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    const normalized: NormalizedTarget = {
      id: target.id,
      metadata: target.metadata,
    };

    if (target.channelId) {
      normalized.channelId = normalizeTelegramChannelId(target.channelId);
    } else if (!target.threadId) {
      normalized.channelId = normalizeTelegramChannelId(target.id);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        normalized.channelId = normalizeTelegramChannelId(target.id);
      }
      normalized.threadId = normalizeTelegramThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  },
  resolveThreadId(target) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? normalizeTelegramChannelId(normalized.id);
  },
};

export class TelegramProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string) {
    super({
      codec: TELEGRAM_CODEC,
      config,
      id,
      options: {
        defaultWebhook: {
          host: "127.0.0.1",
          path: "/telegram/webhook",
          port: 8790,
        },
        endpointLabel: "webhook endpoint",
        platform: "telegram",
        publicUrl: config.telegram?.webhook.publicUrl,
        recorderPath: toRecorderPath(id, config),
        webhook: config.telegram?.webhook,
      },
    });
  }
}
