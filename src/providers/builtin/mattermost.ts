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

const MATTERMOST_ID_RULE: NativeIdRule = {
  example: "abcdefghijklmnopqrstuvwx12",
  name: "Mattermost id",
  pattern: /^[a-z0-9]{26}$/u,
};

export function resolveMattermostAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    baseUrl: config.mattermost?.baseUrl ?? env.MATTERMOST_BASE_URL ?? "http://mattermost.local",
    botToken: config.mattermost?.botToken ?? env.MATTERMOST_BOT_TOKEN ?? "local-mock-token",
    userName: config.mattermost?.userName,
  };
}

export class MattermostProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: MATTERMOST_ID_RULE,
        channelLabel: "Mattermost channel_id",
      }),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/mattermost/webhook", port: 8793 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeMattermostWebhookPayload,
        platform: "mattermost",
        publicUrl: config.mattermost?.webhook.publicUrl,
        recorderPath: config.mattermost?.recorder.path
          ? path.resolve(config.mattermost.recorder.path)
          : undefined,
        webhook: config.mattermost?.webhook,
      },
    });
  }
}

function normalizeMattermostWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Mattermost webhook payload must be an object", { kind: "inbound" });
  }

  if (optionalRecord(payload, "message")) {
    return genericMockPayloadWithNativeThread({
      channelRule: MATTERMOST_ID_RULE,
      payload,
      threadRule: MATTERMOST_ID_RULE,
    });
  }

  const channelId = optionalString(payload, "channel_id");
  const threadId = optionalString(payload, "root_id") ?? channelId;
  const text = optionalString(payload, "text");
  if (!channelId || !threadId || !text) {
    throw new CrablineError("Mattermost webhook payload requires channel_id and text", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(false),
    ...(optionalString(payload, "post_id") ? { id: optionalString(payload, "post_id") } : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(threadId, MATTERMOST_ID_RULE, "Mattermost root_id"),
  };
}
