import { isIP } from "node:net";
import type { BuiltinAdapterId, FixtureDefinition, ProviderPlatform } from "../config/schema.js";
import { CrablineError } from "../core/errors.js";
import type { LocalMockTargetCodec } from "./local-mock.js";
import type { NativeIdRule } from "./native-ids.js";
import { slackTargetKey, SLACK_SEND_TARGET_ID_RULE, SLACK_TS_RULE } from "./slack-ids.js";
import type { NormalizedTarget } from "./types.js";

export type BuiltinProviderAdapterId = Exclude<BuiltinAdapterId, "script">;

export const DISCORD_SNOWFLAKE_RULE: NativeIdRule = {
  example: "123456789012345678",
  name: "Discord snowflake id",
  pattern: /^\d{17,20}$/u,
};

export const FEISHU_CHAT_ID_RULE: NativeIdRule = {
  example: "oc_abc123",
  name: "Feishu chat_id",
  pattern: /^oc_[A-Za-z0-9_-]+$/u,
};

export const FEISHU_MESSAGE_ID_RULE: NativeIdRule = {
  example: "om_abc123",
  name: "Feishu message_id",
  pattern: /^om_[A-Za-z0-9_-]+$/u,
};

export const GOOGLE_CHAT_SPACE_RULE: NativeIdRule = {
  example: "spaces/AAAABbbbCCC",
  name: "Google Chat space name",
  pattern: /^spaces\/[A-Za-z0-9_-]+$/u,
};

export const GOOGLE_CHAT_THREAD_RULE: NativeIdRule = {
  example: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
  name: "Google Chat thread name",
  pattern: /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/u,
};

export const IMESSAGE_THREAD_RULE: NativeIdRule = {
  example: "+15551234567, user@example.com, or iMessage;-;chat-guid",
  name: "iMessage recipient or chat GUID",
  pattern:
    /^(?:\+[1-9]\d{6,14}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:iMessage|SMS);[+-];.+)$/u,
};

export const MATRIX_ROOM_ID_RULE: NativeIdRule = {
  example: "!abcdef:matrix.org",
  name: "Matrix room id",
  pattern: /^!(?:[^:\s]+:[^\s]+|[A-Za-z0-9_-]{43})$/u,
};

export const MATRIX_EVENT_ID_RULE: NativeIdRule = {
  example: "$eventid:matrix.org",
  name: "Matrix event id",
  pattern: /^\$[^\s]+(?::[^\s]+)?$/u,
};

const MAX_MATRIX_IDENTIFIER_BYTES = 255;

function isMatrixIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function isMatrixServerName(value: string): boolean {
  const ipv6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  if (ipv6) {
    return isIP(ipv6[1]!) === 6;
  }
  const hostAndPort = /^([^:]+?)(?::(\d{1,5}))?$/u.exec(value);
  if (!hostAndPort) {
    return false;
  }
  const hostname = hostAndPort[1]!;
  if (isMatrixIpv4Address(hostname)) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) {
    return false;
  }
  return hostname.length <= 255 && /^[A-Za-z0-9.-]+$/u.test(hostname);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isMatrixScopedIdentifier(value: string, sigil: "!" | "$"): boolean {
  const separator = value.indexOf(":");
  const localpart = value.slice(1, separator);
  return (
    value.startsWith(sigil) &&
    Buffer.byteLength(value, "utf8") <= MAX_MATRIX_IDENTIFIER_BYTES &&
    separator >= 2 &&
    !localpart.includes("\0") &&
    !hasLoneSurrogate(localpart) &&
    isMatrixServerName(value.slice(separator + 1))
  );
}

