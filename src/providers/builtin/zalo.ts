import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import { getBuiltinTargetCodec, ZALO_ID_RULE } from "../target-normalizers.js";
import {
  authorFromBotFlag,
  createSecretVerifier,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

type ZaloEnvironment = Partial<Pick<NodeJS.ProcessEnv, "ZALO_BOT_TOKEN" | "ZALO_WEBHOOK_SECRET">>;

export function resolveZaloAdapterConfig(
  config: ProviderConfig,
  env: ZaloEnvironment = process.env,
) {
  const configuredWebhookSecret = config.zalo?.webhookSecret;
  const webhookSecret = configuredWebhookSecret ?? env.ZALO_WEBHOOK_SECRET;
  if (webhookSecret !== undefined && !webhookSecret.trim()) {
    throw new CrablineError(
      configuredWebhookSecret === undefined
        ? "ZALO_WEBHOOK_SECRET must not be empty or whitespace-only."
        : "Zalo webhookSecret must not be empty or whitespace-only.",
      { kind: "config" },
    );
  }
  return {
    botToken: config.zalo?.botToken ?? env.ZALO_BOT_TOKEN ?? "local-mock-zalo-token",
    webhookSecret,
  };
}

export class ZaloProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const env = (runtime as { env?: ZaloEnvironment } | undefined)?.env ?? process.env;
    const resolvedConfig = resolveZaloAdapterConfig(config, env);
    const authenticateWebhook = resolvedConfig.webhookSecret
      ? createSecretVerifier(resolvedConfig.webhookSecret)
      : undefined;
    super({
      codec: getBuiltinTargetCodec("zalo"),
      config,
      id,
      options: {
        ...(authenticateWebhook
          ? {
              authenticateWebhookRequest(request: Request) {
                return authenticateWebhook(request.headers.get("x-bot-api-secret-token"))
                  ? undefined
                  : new Response("unauthorized", { status: 401 });
              },
            }
          : {}),
        defaultWebhook: { host: "127.0.0.1", path: "/zalo/webhook", port: 8794 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeZaloWebhookPayload,
        platform: "zalo",
        publicUrl: config.zalo?.webhook.publicUrl,
        recorderPath: config.zalo?.recorder.path
          ? path.resolve(config.zalo.recorder.path)
          : undefined,
        webhook: config.zalo?.webhook,
      },
    });
  }
}

export function normalizeZaloWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Zalo webhook payload must be an object", { kind: "inbound" });
  }

  const payloadMessage = optionalRecord(payload, "message");
  if (
    optionalString(payload, "threadId") ||
    (payloadMessage && optionalString(payloadMessage, "threadId"))
  ) {
    return genericMockPayloadWithNativeThread({
      channelRule: ZALO_ID_RULE,
      payload,
      threadRule: ZALO_ID_RULE,
    });
  }

  const wrapped = optionalRecord(payload, "result") ?? payload;
  const message = optionalRecord(wrapped, "message");
  const sender = optionalRecord(message ?? {}, "from") ?? optionalRecord(wrapped, "sender");
  const chat = message ? optionalRecord(message, "chat") : undefined;
  const senderId = sender ? optionalString(sender, "id") : undefined;
  const chatId = chat ? optionalString(chat, "id") : senderId;
  const eventName = optionalString(wrapped, "event_name");
  // Live Zalo Bot image callbacks expose the media URL as photo_url, not photo.
  const photoUrl =
    eventName === "message.image.received" && message
      ? optionalString(message, "photo_url")
      : undefined;
  const text =
    eventName === "message.image.received"
      ? photoUrl
        ? optionalString(message ?? {}, "caption") || photoUrl
        : undefined
      : message
        ? optionalString(message, "text")
        : undefined;
  if (!senderId || !chatId || !text) {
    throw new CrablineError(
      "Zalo webhook payload requires sender identity, chat identity, and message content",
      {
        kind: "inbound",
      },
    );
  }

  return {
    author: authorFromBotFlag(sender?.is_bot === true),
    ...(optionalString(message ?? {}, "message_id")
      ? { id: optionalString(message ?? {}, "message_id") }
      : optionalString(message ?? {}, "msg_id")
        ? { id: optionalString(message ?? {}, "msg_id") }
        : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(chatId, ZALO_ID_RULE, "Zalo chat.id"),
  };
}
