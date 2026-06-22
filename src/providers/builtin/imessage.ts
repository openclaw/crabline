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

const IMESSAGE_THREAD_RULE: NativeIdRule = {
  example: "+15551234567, user@example.com, or iMessage;-;chat-guid",
  name: "iMessage recipient or chat GUID",
  pattern:
    /^(?:\+[1-9]\d{6,14}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:iMessage|SMS);[+-];.+)$/u,
};

export function resolveIMessageAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    apiKey: config.imessage?.apiKey ?? env.IMESSAGE_API_KEY ?? "local-mock-imessage-api-key",
    local: config.imessage?.local ?? true,
    serverUrl: config.imessage?.serverUrl ?? env.IMESSAGE_SERVER_URL,
  };
}

export class IMessageProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: IMESSAGE_THREAD_RULE,
        channelLabel: "iMessage recipient or chat GUID",
      }),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/imessage/webhook", port: 8796 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeIMessageWebhookPayload,
        platform: "imessage",
        publicUrl: config.imessage?.webhook.publicUrl,
        recorderPath: config.imessage?.recorder.path
          ? path.resolve(config.imessage.recorder.path)
          : undefined,
        webhook: config.imessage?.webhook,
      },
    });
  }
}

function normalizeIMessageWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("iMessage webhook payload must be an object", { kind: "inbound" });
  }

  if (optionalRecord(payload, "message")) {
    return genericMockPayloadWithNativeThread({
      channelRule: IMESSAGE_THREAD_RULE,
      payload,
      threadRule: IMESSAGE_THREAD_RULE,
    });
  }

  const data = optionalRecord(payload, "data") ?? payload;
  const threadId = optionalString(data, "chatGuid") ?? optionalString(data, "chatIdentifier");
  const text = optionalString(data, "text") ?? optionalString(data, "message");
  if (!threadId || !text) {
    throw new CrablineError("iMessage webhook payload requires chatGuid and text", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(data.isFromMe === true),
    ...(optionalString(data, "guid") ? { id: optionalString(data, "guid") } : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(threadId, IMESSAGE_THREAD_RULE, "iMessage chatGuid"),
  };
}
