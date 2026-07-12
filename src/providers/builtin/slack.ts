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
    const channel = event.channel;
    const text = event.text;
    if (typeof channel !== "string" || typeof text !== "string") {
      throw new CrablineError("Slack event payload requires event.channel and event.text", {
        kind: "inbound",
      });
    }
    const threadTs = event.thread_ts;
    const ts = event.ts;
    return {
      author: slackAuthorFromEvent(event),
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

function matchesSlackThread(candidateThreadId: string, expectedThreadId?: string): boolean {
  if (!expectedThreadId) {
    return true;
  }
  if (
    candidateThreadId === expectedThreadId ||
    candidateThreadId.startsWith(`${expectedThreadId}:`)
  ) {
    return true;
  }
  const marker = ":thread:";
  if (SLACK_TS_RULE.pattern.test(expectedThreadId)) {
    const separator = candidateThreadId.indexOf(marker);
    if (separator <= 0) {
      return false;
    }
    const channelId = candidateThreadId.slice(0, separator);
    const threadTs = candidateThreadId.slice(separator + marker.length);
    return SLACK_CHANNEL_ID_RULE.pattern.test(channelId) && threadTs === expectedThreadId;
  }
  const separator = expectedThreadId.indexOf(marker);
  if (separator <= 0) {
    return false;
  }
  const channelId = expectedThreadId.slice(0, separator);
  const threadTs = expectedThreadId.slice(separator + marker.length);
  return (
    SLACK_CHANNEL_ID_RULE.pattern.test(channelId) &&
    SLACK_TS_RULE.pattern.test(threadTs) &&
    candidateThreadId === threadTs
  );
}

export class SlackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: getBuiltinTargetCodec("slack"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 8787 },
        endpointLabel: "events endpoint",
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