function isMatrixHashIdentifier(
  value: string,
  sigil: "!" | "$",
  allowLegacyBase64: boolean,
): boolean {
  if (!value.startsWith(sigil) || Buffer.byteLength(value, "utf8") > MAX_MATRIX_IDENTIFIER_BYTES) {
    return false;
  }
  const opaqueId = value.slice(1);
  const encoding =
    allowLegacyBase64 && /^[A-Za-z0-9+/]{43}$/u.test(opaqueId)
      ? "base64"
      : /^[A-Za-z0-9_-]{43}$/u.test(opaqueId)
        ? "base64url"
        : undefined;
  if (!encoding) {
    return false;
  }
  const decoded = Buffer.from(opaqueId, encoding);
  return decoded.length === 32 && decoded.toString(encoding).replace(/=+$/u, "") === opaqueId;
}

export function isMatrixRoomId(value: string): boolean {
  return isMatrixScopedIdentifier(value, "!") || isMatrixHashIdentifier(value, "!", false);
}

export function isMatrixEventId(value: string): boolean {
  return isMatrixScopedIdentifier(value, "$") || isMatrixHashIdentifier(value, "$", true);
}

export const MATTERMOST_ID_RULE: NativeIdRule = {
  example: "abcdefghijklmnopqrstuvwx12",
  name: "Mattermost id",
  pattern: /^[a-z0-9]{26}$/u,
};

export const MSTEAMS_CONVERSATION_ID_RULE: NativeIdRule = {
  example: "a:opaque-conversation-id",
  name: "Microsoft Teams conversation id",
  pattern: /^.+$/su,
};

export const TELEGRAM_CHAT_ID_RULE: NativeIdRule = {
  example: "-1001234567890 or @channelusername",
  name: "Telegram chat id",
  pattern: /^(?:-?[1-9]\d*|@[A-Za-z][A-Za-z0-9_]{3,31})$/u,
};

export const TELEGRAM_MESSAGE_THREAD_ID_RULE: NativeIdRule = {
  example: "42",
  name: "Telegram message_thread_id",
  pattern: /^[1-9]\d*$/u,
};

export const WHATSAPP_WA_ID_RULE: NativeIdRule = {
  example: "15551234567",
  name: "WhatsApp wa_id",
  pattern: /^\d{7,15}$/u,
};

export const ZALO_ID_RULE: NativeIdRule = {
  example: "user-1",
  name: "Zalo string id",
  pattern: /^\S+$/u,
};

function requireNativeId(value: string, rule: NativeIdRule, label: string): string {
  if (!rule.pattern.test(value)) {
    throw new CrablineError(`${label} must be a native ${rule.name} such as ${rule.example}.`, {
      kind: "config",
    });
  }
  return value;
}

function createNativeTargetCodec(options: {
  channel: NativeIdRule;
  channelLabel?: string | undefined;
  thread?: NativeIdRule | undefined;
  threadLabel?: string | undefined;
}): LocalMockTargetCodec {
  const channelLabel = options.channelLabel ?? "channelId";
  const threadLabel = options.threadLabel ?? "threadId";
  const threadRule = options.thread ?? options.channel;

  return {
    normalize(target): NormalizedTarget {
      const channelId = requireNativeId(
        target.channelId ?? target.id,
        options.channel,
        channelLabel,
      );
      const normalized: NormalizedTarget = {
        channelId,
        id: target.id,
        metadata: target.metadata,
      };
      if (target.threadId) {
        normalized.threadId = requireNativeId(target.threadId, threadRule, threadLabel);
      }
      return normalized;
    },
    resolveThreadId(target) {
      const normalized = this.normalize(target);
      return normalized.threadId ?? normalized.channelId ?? normalized.id;
    },
  };
}

