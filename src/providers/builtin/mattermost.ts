import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import { getBuiltinTargetCodec, MATTERMOST_ID_RULE } from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

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
    requireExternalWebhookAuthentication({
      authenticated: false,
      provider: "Mattermost",
      requirement:
        "a provider-native authenticated ingress mode, which this adapter does not support",
      webhook: config.mattermost?.webhook,
    });
    super({
      codec: getBuiltinTargetCodec("mattermost"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/mattermost/webhook", port: 8793 },
        endpointLabel: "webhook endpoint",
        matchesThread: matchesMattermostThread,
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

function mattermostThreadKey(channelId: string, rootId: string): string {
  return `${channelId}:thread:${rootId}`;
}

export function matchesMattermostThread(
  candidateThreadId: string,
  expectedThreadId: string | undefined,
  target: { channelId?: string | undefined },
): boolean {
  if (!expectedThreadId) {
    return true;
  }
  const scopedExpected =
    target.channelId &&
    MATTERMOST_ID_RULE.pattern.test(expectedThreadId) &&
    expectedThreadId !== target.channelId
      ? mattermostThreadKey(target.channelId, expectedThreadId)
      : expectedThreadId;
  return (
    candidateThreadId === expectedThreadId ||
    candidateThreadId === scopedExpected ||
    (MATTERMOST_ID_RULE.pattern.test(scopedExpected) &&
      candidateThreadId.startsWith(`${scopedExpected}:thread:`))
  );
}

export function normalizeMattermostWebhookPayload(payload: unknown) {
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
  const postId = optionalString(payload, "post_id");
  const rootId = optionalString(payload, "root_id");
  const text = optionalString(payload, "text");
  if (!channelId || !text) {
    throw new CrablineError("Mattermost webhook payload requires channel_id and text", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(false),
    ...(postId
      ? { id: requireNativeInboundId(postId, MATTERMOST_ID_RULE, "Mattermost post_id") }
      : {}),
    raw: payload,
    text,
    threadId: rootId
      ? mattermostThreadKey(
          requireNativeInboundId(channelId, MATTERMOST_ID_RULE, "Mattermost channel_id"),
          requireNativeInboundId(rootId, MATTERMOST_ID_RULE, "Mattermost root_id"),
        )
      : requireNativeInboundId(channelId, MATTERMOST_ID_RULE, "Mattermost channel_id"),
  };
}
