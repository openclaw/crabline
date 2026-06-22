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

const GOOGLE_CHAT_SPACE_RULE: NativeIdRule = {
  example: "spaces/AAAABbbbCCC",
  name: "Google Chat space name",
  pattern: /^spaces\/[A-Za-z0-9_-]+$/u,
};

const GOOGLE_CHAT_THREAD_RULE: NativeIdRule = {
  example: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
  name: "Google Chat thread name",
  pattern: /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/u,
};

export function resolveGoogleChatAdapterConfig(
  config: ProviderConfig,
  _env: NodeJS.ProcessEnv = process.env,
) {
  return {
    endpointUrl: config.googlechat?.endpointUrl,
    projectNumber: config.googlechat?.googleChatProjectNumber ?? "local-mock-googlechat",
    userName: config.googlechat?.userName,
  };
}

export class GoogleChatProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: GOOGLE_CHAT_SPACE_RULE,
        channelLabel: "Google Chat space.name",
        thread: GOOGLE_CHAT_THREAD_RULE,
        threadLabel: "Google Chat thread.name",
      }),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeGoogleChatWebhookPayload,
        platform: "googlechat",
        publicUrl: config.googlechat?.webhook.publicUrl,
        recorderPath: config.googlechat?.recorder.path
          ? path.resolve(config.googlechat.recorder.path)
          : undefined,
        webhook: config.googlechat?.webhook,
      },
    });
  }
}

function normalizeGoogleChatWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Google Chat webhook payload must be an object", {
      kind: "inbound",
    });
  }

  const payloadMessage = optionalRecord(payload, "message");
  const message = payloadMessage ?? payload;
  if (payloadMessage && optionalString(payloadMessage, "threadId")) {
    return genericMockPayloadWithNativeThread({
      channelRule: GOOGLE_CHAT_SPACE_RULE,
      payload,
      threadRule: GOOGLE_CHAT_THREAD_RULE,
    });
  }

  const space = optionalRecord(message, "space");
  const thread = optionalRecord(message, "thread");
  const sender = optionalRecord(message, "sender");
  const spaceName = space ? optionalString(space, "name") : undefined;
  const threadName = thread ? optionalString(thread, "name") : undefined;
  const text = optionalString(message, "text") ?? optionalString(message, "argumentText");
  if (!spaceName || !text) {
    throw new CrablineError("Google Chat message payload requires space.name and text", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(optionalString(sender ?? {}, "type") === "BOT"),
    ...(optionalString(message, "name") ? { id: optionalString(message, "name") } : {}),
    raw: payload,
    text,
    threadId: threadName
      ? requireNativeInboundId(threadName, GOOGLE_CHAT_THREAD_RULE, "Google Chat thread.name")
      : requireNativeInboundId(spaceName, GOOGLE_CHAT_SPACE_RULE, "Google Chat space.name"),
  };
}
