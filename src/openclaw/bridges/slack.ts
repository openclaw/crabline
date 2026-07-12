import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";
import {
  slackTargetKey,
  SLACK_CHANNEL_ID_RULE,
  SLACK_SEND_TARGET_ID_RULE,
  SLACK_TS_RULE,
  SLACK_USER_ID_RULE,
} from "../../providers/slack-ids.js";

function requireSlackSendTargetId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SLACK_SEND_TARGET_ID_RULE.pattern.test(trimmed)) {
    throw new Error(`${label} must be a native Slack conversation or user id.`);
  }
  return trimmed;
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

export const SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "slack",
  createAdapter(slack) {
    return {
      async probe() {
        const response = await fetch(`${slack.endpoints.apiRoot}auth.test`, {
          headers: { authorization: `Bearer ${slack.botToken}` },
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`Crabline Slack auth.test probe failed with HTTP ${response.status}.`);
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
        return {
          channel: "slack",
          to,
          replyChannel: "slack",
          replyTo: slackTargetKey(to, threadTs),
        };
      },
      createInbound(input) {
        const channel = requireSlackChannelId(input.conversation.id, "Slack conversation");
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
            kind: channel.startsWith("D") ? "direct" : "group",
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
        const text = readNonBlankString(event.body.text);
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
