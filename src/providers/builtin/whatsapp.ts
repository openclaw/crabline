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

const WHATSAPP_WA_ID_RULE: NativeIdRule = {
  example: "15551234567",
  name: "WhatsApp wa_id",
  pattern: /^\d{7,15}$/u,
};

export function resolveWhatsAppAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    accessToken: config.whatsapp?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN ?? "local-mock-token",
    appSecret: config.whatsapp?.appSecret ?? env.WHATSAPP_APP_SECRET ?? "local-mock-secret",
    phoneNumberId:
      config.whatsapp?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID ?? "local-mock-phone",
    verifyToken: config.whatsapp?.verifyToken ?? env.WHATSAPP_VERIFY_TOKEN ?? "local-mock-verify",
  };
}

export class WhatsAppProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: WHATSAPP_WA_ID_RULE,
        channelLabel: "WhatsApp wa_id",
      }),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/whatsapp/webhook", port: 8789 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeWhatsAppWebhookPayload,
        platform: "whatsapp",
        publicUrl: config.whatsapp?.webhook.publicUrl,
        recorderPath: config.whatsapp?.recorder.path
          ? path.resolve(config.whatsapp.recorder.path)
          : undefined,
        webhook: config.whatsapp?.webhook,
      },
    });
  }
}

function normalizeWhatsAppWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("WhatsApp webhook payload must be an object", { kind: "inbound" });
  }

  let message: Record<string, unknown> | undefined;
  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      if (!isRecord(entry) || !Array.isArray(entry.changes)) {
        continue;
      }
      for (const change of entry.changes) {
        if (!isRecord(change)) {
          continue;
        }
        const value = optionalRecord(change, "value");
        const candidate =
          value && Array.isArray(value.messages) ? value.messages.find(isRecord) : undefined;
        if (candidate) {
          message = candidate;
          break;
        }
      }
      if (message) {
        break;
      }
    }
  }
  if (!message) {
    return genericMockPayloadWithNativeThread({
      channelRule: WHATSAPP_WA_ID_RULE,
      payload,
      threadRule: WHATSAPP_WA_ID_RULE,
    });
  }

  const text = optionalRecord(message, "text");
  const from = optionalString(message, "from");
  const body = text ? optionalString(text, "body") : undefined;
  if (!from || !body) {
    throw new CrablineError("WhatsApp webhook payload requires messages[].from and text.body", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(false),
    ...(optionalString(message, "id") ? { id: optionalString(message, "id") } : {}),
    raw: payload,
    text: body,
    threadId: requireNativeInboundId(from, WHATSAPP_WA_ID_RULE, "WhatsApp messages[].from"),
  };
}
