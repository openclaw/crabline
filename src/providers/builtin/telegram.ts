import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  authorFromBotFlag,
  createNativeTargetCodec,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  optionalStringish,
  requireNativeId,
  requireNativeInboundId,
  type NativeIdRule,
} from "./native-local-mock.js";

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

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.telegram?.recorder.path;
  return configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

const TELEGRAM_CHAT_ID_RULE: NativeIdRule = {
  example: "-1001234567890 or @channelusername",
  name: "Telegram chat id",
  pattern: /^(?:-?\d+|@[A-Za-z][A-Za-z0-9_]{4,31})$/u,
};

const TELEGRAM_MESSAGE_THREAD_ID_RULE: NativeIdRule = {
  example: "42",
  name: "Telegram message_thread_id",
  pattern: /^\d+$/u,
};

const TELEGRAM_BASE_CODEC = createNativeTargetCodec({
  channel: TELEGRAM_CHAT_ID_RULE,
  channelLabel: "Telegram chat_id",
  thread: TELEGRAM_MESSAGE_THREAD_ID_RULE,
  threadLabel: "Telegram message_thread_id",
});

const TELEGRAM_CODEC = {
  normalize(target: Parameters<typeof TELEGRAM_BASE_CODEC.normalize>[0]) {
    const canonicalTopic = target.threadId
      ? parseCanonicalTelegramTopic(target.threadId)
      : undefined;
    const targetChatId = target.channelId ?? target.id;
    if (
      canonicalTopic &&
      requireNativeId(targetChatId, TELEGRAM_CHAT_ID_RULE, "Telegram chat_id") !==
        canonicalTopic.chatId
    ) {
      throw new CrablineError("Telegram canonical topic chat_id must match the target chat_id.", {
        kind: "config",
      });
    }
    const normalized = TELEGRAM_BASE_CODEC.normalize({
      ...target,
      ...(canonicalTopic ? { channelId: canonicalTopic.chatId } : {}),
      threadId: undefined,
    });
    if (!target.threadId) {
      return normalized;
    }
    const topicId = requireNativeId(
      canonicalTopic?.topicId ?? target.threadId,
      TELEGRAM_MESSAGE_THREAD_ID_RULE,
      "Telegram message_thread_id",
    );
    return {
      ...normalized,
      threadId: `${normalized.channelId}:${topicId}`,
    };
  },
  resolveThreadId(target: Parameters<typeof TELEGRAM_BASE_CODEC.resolveThreadId>[0]) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? normalized.id;
  },
};

function parseCanonicalTelegramTopic(
  value: string,
): { chatId: string; topicId: string } | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const chatId = value.slice(0, separator);
  const topicId = value.slice(separator + 1);
  if (
    !TELEGRAM_CHAT_ID_RULE.pattern.test(chatId) ||
    !TELEGRAM_MESSAGE_THREAD_ID_RULE.pattern.test(topicId)
  ) {
    return undefined;
  }
  return { chatId, topicId };
}

function normalizeGenericTelegramPayload(payload: Record<string, unknown>) {
  const message = optionalRecord(payload, "message");
  const threadId = message
    ? optionalString(message, "threadId")
    : optionalString(payload, "threadId");
  const canonicalTopic = threadId ? parseCanonicalTelegramTopic(threadId) : undefined;
  const genericPayload = canonicalTopic
    ? message
      ? {
          ...payload,
          message: {
            ...message,
            threadId: canonicalTopic.topicId,
          },
        }
      : {
          ...payload,
          threadId: canonicalTopic.topicId,
        }
    : payload;
  const normalized = genericMockPayloadWithNativeThread({
    channelRule: TELEGRAM_CHAT_ID_RULE,
    payload: genericPayload,
    threadRule: TELEGRAM_MESSAGE_THREAD_ID_RULE,
  });
  if (!canonicalTopic) {
    return normalized;
  }
  const normalizedRecord = normalized as Record<string, unknown>;
  const raw = payload.raw ?? payload;
  return message
    ? {
        ...normalizedRecord,
        raw,
        message: {
          ...(isRecord(normalizedRecord.message) ? normalizedRecord.message : {}),
          threadId: `${canonicalTopic.chatId}:${canonicalTopic.topicId}`,
        },
      }
    : {
        ...normalizedRecord,
        raw,
        threadId: `${canonicalTopic.chatId}:${canonicalTopic.topicId}`,
      };
}

export function normalizeTelegramWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Telegram webhook payload must be an object", { kind: "inbound" });
  }

  const message =
    optionalRecord(payload, "message") ??
    optionalRecord(payload, "edited_message") ??
    optionalRecord(payload, "channel_post") ??
    optionalRecord(payload, "edited_channel_post");
  if (!message || optionalString(message, "threadId")) {
    return normalizeGenericTelegramPayload(payload);
  }

  const chat = optionalRecord(message, "chat");
  const chatId = chat ? optionalStringish(chat, "id") : undefined;
  const text = optionalString(message, "text") ?? optionalString(message, "caption");
  if (!chatId || !text) {
    throw new CrablineError("Telegram update requires message.chat.id and message.text", {
      kind: "inbound",
    });
  }

  const topicId = optionalStringish(message, "message_thread_id");
  const normalizedChatId = requireNativeInboundId(
    chatId,
    TELEGRAM_CHAT_ID_RULE,
    "Telegram message.chat.id",
  );
  const from = optionalRecord(message, "from");
  return {
    author: authorFromBotFlag(from?.is_bot === true),
    ...(optionalStringish(message, "message_id")
      ? { id: optionalStringish(message, "message_id") }
      : optionalStringish(payload, "update_id")
        ? { id: optionalStringish(payload, "update_id") }
        : {}),
    raw: payload,
    text,
    threadId: topicId
      ? `${normalizedChatId}:${requireNativeInboundId(
          topicId,
          TELEGRAM_MESSAGE_THREAD_ID_RULE,
          "Telegram message.message_thread_id",
        )}`
      : normalizedChatId,
  };
}

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
        normalizeWebhookPayload: normalizeTelegramWebhookPayload,
        platform: "telegram",
        publicUrl: config.telegram?.webhook.publicUrl,
        recorderPath: toRecorderPath(id, config),
        webhook: config.telegram?.webhook,
      },
    });
  }
}