export function createGenericLocalMockTargetCodec(
  platform: ProviderPlatform,
): LocalMockTargetCodec {
  const prefix = `${platform}:`;
  const encode = (value: string) => (value.startsWith(prefix) ? value : `${prefix}${value}`);
  return {
    normalize(target): NormalizedTarget {
      const normalized: NormalizedTarget = {
        id: target.id,
        metadata: target.metadata,
      };
      if (target.channelId) {
        normalized.channelId = encode(target.channelId);
      } else if (!target.threadId) {
        normalized.channelId = encode(target.id);
      }
      if (target.threadId) {
        normalized.channelId ??= encode(target.id);
        if (
          target.threadId.startsWith(prefix) &&
          !target.threadId.startsWith(`${normalized.channelId}:`)
        ) {
          throw new CrablineError(
            `${platform} canonical thread parent must match the target channel.`,
            { kind: "config" },
          );
        }
        normalized.threadId = target.threadId.startsWith(prefix)
          ? target.threadId
          : `${normalized.channelId}:${target.threadId}`;
      }
      return normalized;
    },
    resolveThreadId(target) {
      const normalized = this.normalize(target);
      return normalized.threadId ?? normalized.channelId ?? encode(normalized.id);
    },
  };
}

function requireSlackSendTargetId(value: string, label: string): string {
  if (!SLACK_SEND_TARGET_ID_RULE.pattern.test(value)) {
    throw new CrablineError(
      `Slack ${label} must be a native Slack conversation or user id such as C1234567890, G1234567890, D1234567890, U1234567890, or W1234567890.`,
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

const SLACK_TARGET_CODEC: LocalMockTargetCodec = {
  normalize(target): NormalizedTarget {
    const channelId = requireSlackSendTargetId(target.channelId ?? target.id, "channelId");
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
    const channelId = normalized.channelId ?? normalized.id;
    return slackTargetKey(channelId, normalized.threadId);
  },
};

const TELEGRAM_BASE_CODEC = createNativeTargetCodec({
  channel: TELEGRAM_CHAT_ID_RULE,
  channelLabel: "Telegram chat_id",
  thread: TELEGRAM_MESSAGE_THREAD_ID_RULE,
  threadLabel: "Telegram message_thread_id",
});

export function parseCanonicalTelegramTopic(
  value: string,
): { chatId: string; topicId: string } | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const chatId = value.slice(0, separator);
  const topicId = value.slice(separator + 1);
  if (
    !TELEGRAM_CHAT_ID_RULE.pattern.test(chatId) ||
    !TELEGRAM_MESSAGE_THREAD_ID_RULE.pattern.test(topicId)
  ) {
    return undefined;
  }
  return { chatId, topicId };
}

const TELEGRAM_TARGET_CODEC: LocalMockTargetCodec = {
  normalize(target) {
    const canonicalTopic = target.threadId
      ? parseCanonicalTelegramTopic(target.threadId)
      : undefined;
    const targetChatId = target.channelId ?? target.id;
    if (
      canonicalTopic &&
      requireNativeId(targetChatId, TELEGRAM_CHAT_ID_RULE, "Telegram chat_id") !==
        canonicalTopic.chatId
    ) {
      throw new CrablineError("Telegram canonical topic chat_id must match the target chat_id.", {
        kind: "config",
      });
    }
    const normalized = TELEGRAM_BASE_CODEC.normalize({
      ...target,
      ...(canonicalTopic ? { channelId: canonicalTopic.chatId } : {}),
      threadId: undefined,
    });
    if (!target.threadId) {
      return normalized;
    }
    const topicId = requireNativeId(
      canonicalTopic?.topicId ?? target.threadId,
      TELEGRAM_MESSAGE_THREAD_ID_RULE,
      "Telegram message_thread_id",
    );
    return {
      ...normalized,
      threadId: `${normalized.channelId}:${topicId}`,
    };
  },
  resolveThreadId(target) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? normalized.id;
  },
};

const GOOGLE_CHAT_TARGET_CODEC: LocalMockTargetCodec = {
  normalize(target) {
    const channelId = requireNativeId(
      target.channelId ?? target.id,
      GOOGLE_CHAT_SPACE_RULE,
      "Google Chat space.name",
    );
    const normalized: NormalizedTarget = {
      channelId,
      id: target.id,
      metadata: target.metadata,
    };
    if (target.threadId) {
      const threadId = requireNativeId(
        target.threadId,
        GOOGLE_CHAT_THREAD_RULE,
        "Google Chat thread.name",
      );
      if (!threadId.startsWith(`${channelId}/threads/`)) {
        throw new CrablineError("Google Chat thread.name must belong to the target space.name.", {
          kind: "config",
        });
      }
      normalized.threadId = threadId;
    }
    return normalized;
  },
  resolveThreadId(target) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? normalized.id;
  },
};

