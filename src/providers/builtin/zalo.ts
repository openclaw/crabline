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
  requireNativeInboundId,
  type NativeIdRule,
} from "./native-local-mock.js";

const ZALO_ID_RULE: NativeIdRule = {
  example: "123456789012345678",
  name: "Zalo user or OA id",
  pattern: /^\d{6,20}$/u,
};

export function resolveZaloAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    botToken: config.zalo?.botToken ?? env.ZALO_BOT_TOKEN ?? "local-mock-zalo-token",
    webhookSecret: config.zalo?.webhookSecret ?? env.ZALO_WEBHOOK_SECRET,
  };
}

export class ZaloProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: ZALO_ID_RULE,
        channelLabel: "Zalo user_id or oa_id",
      }),
      config,
      id,
      options: {
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

function normalizeZaloWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Zalo webhook payload must be an object", { kind: "inbound" });
  }

  if (
    optionalRecord(payload, "message") &&
    optionalString(optionalRecord(payload, "message")!, "threadId")
  ) {
    return genericMockPayloadWithNativeThread({
      channelRule: ZALO_ID_RULE,
      payload,
      threadRule: ZALO_ID_RULE,
    });
  }

  const sender = optionalRecord(payload, "sender");
  const message = optionalRecord(payload, "message");
  const senderId = sender ? optionalString(sender, "id") : undefined;
  const text = message ? optionalString(message, "text") : undefined;
  if (!senderId || !text) {
    throw new CrablineError("Zalo webhook payload requires sender.id and message.text", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(false),
    ...(message && optionalString(message, "msg_id")
      ? { id: optionalString(message, "msg_id") }
      : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(senderId, ZALO_ID_RULE, "Zalo sender.id"),
  };
}
