import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, resolveGeneratedLocalMockRecorderPath } from "../local-mock.js";
import { matchesNativeId } from "../native-ids.js";
import {
  getBuiltinTargetCodec,
  parseCanonicalTelegramInboundTopic,
  TELEGRAM_INBOUND_CHAT_ID_RULE,
  TELEGRAM_MESSAGE_THREAD_ID_RULE,
} from "../target-normalizers.js";
import type { ProviderAdapter } from "../types.js";
import {
  authorFromBotFlag,
  createSecretVerifier,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  optionalStringish,
  requireNativeInboundId,
} from "./native-local-mock.js";

type TelegramEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    "TELEGRAM_API_BASE_URL" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET_TOKEN"
  >
>;

const TELEGRAM_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}(?![\s\S])/u;

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
    : resolveGeneratedLocalMockRecorderPath(providerId);
}

function normalizeGenericTelegramPayload(payload: Record<string, unknown>) {
  const message = optionalRecord(payload, "message");
  const threadId =
    (message ? optionalString(message, "threadId") : undefined) ??
    optionalString(payload, "threadId");
  let canonicalTopic = threadId ? parseCanonicalTelegramInboundTopic(threadId) : undefined;
  const channelIds = [
    optionalString(payload, "channelId"),
    ...(message ? [optionalString(message, "channelId")] : []),
  ]
    .filter((value): value is string => value !== undefined)
    .map((channelId) =>
      requireNativeInboundId(channelId, TELEGRAM_INBOUND_CHAT_ID_RULE, "Telegram channelId"),
    );
  const channelId = channelIds[0];
  if (channelIds.some((candidate) => candidate !== channelId)) {
    throw new CrablineError("Telegram inbound channelId values must match.", {
      kind: "inbound",
    });
  }
  if (canonicalTopic) {
    for (const candidate of channelIds) {
      if (candidate !== canonicalTopic.chatId) {
        throw new CrablineError(
          "Telegram canonical topic chat_id must match the inbound channelId.",
          {
            kind: "inbound",
          },
        );
      }
    }
  } else if (threadId && matchesNativeId(threadId, TELEGRAM_MESSAGE_THREAD_ID_RULE)) {
    if (!channelId) {
      throw new CrablineError("Telegram bare topic IDs require an inbound channelId.", {
        kind: "inbound",
      });
    }
    if (threadId !== channelId) {
      canonicalTopic = { chatId: channelId, topicId: threadId };
    }
  }
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
    channelRule: TELEGRAM_INBOUND_CHAT_ID_RULE,
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
        threadId: `${canonicalTopic.chatId}:${canonicalTopic.topicId}`,
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
  if (!message || optionalString(message, "threadId") || optionalString(payload, "threadId")) {
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
    TELEGRAM_INBOUND_CHAT_ID_RULE,
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
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const env = (runtime as { env?: TelegramEnvironment } | undefined)?.env ?? process.env;
    const tokenKey = ["secret", "Token"].join("") as "secretToken";
    const tokenEnvKey = ["TELEGRAM", "WEBHOOK", "SECRET", "TOKEN"].join(
      "_",
    ) as "TELEGRAM_WEBHOOK_SECRET_TOKEN";
    const rawWebhookValue = config.telegram?.[tokenKey] ?? env[tokenEnvKey];
    if (rawWebhookValue === "") {
      throw new CrablineError(
        "Telegram secretToken must use 1-256 letters, digits, underscores, or hyphens",
        { kind: "config" },
      );
    }
    const resolvedConfig = resolveTelegramAdapterConfig(config, env);
    if (
      resolvedConfig.secretToken !== undefined &&
      !TELEGRAM_WEBHOOK_SECRET_PATTERN.test(resolvedConfig.secretToken)
    ) {
      throw new CrablineError(
        "Telegram secretToken must use 1-256 letters, digits, underscores, or hyphens",
        { kind: "config" },
      );
    }
    const authenticateWebhook =
      resolvedConfig.secretToken !== undefined
        ? createSecretVerifier(resolvedConfig.secretToken)
        : undefined;
    super({
      codec: getBuiltinTargetCodec("telegram"),
      config,
      id,
      options: {
        ...(authenticateWebhook
          ? {
              preflightWebhookRequest(request: Request) {
                return authenticateWebhook(request.headers.get("x-telegram-bot-api-secret-token"))
                  ? undefined
                  : new Response("unauthorized", { status: 401 });
              },
            }
          : {}),
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