const MATRIX_TARGET_CODEC: LocalMockTargetCodec = {
  normalize(target) {
    const channelId = target.channelId ?? target.id;
    if (!isMatrixRoomId(channelId)) {
      throw new CrablineError(
        `Matrix room_id must be a native ${MATRIX_ROOM_ID_RULE.name} such as ${MATRIX_ROOM_ID_RULE.example}.`,
        { kind: "config" },
      );
    }
    const normalized: NormalizedTarget = {
      channelId,
      id: target.id,
      metadata: target.metadata,
    };
    if (target.threadId) {
      if (!isMatrixEventId(target.threadId)) {
        throw new CrablineError(
          `Matrix event_id must be a native ${MATRIX_EVENT_ID_RULE.name} such as ${MATRIX_EVENT_ID_RULE.example}.`,
          { kind: "config" },
        );
      }
      normalized.threadId = target.threadId;
    }
    return normalized;
  },
  resolveThreadId(target) {
    const normalized = this.normalize(target);
    return normalized.threadId ?? normalized.channelId ?? normalized.id;
  },
};

const BUILTIN_TARGET_CODECS = {
  discord: createNativeTargetCodec({
    channel: DISCORD_SNOWFLAKE_RULE,
    channelLabel: "Discord channel_id",
    thread: DISCORD_SNOWFLAKE_RULE,
    threadLabel: "Discord thread id",
  }),
  feishu: createNativeTargetCodec({
    channel: FEISHU_CHAT_ID_RULE,
    channelLabel: "Feishu chat_id",
    thread: FEISHU_MESSAGE_ID_RULE,
    threadLabel: "Feishu message_id",
  }),
  googlechat: GOOGLE_CHAT_TARGET_CODEC,
  imessage: createNativeTargetCodec({
    channel: IMESSAGE_THREAD_RULE,
    channelLabel: "iMessage recipient or chat GUID",
  }),
  loopback: createGenericLocalMockTargetCodec("loopback"),
  matrix: MATRIX_TARGET_CODEC,
  mattermost: createNativeTargetCodec({
    channel: MATTERMOST_ID_RULE,
    channelLabel: "Mattermost channel_id",
  }),
  msteams: createNativeTargetCodec({
    channel: MSTEAMS_CONVERSATION_ID_RULE,
    channelLabel: "Microsoft Teams conversation.id",
  }),
  slack: SLACK_TARGET_CODEC,
  telegram: TELEGRAM_TARGET_CODEC,
  whatsapp: createNativeTargetCodec({
    channel: WHATSAPP_WA_ID_RULE,
    channelLabel: "WhatsApp wa_id",
  }),
  zalo: createNativeTargetCodec({
    channel: ZALO_ID_RULE,
    channelLabel: "Zalo user_id or oa_id",
  }),
} satisfies Record<BuiltinProviderAdapterId, LocalMockTargetCodec>;

export function getBuiltinTargetCodec(adapter: BuiltinProviderAdapterId): LocalMockTargetCodec {
  return BUILTIN_TARGET_CODECS[adapter];
}

export function normalizeBuiltinTarget(
  adapter: BuiltinProviderAdapterId,
  target: FixtureDefinition["target"],
): NormalizedTarget {
  return getBuiltinTargetCodec(adapter).normalize(target);
}
