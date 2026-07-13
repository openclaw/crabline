import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { isLoopbackHost } from "../../servers/http.js";
import { LocalMockProviderAdapter, resolveGeneratedLocalMockRecorderPath } from "../local-mock.js";
import { appendRecordedInbound } from "../recorder.js";
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
  const baseUrl =
    config.mattermost?.baseUrl ??
    env.MATTERMOST_URL ??
    env.MATTERMOST_BASE_URL ??
    "http://127.0.0.1";
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error) {
    throw new CrablineError("Mattermost base URL is invalid.", {
      cause: error,
      kind: "config",
    });
  }
  if (
    parsedBaseUrl.protocol !== "https:" &&
    !(parsedBaseUrl.protocol === "http:" && isLoopbackHost(parsedBaseUrl.hostname))
  ) {
    throw new CrablineError(
      "Mattermost bearer authentication requires HTTPS; plain HTTP is allowed only for loopback-local servers.",
      { kind: "config" },
    );
  }
  return {
    baseUrl,
    botToken: config.mattermost?.botToken ?? env.MATTERMOST_BOT_TOKEN ?? "local-mock-token",
    userName: config.mattermost?.userName,
  };
}

export class MattermostProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    resolveMattermostAdapterConfig(config);
    requireExternalWebhookAuthentication({
      authenticated: false,
      provider: "Mattermost",
      requirement:
        "a provider-native authenticated ingress mode, which this adapter does not support",
      webhook: config.mattermost?.webhook,
    });
    const recorderPath = config.mattermost?.recorder.path
      ? path.resolve(config.mattermost.recorder.path)
      : resolveGeneratedLocalMockRecorderPath(id);
    super({
      codec: getBuiltinTargetCodec("mattermost"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/mattermost/webhook", port: 8793 },
        endpointLabel: "webhook endpoint",
        matchesThread: matchesMattermostThread,
        handleWebhookPayload: async (payload, request) => {
          const mediaType = request.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (mediaType !== "application/x-www-form-urlencoded" || typeof payload !== "string") {
            return undefined;
          }
          let normalized: ReturnType<typeof normalizeMattermostWebhookPayload>;
          try {
            normalized = normalizeMattermostWebhookPayload(
              Object.fromEntries(new URLSearchParams(payload).entries()),
            );
          } catch (error) {
            if (error instanceof CrablineError && error.kind === "inbound") {
              return new Response(error.message, { status: 400 });
            }
            throw error;
          }
          const messageId =
            normalized.id ??
            `mattermost-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await appendRecordedInbound(recorderPath, {
            author: normalized.author,
            id: messageId,
            provider: id,
            raw: normalized.raw,
            recordedDirection: "inbound",
            sentAt: new Date().toISOString(),
            text: normalized.text,
            threadId: normalized.threadId,
          });
          return new Response(JSON.stringify({ id: messageId, ok: true }), {
            headers: { "content-type": "application/json" },
          });
        },
        normalizeWebhookPayload: normalizeMattermostWebhookPayload,
        platform: "mattermost",
        publicUrl: config.mattermost?.webhook.publicUrl,
        recorderPath,
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

type NormalizedMattermostWebhookPayload = {
  author: "assistant" | "system" | "user";
  id?: string | undefined;
  raw: unknown;
  text: string;
  threadId: string;
};

export function normalizeMattermostWebhookPayload(
  payload: unknown,
): NormalizedMattermostWebhookPayload {
  if (!isRecord(payload)) {
    throw new CrablineError("Mattermost webhook payload must be an object", { kind: "inbound" });
  }

  if (optionalRecord(payload, "message")) {
    return genericMockPayloadWithNativeThread({
      channelRule: MATTERMOST_ID_RULE,
      payload,
      threadRule: MATTERMOST_ID_RULE,
    }) as NormalizedMattermostWebhookPayload;
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
