import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readInteger,
  readString,
} from "../shared.js";

const TELEGRAM_DIRECT_CHAT_ID = "100001";
const TELEGRAM_GROUP_CHAT_ID = "-1001234567890";
const TELEGRAM_DEFAULT_SENDER_ID = 100001;
const TELEGRAM_OUTBOUND_METHOD_RE =
  /\/(sendAnimation|sendDocument|sendMessage|sendPhoto|sendVideo)$/u;

function normalizeTelegramChatId(kind: "direct" | "group", id: string) {
  return /^-?\d+$/u.test(id.trim())
    ? id.trim()
    : kind === "group"
      ? TELEGRAM_GROUP_CHAT_ID
      : TELEGRAM_DIRECT_CHAT_ID;
}

function telegramTargetKey(chatId: string, threadId?: number) {
  return threadId === undefined ? chatId : `${chatId}:topic:${threadId}`;
}

export const TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "telegram",
  createAdapter(telegram) {
    return {
      async probe() {
        const response = await fetch(`${telegram.endpoints.apiRoot}/bot${telegram.botToken}/getMe`);
        if (!response.ok) {
          throw new Error(`Crabline Telegram getMe probe failed with HTTP ${response.status}.`);
        }
        return await response.json();
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "telegram",
          createChannelDriverSmokeEnv: (env) => ({
            ...env,
            TELEGRAM_BOT_TOKEN: telegram.botToken,
          }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const telegramConfig = isRecord(channels.telegram) ? channels.telegram : {};
            const groups = isRecord(telegramConfig.groups) ? telegramConfig.groups : {};
            const defaultGroup = isRecord(groups["*"]) ? groups["*"] : {};
            const messages = isRecord(openclawConfig.messages) ? openclawConfig.messages : {};
            const groupChat = isRecord(messages.groupChat) ? messages.groupChat : {};

            return {
              ...openclawConfig,
              channels: {
                ...channels,
                telegram: {
                  ...telegramConfig,
                  enabled: true,
                  botToken: telegram.botToken,
                  apiRoot: telegram.endpoints.apiRoot,
                  dmPolicy: "open",
                  groupPolicy: "open",
                  allowFrom: ["*"],
                  groupAllowFrom: ["*"],
                  groups: {
                    ...groups,
                    "*": {
                      ...defaultGroup,
                      requireMention: false,
                    },
                  },
                },
              },
              messages: {
                ...messages,
                groupChat: {
                  ...groupChat,
                  mentionPatterns: ["\\b@?openclaw\\b"],
                  visibleReplies: "automatic",
                },
              },
            };
          },
          requiredPluginIds: ["telegram"],
        };
      },
      createAgentDelivery(parsed) {
        const chatId = normalizeTelegramChatId(parsed.kind, parsed.id);
        const threadId = readInteger(parsed.threadId);
        const to = telegramTargetKey(chatId, threadId);
        return {
          channel: "telegram",
          to,
          replyChannel: "telegram",
          replyTo: to,
        };
      },
      createInbound(input) {
        const kind = input.conversation.kind === "direct" ? "direct" : "group";
        const chatId = normalizeTelegramChatId(kind, input.conversation.id);
        const threadId = readInteger(input.threadId);
        return {
          ...createAdminInboundRequest(telegram),
          providerBody: {
            chatId,
            fromId: readInteger(input.senderId) ?? TELEGRAM_DEFAULT_SENDER_ID,
            fromName: input.senderName ?? input.senderId,
            ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
            ...(input.nativeCommand
              ? {
                  entities: [
                    {
                      length: input.nativeCommand.name.length + 1,
                      offset: 0,
                      type: "bot_command",
                    },
                  ],
                }
              : {}),
            text: input.text,
          },
          providerTargetKey: telegramTargetKey(chatId, threadId),
          qaTarget: qaTargetForInbound(input),
          stateConversation: {
            id: chatId,
            kind: kind === "group" ? "group" : "direct",
          },
          ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (!isRecord(event) || event.type !== "api" || typeof event.path !== "string") {
          return null;
        }
        const method = TELEGRAM_OUTBOUND_METHOD_RE.exec(event.path)?.[1];
        if (!method || !isRecord(event.body)) {
          return null;
        }
        const chatId = readString(event.body.chat_id);
        const text =
          method === "sendMessage" && typeof event.body.text === "string" && event.body.text.trim()
            ? event.body.text
            : readString(event.body.caption);
        if (!chatId || !text) {
          return null;
        }
        const threadId = readInteger(event.body.message_thread_id);
        const providerTargetKey = telegramTargetKey(chatId, threadId);
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: "openclaw",
          senderName: "OpenClaw QA",
          text,
          to:
            targetByProviderTarget.get(providerTargetKey) ??
            (threadId === undefined ? chatId : providerTargetKey),
        };
      },
    };
  },
});
