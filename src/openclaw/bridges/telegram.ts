import { createHash } from "node:crypto";
import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";

const TELEGRAM_SYMBOLIC_DIRECT_ID_BASE = 1n << 51n;
const TELEGRAM_SYMBOLIC_DIRECT_ID_MASK = TELEGRAM_SYMBOLIC_DIRECT_ID_BASE - 1n;
const TELEGRAM_SYMBOLIC_GROUP_ID_BASE = 1_000_000_000_000n;
const TELEGRAM_SYMBOLIC_GROUP_ID_RANGE = 10_000_000_000n;
const TELEGRAM_OUTBOUND_METHOD_RE =
  /\/(sendAnimation|sendAudio|sendDocument|sendMessage|sendPhoto|sendVideo)$/u;

function normalizeTelegramChatId(kind: "direct" | "group", id: string): string {
  const value = id.trim();
  if (!value) {
    throw new Error("Telegram target is required.");
  }
  if (/^-?\d+$/u.test(value)) {
    const numericId = BigInt(value);
    if (numericId === 0n || (kind === "direct" ? numericId < 0n : numericId > 0n)) {
      throw new Error("Telegram numeric target sign does not match the declared target kind.");
    }
    if (
      numericId < BigInt(Number.MIN_SAFE_INTEGER) ||
      numericId > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Telegram numeric target must be a safe integer.");
    }
    return value;
  }
  const hash = createHash("sha256").update(`${kind}:${value}`).digest().readBigUInt64BE();
  if (kind === "group") {
    return String(-(TELEGRAM_SYMBOLIC_GROUP_ID_BASE + (hash % TELEGRAM_SYMBOLIC_GROUP_ID_RANGE)));
  }
  return String(TELEGRAM_SYMBOLIC_DIRECT_ID_BASE + (hash & TELEGRAM_SYMBOLIC_DIRECT_ID_MASK));
}

function telegramTargetKey(chatId: string, threadId?: number) {
  return threadId === undefined ? chatId : `${chatId}:topic:${threadId}`;
}

function telegramBotCommandEntity(text: string, commandName: string) {
  if (!/^[a-z0-9_]{1,32}$/u.test(commandName)) {
    throw new Error(
      "Telegram native command names must contain 1-32 lowercase letters, digits, or underscores.",
    );
  }
  const commandPrefix = `/${commandName}`;
  const token = text.match(/^\S+/u)?.[0];
  if (
    !token ||
    (token.toLowerCase() !== commandPrefix &&
      !new RegExp(`^/${commandName}@[A-Za-z][A-Za-z0-9_]{4,31}$`, "iu").test(token))
  ) {
    throw new Error(`Telegram native command text must start with ${commandPrefix}.`);
  }
  return {
    length: token.length,
    offset: 0,
    type: "bot_command",
  } as const;
}

function parseTelegramThreadTargetId(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = readString(value);
  if (!trimmed || !/^\d+$/u.test(trimmed)) {
    throw new Error("Telegram thread target must be a safe non-negative integer.");
  }
  const threadId = Number(trimmed);
  if (!Number.isSafeInteger(threadId)) {
    throw new Error("Telegram thread target must be a safe non-negative integer.");
  }
  return threadId;
}

export const TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "telegram",
  createAdapter(telegram) {
    return {
      async probe(signal) {
        const response = await fetch(
          `${telegram.endpoints.apiRoot}/bot${telegram.botToken}/getMe`,
          signal ? { signal } : {},
        );
        if (!response.ok) {
          throw new Error(`Crabline Telegram getMe probe failed with HTTP ${response.status}.`);
        }
        const payload = await response.json();
        if (!isRecord(payload) || payload.ok !== true) {
          const errorCode = readString(isRecord(payload) ? payload.error_code : undefined);
          const description = readNonBlankString(
            isRecord(payload) ? payload.description : undefined,
          );
          const detail = description ?? (errorCode ? `error ${errorCode}` : "invalid response");
          throw new Error(`Crabline Telegram getMe probe failed: ${detail}.`);
        }
        return payload;
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
        const kind = parsed.native && /^-\d+$/u.test(parsed.id.trim()) ? "group" : parsed.kind;
        const chatId = normalizeTelegramChatId(kind, parsed.id);
        const threadId = parseTelegramThreadTargetId(parsed.threadId);
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
        const threadId = parseTelegramThreadTargetId(input.threadId);
        return {
          ...createAdminInboundRequest(telegram),
          providerBody: {
            chatId,
            fromId: Number(normalizeTelegramChatId("direct", input.senderId)),
            fromName: input.senderName ?? input.senderId,
            ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
            ...(input.nativeCommand
              ? {
                  entities: [telegramBotCommandEntity(input.text, input.nativeCommand.name)],
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
          method === "sendMessage"
            ? readNonBlankString(event.body.text)
            : readNonBlankString(event.body.caption);
        if (!chatId || !text) {
          return null;
        }
        let threadId: number | undefined;
        try {
          threadId = parseTelegramThreadTargetId(event.body.message_thread_id);
        } catch {
          return null;
        }
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
