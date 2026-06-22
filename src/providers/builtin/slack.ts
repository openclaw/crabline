import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, type LocalMockTargetCodec } from "../local-mock.js";
import type {
  InboundEnvelope,
  NormalizedTarget,
  ProviderAdapter,
  ProviderContext,
} from "../types.js";
import {
  genericMockPayloadWithNativeThread,
  isRecord,
  requireNativeInboundId,
  type NativeIdRule,
} from "./native-local-mock.js";

const SLACK_CHANNEL_ID_RULE: NativeIdRule = {
  example: "C1234567890",
  name: "Slack conversation id",
  pattern: /^[CDG][A-Z0-9]{2,}$/u,
};

const SLACK_TS_RULE: NativeIdRule = {
  example: "1700000000.000100",
  name: "Slack timestamp",
  pattern: /^\d{10}\.\d{6}$/u,
};

function requireSlackChannelId(value: string, label: string): string {
  if (!SLACK_CHANNEL_ID_RULE.pattern.test(value)) {
    throw new CrablineError(
      `Slack ${label} must be a native Slack conversation id such as C1234567890, G1234567890, or D1234567890.`,
      { kind: "config" },
    );
  }
  return value;
}

function requireSlackThreadTs(value: string, label: string): string {
  if (!SLACK_TS_RULE.pattern.test(value)) {
    throw new CrablineError(`Slack ${label} must be a Slack timestamp such as 1700000000.000100.`, {
      kind: "config",
    });
  }
  return value;
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
          ? requireNativeInboundId(threadTs, SLACK_TS_RULE, "Slack event.thread_ts")
          : requireNativeInboundId(channel, SLACK_CHANNEL_ID_RULE, "Slack event.channel"),
    };
  }

  return genericMockPayloadWithNativeThread({
    channelRule: SLACK_CHANNEL_ID_RULE,
    payload,
    threadRule: SLACK_TS_RULE,
  });
}

const SLACK_CODEC: LocalMockTargetCodec = {
  normalize(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    const channelId = requireSlackChannelId(target.channelId ?? target.id, "channelId");
    const normalized: NormalizedTarget = {
      channelId,
      id: target.id,
      metadata: target.metadata,
    };
    if (target.threadId) {
      normalized.threadId = requireSlackThreadTs(target.threadId, "threadId");
    }
    return normalized;
  },
  resolveThreadId(target) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? normalized.id;
  },
};

export class SlackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: SLACK_CODEC,
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 8787 },
        endpointLabel: "events endpoint",
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
