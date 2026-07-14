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
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

const SLACK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

type SlackEnvironment = Partial<Pick<NodeJS.ProcessEnv, "SLACK_SIGNING_SECRET">>;

export function resolveSlackAdapterConfig(
  config: ProviderConfig,
  env: SlackEnvironment = process.env,
) {
  const configuredSigningSecret = config.slack?.signingSecret;
  const signingSecret = configuredSigningSecret ?? env.SLACK_SIGNING_SECRET;
  if (signingSecret !== undefined && !signingSecret.trim()) {
    throw new CrablineError(
      configuredSigningSecret === undefined
        ? "SLACK_SIGNING_SECRET must not be empty or whitespace-only."
        : "Slack signingSecret must not be empty or whitespace-only.",
      { kind: "config" },
    );
  }
  return {
    signingSecret,
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

function pushSlackText(value: unknown, output: string[]): void {
  if (typeof value === "string" && value.trim()) {
    output.push(value);
  }
}

function slackInlineText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(slackInlineText).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "link" && typeof value.url === "string") {
    return typeof value.text === "string" && value.text.length > 0 ? value.text : value.url;
  }
  if (value.type === "user" && typeof value.user_id === "string") {
    return `<@${value.user_id}>`;
  }
  if (value.type === "channel" && typeof value.channel_id === "string") {
    return `<#${value.channel_id}>`;
  }
  if (value.type === "usergroup" && typeof value.usergroup_id === "string") {
    return `<!subteam^${value.usergroup_id}>`;
  }
  if (value.type === "emoji" && typeof value.name === "string") {
    return `:${value.name}:`;
  }
  if (value.type === "broadcast" && typeof value.range === "string") {
    return `<!${value.range}>`;
  }
  if (value.type === "date") {
    if (typeof value.fallback === "string" && value.fallback.length > 0) {
      return value.fallback;
    }
    if (
      (typeof value.timestamp === "number" || typeof value.timestamp === "string") &&
      typeof value.format === "string"
    ) {
      return `<!date^${value.timestamp}^${value.format}>`;
    }
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  return slackInlineText(value.elements);
}

function collectSlackTextValue(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    pushSlackText(value, output);
    return;
  }
  if (isRecord(value) && typeof value.text === "string") {
    pushSlackText(value.text, output);
    return;
  }
  collectSlackBlockText(value, output);
}

function collectSlackBlockText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSlackBlockText(entry, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (
    value.type === "rich_text_section" ||
    value.type === "rich_text_preformatted" ||
    value.type === "rich_text_quote"
  ) {
    pushSlackText(slackInlineText(value.elements), output);
    return;
  }
  for (const key of [
    "alt_text",
    "title",
    "body",
    "subtitle",
    "subtext",
    "details",
    "output",
  ] as const) {
    collectSlackTextValue(value[key], output);
  }
  collectSlackTextValue(value.text, output);
  for (const key of [
    "blocks",
    "elements",
    "fields",
    "rows",
    "tasks",
    "actions",
    "hero_image",
    "icon",
  ] as const) {
    collectSlackBlockText(value[key], output);
  }
}

function collectSlackAttachmentText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSlackAttachmentText(entry, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["fallback", "pretext", "author_name", "title", "text", "footer"] as const) {
    pushSlackText(value[key], output);
  }
  if (Array.isArray(value.fields)) {
    for (const field of value.fields) {
      if (!isRecord(field)) {
        continue;
      }
      pushSlackText(field.title, output);
      pushSlackText(field.value, output);
    }
  }
  collectSlackBlockText(value.blocks, output);
}

function slackMessageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }
  const fallback: string[] = [];
  collectSlackBlockText(message.blocks, fallback);
  collectSlackAttachmentText(message.attachments, fallback);
  return fallback.length > 0 ? fallback.join("\n") : undefined;
}

function hasMalformedSlackMessageContent(message: Record<string, unknown>): boolean {
  return (
    (message.text !== undefined && typeof message.text !== "string") ||
    (message.blocks !== undefined && !Array.isArray(message.blocks)) ||
    (message.attachments !== undefined && !Array.isArray(message.attachments))
  );
}

export function normalizeSlackEventsPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Slack webhook payload must be an object", { kind: "inbound" });
  }
  const { token: _token, ...safePayload } = payload;

  if (isRecord(payload.event)) {
    const event = payload.event;
    const isMessageChanged = event.subtype === "message_changed";
    const changedMessage = isRecord(event.message) ? event.message : undefined;
    if (isMessageChanged && !changedMessage) {
      throw new CrablineError("Slack message_changed event requires event.message", {
        kind: "inbound",
      });
    }
    const message = isMessageChanged ? changedMessage : event;
    if (!message || hasMalformedSlackMessageContent(message)) {
      throw new CrablineError("Slack event payload contains malformed message content", {
        kind: "inbound",
      });
    }
    const channel = event.channel;
    const text = slackMessageText(message);
    if (typeof channel !== "string" || text === undefined) {
      throw new CrablineError("Slack event payload requires event.channel and event.text", {
        kind: "inbound",
      });
    }
    const threadTs = message.thread_ts;
    const eventId = isMessageChanged
      ? optionalString(event, "event_ts")
      : optionalString(message, "ts");
    return {
      author: slackAuthorFromEvent(message),
      ...(eventId
        ? { id: requireNativeInboundId(eventId, SLACK_TS_RULE, "Slack event timestamp") }
        : {}),
      raw: safePayload,
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
    payload: safePayload,
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
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return Response.json({ challenge: payload.challenge });
  }
  if (payload.type === "event_callback") {
    if (!isRecord(payload.event)) {
      return undefined;
    }
    const eventType = optionalString(payload.event, "type");
    if (!eventType) {
      return new Response(null, { status: 200 });
    }
    if (eventType !== "message" && eventType !== "app_mention") {
      return new Response(null, { status: 200 });
    }
    const isMessageChanged = payload.event.subtype === "message_changed";
    if (isMessageChanged && !isRecord(payload.event.message)) {
      return undefined;
    }
    const message = isMessageChanged ? payload.event.message : payload.event;
    if (!isRecord(message)) {
      return undefined;
    }
    if (typeof payload.event.channel !== "string" || hasMalformedSlackMessageContent(message)) {
      return undefined;
    }
    if (slackMessageText(message) === undefined) {
      return new Response(null, { status: 200 });
    }
    return undefined;
  }
  if (typeof payload.type === "string" && payload.type.trim()) {
    return new Response(null, { status: 200 });
  }
  return undefined;
}

export class SlackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    const resolvedConfig = resolveSlackAdapterConfig(config);
    requireExternalWebhookAuthentication({
      authenticated: Boolean(resolvedConfig.signingSecret),
      provider: "Slack",
      requirement: "slack.signingSecret or SLACK_SIGNING_SECRET",
      webhook: config.slack?.webhook,
    });
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
