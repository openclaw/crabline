import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  FEISHU_CHAT_ID_RULE,
  FEISHU_MESSAGE_ID_RULE,
  getBuiltinTargetCodec,
} from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

export function resolveFeishuAdapterConfig(
  config: ProviderConfig,
  _env: NodeJS.ProcessEnv = process.env,
) {
  return {
    appId: config.feishu?.appId ?? "local-mock-feishu-app",
    userName: config.feishu?.userName,
  };
}

export function handleFeishuWebhookPayload(payload: unknown): Response | undefined {
  if (
    isRecord(payload) &&
    payload.type === "url_verification" &&
    typeof payload.challenge === "string"
  ) {
    return Response.json({ challenge: payload.challenge });
  }
  return undefined;
}

export class FeishuProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: getBuiltinTargetCodec("feishu"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/feishu/webhook", port: 8795 },
        endpointLabel: "webhook endpoint",
        handleWebhookPayload: handleFeishuWebhookPayload,
        normalizeWebhookPayload: normalizeFeishuWebhookPayload,
        platform: "feishu",
        publicUrl: config.feishu?.webhook.publicUrl,
        recorderPath: config.feishu?.recorder.path
          ? path.resolve(config.feishu.recorder.path)
          : undefined,
        webhook: config.feishu?.webhook,
      },
    });
  }
}

export function normalizeFeishuWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Feishu webhook payload must be an object", { kind: "inbound" });
  }

  const event = optionalRecord(payload, "event");
  const message = event ? optionalRecord(event, "message") : undefined;
  if (!message) {
    return genericMockPayloadWithNativeThread({
      channelRule: FEISHU_CHAT_ID_RULE,
      payload,
      threadRule: FEISHU_MESSAGE_ID_RULE,
    });
  }

  const chatId = optionalString(message, "chat_id");
  const messageType = optionalString(message, "message_type");
  const messageId = optionalString(message, "message_id");
  const rootId = optionalString(message, "root_id");
  const rawContent = optionalString(message, "content");
  const text = parseFeishuText(rawContent);
  if (messageType !== "text") {
    throw new CrablineError("Feishu event payload requires message.message_type=text", {
      kind: "inbound",
    });
  }
  if (!chatId || !text) {
    throw new CrablineError("Feishu event payload requires message.chat_id and message.content", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(false),
    ...(messageId
      ? { id: requireNativeInboundId(messageId, FEISHU_MESSAGE_ID_RULE, "Feishu message_id") }
      : {}),
    raw: payload,
    text,
    threadId: rootId
      ? requireNativeInboundId(rootId, FEISHU_MESSAGE_ID_RULE, "Feishu root_id")
      : requireNativeInboundId(chatId, FEISHU_CHAT_ID_RULE, "Feishu chat_id"),
  };
}

function parseFeishuText(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    return content;
  }
  return content;
}
