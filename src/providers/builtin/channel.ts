import { extractNonce } from "../../core/nonces.js";
import type { ProviderConfig } from "../../config/schema.js";
import { TelegramLocalChannelDriver } from "../../channels/telegram.js";
import type { ChannelTranscriptEntry } from "../../channels/types.js";
import type {
  InboundEnvelope,
  NormalizedTarget,
  ProbeResult,
  ProviderAdapter,
  ProviderContext,
  SendContext,
  SendResult,
  WaitContext,
  WatchContext,
} from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LocalChannelProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "telegram" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #botUserName: string;
  readonly #driver = new TelegramLocalChannelDriver();
  readonly #qaResponseMode: "ack" | "echo" | "none";

  constructor(id: string, config: ProviderConfig) {
    this.id = id;
    this.#botUserName = config.channel?.botUserName ?? "multipass_telegram_bot";
    this.#qaResponseMode = config.channel?.qaResponse?.mode ?? "none";
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    const normalized: NormalizedTarget = { id: target.id, metadata: target.metadata };
    if (target.channelId) {
      normalized.channelId = target.channelId;
    }
    if (target.threadId) {
      normalized.threadId = target.threadId;
    }
    return normalized;
  }

  probe(): Promise<ProbeResult> {
    return Promise.resolve({
      details: [
        `channel driver ${this.#driver.metadata.driverId} ready`,
        `channel=${this.#driver.metadata.channel} live=${String(this.#driver.metadata.channelLive)}`,
        `capabilities=${this.#driver.metadata.capabilities.map((entry) => entry.id).join(",")}`,
      ],
      healthy: true,
    });
  }

  async send(context: SendContext): Promise<SendResult> {
    const target = this.normalizeTarget(context.fixture.target);
    const conversation = this.#driver.conversationFromTarget(target);
    const attachment = this.#driver.createMediaAttachment(target);
    const action = this.#driver.createNativeAction(target);
    const inbound = this.#driver.ingestEvent({
      action: action ?? undefined,
      actor: this.#driver.createUserActor(target),
      attachments: attachment ? [attachment] : [],
      conversation,
      kind: action ? "action" : "message",
      raw: createTelegramRawInbound(target, context.text, action),
      sentAt: new Date().toISOString(),
      text: context.text,
    });

    if (target.metadata.reconnect === "true") {
      this.#driver.ingestEvent({
        actor: { id: "telegram-local-upstream", isBot: true, role: "system" },
        conversation,
        kind: "connection",
        raw: { event: "reconnect", ok: true },
        sentAt: new Date().toISOString(),
        text: "telegram reconnect",
      });
    }

    const replyText = resolveQaReply(this.#qaResponseMode, context.text);
    if (replyText) {
      this.#driver.recordAction({
        actor: this.#driver.createAssistantActor(this.#botUserName),
        conversation,
        kind: "message",
        raw: {
          chat: conversation.id,
          driverId: this.#driver.metadata.driverId,
          method: "sendMessage",
          parse_mode: "Markdown",
        },
        replyToId: inbound.id,
        sentAt: new Date().toISOString(),
        text: replyText,
      });
    }

    return {
      accepted: true,
      messageId: inbound.id,
      threadId: encodeThreadId(conversation),
    };
  }

  async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    const target = this.normalizeTarget(context.fixture.target);
    const conversation = this.#driver.conversationFromTarget(target);
    const started = Date.now();

    while (Date.now() - started <= context.timeoutMs) {
      const matches = this.#driver.listSince({
        conversation,
        direction: "outbound",
        since: context.since,
      });
      if (matches.length > 0) {
        return toEnvelope(this.id, matches.at(-1)!);
      }

      await sleep(Math.min(200, context.timeoutMs));
    }

    return null;
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    const conversation = this.#driver.conversationFromTarget(target);
    const seen = new Set<string>();

    while (true) {
      const matches = this.#driver.listSince({
        conversation,
        direction: "inbound",
        since: context.since,
      });

      for (const entry of matches) {
        if (seen.has(entry.id)) {
          continue;
        }
        seen.add(entry.id);
        yield toEnvelope(this.id, entry);
      }

      await sleep(250);
    }
  }
}

function createTelegramRawInbound(
  target: NormalizedTarget,
  text: string,
  action: ReturnType<TelegramLocalChannelDriver["createNativeAction"]>,
): Record<string, unknown> {
  const chatType = target.metadata.chatType ?? "private";
  const raw: Record<string, unknown> = {
    chat: {
      id: target.channelId ?? target.id,
      type: chatType === "group" ? "supergroup" : "private",
    },
    from: {
      id: target.metadata.userId ?? target.id,
      is_bot: false,
      username: target.metadata.userName ?? "crabline-user",
    },
    text,
  };

  const topicId = target.threadId ?? target.metadata.topicId;
  if (topicId) {
    raw.message_thread_id = topicId;
  }
  if (target.metadata.mention === "true") {
    raw.entities = [{ type: "mention", user: target.metadata.botUserName ?? "@crabline" }];
  }
  if (action) {
    raw.callback_query = {
      data: action.payload,
      id: action.id,
      message: { text },
    };
  }

  return raw;
}

function encodeThreadId(conversation: { id: string; topicId?: string | undefined }): string {
  return conversation.topicId
    ? `${conversation.id}::topic:${conversation.topicId}`
    : conversation.id;
}

function resolveQaReply(mode: "ack" | "echo" | "none", text: string): string | null {
  if (mode === "none") {
    return null;
  }
  if (mode === "echo") {
    return text;
  }

  const nonce = extractNonce(text);
  return nonce ? `ACK ${nonce}` : "ACK";
}

function toEnvelope(providerId: string, entry: ChannelTranscriptEntry): InboundEnvelope {
  return {
    author: entry.actor.role === "assistant" ? "assistant" : entry.actor.role,
    id: entry.id,
    provider: providerId,
    raw: entry,
    sentAt: entry.sentAt,
    text: entry.text,
    threadId: encodeThreadId(entry.conversation),
  };
}
