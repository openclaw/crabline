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
  createSecretVerifier,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

type MattermostEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    "MATTERMOST_BASE_URL" | "MATTERMOST_BOT_TOKEN" | "MATTERMOST_TOKEN" | "MATTERMOST_URL"
  >
>;

export function resolveMattermostAdapterConfig(
  config: ProviderConfig,
  env: MattermostEnvironment = process.env,
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
  const configuredWebhookToken = config.mattermost?.webhookToken;
  const webhookToken = configuredWebhookToken ?? env.MATTERMOST_TOKEN;
  if (webhookToken !== undefined && !webhookToken.trim()) {
    throw new CrablineError(
      configuredWebhookToken === undefined
        ? "MATTERMOST_TOKEN must not be empty or whitespace-only."
        : "Mattermost webhookToken must not be empty or whitespace-only.",
      { kind: "config" },
    );
  }
  return {
    baseUrl,
    botToken: config.mattermost?.botToken ?? env.MATTERMOST_BOT_TOKEN ?? "local-mock-token",
    userName: config.mattermost?.userName,
    webhookToken,
  };
}

export class MattermostProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const env = (runtime as { env?: MattermostEnvironment } | undefined)?.env ?? process.env;
    const resolvedConfig = resolveMattermostAdapterConfig(config, env);
    const authenticateWebhook = resolvedConfig.webhookToken
      ? createSecretVerifier(resolvedConfig.webhookToken)
      : undefined;
    requireExternalWebhookAuthentication({
      authenticated: Boolean(authenticateWebhook),
      provider: "Mattermost",
      requirement: "webhookToken or MATTERMOST_TOKEN",
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
        ...(authenticateWebhook
          ? {
              authenticateWebhookRequest(request: Request, rawBody: string) {
                return authenticateWebhook(readMattermostWebhookToken(request, rawBody))
                  ? undefined
                  : new Response("unauthorized", { status: 401 });
              },
            }
          : {}),
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
        webhookMethods: ["POST"],
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
  if (
    target.channelId &&
    MATTERMOST_ID_RULE.pattern.test(expectedThreadId) &&
    expectedThreadId !== target.channelId
  ) {
    return candidateThreadId === mattermostThreadKey(target.channelId, expectedThreadId);
  }
  return (
    candidateThreadId === expectedThreadId ||
    (MATTERMOST_ID_RULE.pattern.test(expectedThreadId) &&
      candidateThreadId.startsWith(`${expectedThreadId}:thread:`))
  );
}

function readMattermostWebhookToken(request: Request, rawBody: string): string | null {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") {
    return new URLSearchParams(rawBody).get("token");
  }
  if (mediaType !== "application/json") {
    return null;
  }
  try {
    const payload = JSON.parse(rawBody) as unknown;
    return isRecord(payload) && typeof payload.token === "string" ? payload.token : null;
  } catch {
    return null;
  }
}

function withoutMattermostWebhookToken(payload: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...safePayload } = payload;
  return safePayload;
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

  const safePayload = withoutMattermostWebhookToken(payload);
  const genericMessage = optionalRecord(safePayload, "message");
  if (genericMessage) {
    const normalized = genericMockPayloadWithNativeThread({
      channelRule: MATTERMOST_ID_RULE,
      payload: safePayload,
      threadRule: MATTERMOST_ID_RULE,
    });
    const channelId =
      optionalString(genericMessage, "channelId") ?? optionalString(safePayload, "channelId");
    const rootId =
      optionalString(genericMessage, "threadId") ?? optionalString(safePayload, "threadId");
    if (!channelId || !rootId || channelId === rootId) {
      // Without channelId, the generic threadId is the channel-level conversation.
      return normalized as NormalizedMattermostWebhookPayload;
    }
    const scopedThreadId = mattermostThreadKey(
      requireNativeInboundId(channelId, MATTERMOST_ID_RULE, "Mattermost channelId"),
      requireNativeInboundId(rootId, MATTERMOST_ID_RULE, "Mattermost threadId"),
    );
    return {
      ...normalized,
      ...("message" in normalized && isRecord(normalized.message)
        ? { message: { ...normalized.message, threadId: scopedThreadId } }
        : {}),
      threadId: scopedThreadId,
    } as NormalizedMattermostWebhookPayload;
  }

  const channelId = optionalString(safePayload, "channel_id");
  const postId = optionalString(safePayload, "post_id");
  const rootId = optionalString(safePayload, "root_id");
  const text = optionalString(safePayload, "text");
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
    raw: safePayload,
    text,
    threadId: rootId
      ? mattermostThreadKey(
          requireNativeInboundId(channelId, MATTERMOST_ID_RULE, "Mattermost channel_id"),
          requireNativeInboundId(rootId, MATTERMOST_ID_RULE, "Mattermost root_id"),
        )
      : requireNativeInboundId(channelId, MATTERMOST_ID_RULE, "Mattermost channel_id"),
  };
}
