import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readString,
} from "../shared.js";
import {
  slackTargetKey,
  SLACK_CHANNEL_ID_RULE,
  SLACK_SEND_TARGET_ID_RULE,
  SLACK_TS_RULE,
  SLACK_USER_ID_RULE,
} from "../../providers/slack-ids.js";
import { throwProbeHttpError } from "./probe-response.js";

function requireSlackSendTargetId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SLACK_SEND_TARGET_ID_RULE.pattern.test(trimmed)) {
    throw new Error(`${label} must be a native Slack conversation or user id.`);
  }
  return trimmed;
}

function requireSlackTargetKind(
  parsed: { kind: "direct" | "group"; native: boolean; threadId?: string },
  targetId: string,
): void {
  if (parsed.native || parsed.threadId !== undefined) {
    return;
  }
  const nativeKind = /^[DUW]/u.test(targetId) ? "direct" : "group";
  if (parsed.kind !== nativeKind) {
    throw new Error("Slack target kind does not match the native conversation id.");
  }
}

function requireSlackChannelId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SLACK_CHANNEL_ID_RULE.pattern.test(trimmed)) {
    throw new Error(`${label} must be a native Slack conversation id.`);
  }
  return trimmed;
}

function requireSlackUserId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SLACK_USER_ID_RULE.pattern.test(trimmed)) {
    throw new Error(`${label} must be a native Slack user id.`);
  }
  return trimmed;
}

function requireSlackThreadTs(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!SLACK_TS_RULE.pattern.test(trimmed)) {
    throw new Error(`${label} must be a native Slack timestamp.`);
  }
  return trimmed;
}

function slackConversationKind(channel: string): "direct" | "group" {
  return channel.startsWith("D") ? "direct" : "group";
}

function pushSlackText(value: unknown, output: string[]): void {
  if (typeof value === "string" && value.trim()) {
    output.push(value);
  }
}

function structuredSlackValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

function slackOutboundText(body: Record<string, unknown>): string | undefined {
  if (typeof body.text === "string") {
    if (body.text.trim()) {
      return body.text;
    }
  }
  const fallback: string[] = [];
  collectSlackBlockText(structuredSlackValues(body.blocks), fallback);
  collectSlackAttachmentText(structuredSlackValues(body.attachments), fallback);
  return fallback.length > 0 ? fallback.join("\n") : undefined;
}

export const SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "slack",
  createAdapter(slack) {
    return {
      async probe(signal) {
        const response = await fetch(`${slack.endpoints.apiRoot}auth.test`, {
          headers: { authorization: `Bearer ${slack.botToken}` },
          method: "POST",
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          await throwProbeHttpError(
            response,
            `Crabline Slack auth.test probe failed with HTTP ${response.status}.`,
          );
        }
        const result: unknown = await response.json();
        if (!isRecord(result) || result.ok !== true) {
          const error = isRecord(result) ? readString(result.error) : undefined;
          throw new Error(`Crabline Slack auth.test probe failed: ${error ?? "unknown_error"}.`);
        }
        return result;
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "slack",
          createChannelDriverSmokeEnv: (env) => ({
            ...env,
            SLACK_API_URL: slack.endpoints.apiRoot,
            SLACK_BOT_TOKEN: slack.botToken,
            SLACK_SIGNING_SECRET: slack.signingSecret,
          }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const slackConfig = isRecord(channels.slack) ? channels.slack : {};
            const slackChannels = isRecord(slackConfig.channels) ? slackConfig.channels : {};
            const defaultSlackChannel = isRecord(slackChannels["*"]) ? slackChannels["*"] : {};

            return {
              ...openclawConfig,
              channels: {
                ...channels,
                slack: {
                  ...slackConfig,
                  enabled: true,
                  mode: "http",
                  botToken: slack.botToken,
                  signingSecret: slack.signingSecret,
                  webhookPath: "/slack/events",
                  dmPolicy: "open",
                  allowFrom: ["*"],
                  groupPolicy: "open",
                  channels: {
                    ...slackChannels,
                    "*": {
                      ...defaultSlackChannel,
                      requireMention: false,
                    },
                  },
                },
              },
            };
          },
          requiredPluginIds: ["slack"],
        };
      },
      createAgentDelivery(parsed) {
        const to = requireSlackSendTargetId(parsed.id, "Slack target");
        const threadTs = requireSlackThreadTs(parsed.threadId, "Slack target thread");
        if (threadTs && !SLACK_CHANNEL_ID_RULE.pattern.test(to)) {
          throw new Error("Slack thread targets require a native parent conversation id.");
        }
        requireSlackTargetKind(parsed, to);
        return {
          channel: "slack",
          to,
          replyChannel: "slack",
          replyTo: slackTargetKey(to, threadTs),
        };
      },
      createInbound(input) {
        const channel = requireSlackChannelId(input.conversation.id, "Slack conversation");
        const kind = slackConversationKind(channel);
        if (input.conversation.kind !== kind) {
          throw new Error("Slack inbound conversation kind does not match the native channel id.");
        }
        const user = requireSlackUserId(input.senderId, "Slack sender");
        const threadTs = requireSlackThreadTs(input.threadId, "Slack thread");
        return {
          ...createAdminInboundRequest(slack),
          providerBody: {
            channel,
            user,
            ...(input.senderName ? { username: input.senderName } : {}),
            ...(threadTs ? { threadTs } : {}),
            text: input.text,
          },
          providerTargetKey: slackTargetKey(channel, threadTs),
          qaTarget: qaTargetForInbound(input),
          stateConversation: {
            id: channel,
            kind,
          },
          ...(threadTs ? { threadId: threadTs } : {}),
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (!isRecord(event) || event.type !== "api" || typeof event.path !== "string") {
          return null;
        }
        if (!event.path.endsWith("/api/chat.postMessage") || !isRecord(event.body)) {
          return null;
        }
        const channel = readString(event.body.channel);
        const text = slackOutboundText(event.body);
        if (!channel || !text) {
          return null;
        }
        const threadTs = readString(event.body.thread_ts);
        const providerTargetKey = slackTargetKey(channel, threadTs);
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: "openclaw",
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(providerTargetKey) ?? providerTargetKey,
        };
      },
    };
  },
});
