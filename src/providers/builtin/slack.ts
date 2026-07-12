import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import { slackTargetKey, SLACK_CHANNEL_ID_RULE, SLACK_TS_RULE } from "../slack-ids.js";
import { getBuiltinTargetCodec } from "../target-normalizers.js";
import type { InboundEnvelope, ProviderAdapter } from "../types.js";
import {
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

const SLACK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

type SlackEnvironment = Partial<Pick<NodeJS.ProcessEnv, "SLACK_SIGNING_SECRET">>;

export function resolveSlackAdapterConfig(
  config: ProviderConfig,
  env: SlackEnvironment = process.env,
) {
  return {
    signingSecret: config.slack?.signingSecret ?? env.SLACK_SIGNING_SECRET,
  };
}

function authenticateSlackWebhook(
  request: Request,
  rawBody: string,
  signingSecret: string,
): Response | undefined {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  const timestampSeconds = timestamp ? Number(timestamp) : Number.NaN;
  if (
    !timestamp ||
    !signature ||
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > SLACK_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return new Response("unauthorized", { status: 401 });
  }

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return new Response("unauthorized", { status: 401 });
  }
  return undefined;
}

function slackAuthorFromEvent(event: Record<string, unknown>): InboundEnvelope["author"] {
  if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    return "assistant";
  }
  return "user";
}

function normalizeSlackEventsPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Slack webhook payload must be an object", { kind: "inbound" });
  }

  if (isRecord(payload.event)) {
    const event = payload.event;
    const message =
      event.subtype === "message_changed" && isRecord(event.message) ? event.message : event;
    const channel = event.channel;
    const text = message.text;
    if (typeof channel !== "string" || typeof text !== "string") {
      throw new CrablineError("Slack event payload requires event.channel and event.text", {
        kind: "inbound",
      });
    }
    const threadTs = message.thread_ts;
    const ts = message.ts;
    return {
      author: slackAuthorFromEvent(message),
      ...(typeof ts === "string"
        ? { id: requireNativeInboundId(ts, SLACK_TS_RULE, "Slack event.ts") }
        : {}),
      raw: payload,
      text,
      threadId:
        typeof threadTs === "string"
          ? slackTargetKey(
              requireNativeInboundId(channel, SLACK_CHANNEL_ID_RULE, "Slack event.channel"),
              requireNativeInboundId(threadTs, SLACK_TS_RULE, "Slack event.thread_ts"),
            )
          : requireNativeInboundId(channel, SLACK_CHANNEL_ID_RULE, "Slack event.channel"),
    };
  }

  const normalized = genericMockPayloadWithNativeThread({
    channelRule: SLACK_CHANNEL_ID_RULE,
    payload,
    threadRule: SLACK_TS_RULE,
  });
  const message = isRecord(payload.message) ? payload.message : undefined;
  const channelId =
    (message ? optionalString(message, "channelId") : undefined) ??
    optionalString(payload, "channelId") ??
    optionalString(payload, "channel");
  const threadId =
    (message ? optionalString(message, "threadId") : undefined) ??
    optionalString(payload, "threadId");
  if (threadId && SLACK_TS_RULE.pattern.test(threadId) && !channelId) {
    throw new CrablineError("Slack timestamp threadId requires a native channelId", {
      kind: "inbound",
    });
  }
  if (!channelId || !threadId || !SLACK_TS_RULE.pattern.test(threadId)) {
    return normalized;
  }
  const scopedThreadId = slackTargetKey(
    requireNativeInboundId(channelId, SLACK_CHANNEL_ID_RULE, "Slack channelId"),
    threadId,
  );
  return {
    ...normalized,
    ...("message" in normalized && isRecord(normalized.message)
      ? { message: { ...normalized.message, threadId: scopedThreadId } }
      : {}),
    threadId: scopedThreadId,
  };
}

function matchesSlackThread(
  candidateThreadId: string,
  expectedThreadId: string | undefined,
  target: { channelId?: string | undefined },
): boolean {
  if (!expectedThreadId) {
    return true;
  }
  const scopedExpectedThreadId =
    target.channelId && SLACK_TS_RULE.pattern.test(expectedThreadId)
      ? slackTargetKey(target.channelId, expectedThreadId)
      : expectedThreadId;
  return (
    candidateThreadId === scopedExpectedThreadId ||
    candidateThreadId.startsWith(`${scopedExpectedThreadId}:`)
  );
}

export function handleSlackWebhookPayload(payload: unknown): Response | undefined {
  if (
    isRecord(payload) &&
    payload.type === "url_verification" &&
    typeof payload.challenge === "string"
  ) {
    return Response.json({ challenge: payload.challenge });
  }
  return undefined;
}

export class SlackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    const resolvedConfig = resolveSlackAdapterConfig(config);
    super({
      codec: getBuiltinTargetCodec("slack"),
      config,
      id,
      options: {
        ...(resolvedConfig.signingSecret
          ? {
              authenticateWebhookRequest(request: Request, rawBody: string) {
                return authenticateSlackWebhook(request, rawBody, resolvedConfig.signingSecret!);
              },
            }
          : {}),
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 8787 },
        endpointLabel: "events endpoint",
        handleWebhookPayload: handleSlackWebhookPayload,
        matchesThread: matchesSlackThread,
        normalizeWebhookPayload: normalizeSlackEventsPayload,
        platform: "slack",
        publicUrl: config.slack?.webhook.publicUrl,
        recorderPath: config.slack?.recorder.path
          ? path.resolve(config.slack.recorder.path)
          : undefined,
        webhook: config.slack?.webhook,
      },
    });
  }
}
