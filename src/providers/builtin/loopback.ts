import {
  type Adapter,
  type AdapterPostableMessage,
  Chat,
  type ChatInstance,
  type FetchOptions,
  type FetchResult,
  Message,
  type RawMessage,
  type WebhookOptions,
  parseMarkdown,
  toPlainText,
} from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { CrablineError } from "../../core/errors.js";
import { extractNonce } from "../../core/nonces.js";
import type { FixtureMode, ProviderConfig } from "../../config/schema.js";
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

type LoopbackRawMessage = {
  author: "assistant" | "user";
  id: string;
  text: string;
  threadId: string;
  timestamp: string;
};

type ThreadAddress = {
  channelId?: string | undefined;
  id: string;
  threadId?: string | undefined;
};

type LoopbackBehavior = "agent" | "echo" | "sink";

function createMessageId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAuthor(kind: "assistant" | "user") {
  return {
    fullName: kind === "assistant" ? "crabline-bot" : "loopback-user",
    isBot: kind === "assistant",
    isMe: kind === "assistant",
    userId: kind === "assistant" ? "loopback-bot" : "loopback-user",
    userName: kind === "assistant" ? "crabline" : "loopback",
  } as const;
}

export class LoopbackChatAdapter implements Adapter<ThreadAddress, LoopbackRawMessage> {
  readonly name = "loopback";
  readonly userName;
  readonly persistMessageHistory = true;

  readonly #messages = new Map<string, Message<LoopbackRawMessage>[]>();

  constructor(userName: string) {
    this.userName = userName;
  }

  addReaction(): Promise<void> {
    return Promise.resolve();
  }

  channelIdFromThreadId(threadId: string): string {
    const [channelId = threadId] = threadId.split("::");
    return channelId;
  }

  decodeThreadId(threadId: string): ThreadAddress {
    const [address = threadId, rawThreadId] = threadId.split("::");
    const [, channelId = address, id = address] = address.split(":");
    const decoded: ThreadAddress = { id };
    if (channelId) {
      decoded.channelId = channelId;
    }
    if (rawThreadId) {
      decoded.threadId = rawThreadId;
    }
    return decoded;
  }

  deleteMessage(threadId: string, messageId: string): Promise<void> {
    const messages = this.#messages.get(threadId) ?? [];
    this.#messages.set(
      threadId,
      messages.filter((entry) => entry.id !== messageId),
    );
    return Promise.resolve();
  }

  editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LoopbackRawMessage>> {
    const messages = this.#messages.get(threadId) ?? [];
    const existing = messages.find((entry) => entry.id === messageId);
    if (!existing) {
      throw new CrablineError(`Loopback message not found: ${messageId}`, { kind: "inbound" });
    }

    const text = toPostableText(message);
    existing.text = text;
    existing.formatted = parseMarkdown(text);
    existing.metadata.edited = true;
    existing.metadata.editedAt = new Date();
    existing.raw.text = text;
    return Promise.resolve({ id: existing.id, raw: existing.raw, threadId });
  }

  encodeThreadId(platformData: ThreadAddress): string {
    const channelId = platformData.channelId ?? `loopback:${platformData.id}`;
    return platformData.threadId ? `${channelId}::${platformData.threadId}` : channelId;
  }

  fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LoopbackRawMessage>> {
    const messages = [...(this.#messages.get(threadId) ?? [])];
    const limit = options?.limit ?? messages.length;
    if (!options?.cursor) {
      return Promise.resolve({
        messages: messages.slice(-limit),
      });
    }

    const offset = Number(options.cursor);
    const result: FetchResult<LoopbackRawMessage> = {
      messages: messages.slice(Math.max(0, offset - limit), offset),
    };
    if (offset - limit > 0) {
      result.nextCursor = String(offset - limit);
    }
    return Promise.resolve(result);
  }

  fetchThread(threadId: string) {
    return Promise.resolve({
      channelId: this.channelIdFromThreadId(threadId),
      id: threadId,
      isDM: true,
      metadata: {},
    });
  }

  handleWebhook(_: Request, __?: WebhookOptions): Promise<Response> {
    return Promise.resolve(
      new Response("loopback adapter has no webhook surface", { status: 501 }),
    );
  }

  initialize(_: ChatInstance): Promise<void> {
    return Promise.resolve();
  }

  isDM(): boolean {
    return true;
  }

  parseMessage(raw: LoopbackRawMessage): Message<LoopbackRawMessage> {
    return new Message({
      attachments: [],
      author: createAuthor(raw.author),
      formatted: parseMarkdown(raw.text),
      id: raw.id,
      metadata: {
        dateSent: new Date(raw.timestamp),
        edited: false,
      },
      raw,
      text: raw.text,
      threadId: raw.threadId,
    });
  }

  postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LoopbackRawMessage>> {
    const text = toPostableText(message);
    const raw = {
      author: "assistant",
      id: createMessageId(),
      text,
      threadId,
      timestamp: new Date().toISOString(),
    } satisfies LoopbackRawMessage;
    const parsed = this.parseMessage(raw);
    this.#append(threadId, parsed);
    return Promise.resolve({ id: raw.id, raw, threadId });
  }

  removeReaction(): Promise<void> {
    return Promise.resolve();
  }

  renderFormatted(content: Parameters<typeof toPlainText>[0]): string {
    return toPlainText(content);
  }

  startTyping(): Promise<void> {
    return Promise.resolve();
  }

  ingestUserMessage(threadId: string, text: string): Message<LoopbackRawMessage> {
    const raw = {
      author: "user",
      id: createMessageId(),
      text,
      threadId,
      timestamp: new Date().toISOString(),
    } satisfies LoopbackRawMessage;
    const parsed = this.parseMessage(raw);
    this.#append(threadId, parsed);
    return parsed;
  }

  listSince(threadId: string, since: string): Message<LoopbackRawMessage>[] {
    const sinceTime = new Date(since).getTime();
    return (this.#messages.get(threadId) ?? []).filter(
      (entry) => entry.metadata.dateSent.getTime() >= sinceTime,
    );
  }

  #append(threadId: string, message: Message<LoopbackRawMessage>): void {
    const bucket = this.#messages.get(threadId) ?? [];
    bucket.push(message);
    this.#messages.set(threadId, bucket);
  }
}

export class LoopbackProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "loopback" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #adapter: LoopbackChatAdapter;
  readonly #chat: Chat<{ loopback: LoopbackChatAdapter }>;
  readonly #behaviorByThread = new Map<string, LoopbackBehavior>();
  readonly #delayMs: number;

  constructor(id: string, config: ProviderConfig, userName: string) {
    this.id = id;
    this.#delayMs = config.loopback?.delayMs ?? 25;
    this.#adapter = new LoopbackChatAdapter(userName);
    this.#chat = new Chat({
      adapters: { loopback: this.#adapter },
      logger: "silent",
      state: createMemoryState(),
      userName,
    });

    this.#chat.onDirectMessage(async (thread, message) => {
      const behavior = this.#behaviorByThread.get(thread.id) ?? "echo";
      if (behavior === "sink") {
        return;
      }

      await sleep(this.#delayMs);
      if (behavior === "echo") {
        await thread.post(message.text);
        return;
      }

      const nonce = extractNonce(message.text);
      await thread.post(nonce ? `ACK ${nonce}` : "ACK");
    });

    void this.#chat.initialize();
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

  async probe(): Promise<ProbeResult> {
    await this.#chat.initialize();
    return {
      details: ["loopback adapter ready", "chat-sdk in-memory state ready"],
      healthy: true,
    };
  }

  async send(context: SendContext): Promise<SendResult> {
    await this.#chat.initialize();
    const target = this.normalizeTarget(context.fixture.target);
    const threadId = this.#adapter.encodeThreadId(toThreadAddress(target));
    this.#behaviorByThread.set(
      threadId,
      resolveBehavior(context.mode, context.fixture.target.behavior),
    );
    const message = this.#adapter.ingestUserMessage(threadId, context.text);
    await this.#chat.handleIncomingMessage(this.#adapter, threadId, message);
    return {
      accepted: true,
      messageId: message.id,
      threadId,
    };
  }

  async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    await this.#chat.initialize();
    const target = this.normalizeTarget(context.fixture.target);
    const threadId = this.#adapter.encodeThreadId(toThreadAddress(target));
    const started = Date.now();

    while (Date.now() - started <= context.timeoutMs) {
      const matches = this.#adapter
        .listSince(threadId, context.since)
        .filter((entry) => entry.author.isMe)
        .map((entry) => toEnvelope(this.id, entry));
      if (matches.length > 0) {
        return matches.at(-1) ?? null;
      }

      await sleep(Math.min(200, context.timeoutMs));
    }

    return null;
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    await this.#chat.initialize();
    const target = this.normalizeTarget(context.fixture.target);
    const threadId = this.#adapter.encodeThreadId(toThreadAddress(target));
    const seen = new Set<string>();
    const since = context.since ?? new Date(0).toISOString();

    while (true) {
      const messages = this.#adapter
        .listSince(threadId, since)
        .filter((entry) => !entry.author.isMe)
        .map((entry) => toEnvelope(this.id, entry));

      for (const message of messages) {
        if (seen.has(message.id)) {
          continue;
        }
        seen.add(message.id);
        yield message;
      }

      await sleep(250);
    }
  }
}

function resolveBehavior(mode: FixtureMode, configured?: LoopbackBehavior): LoopbackBehavior {
  if (configured) {
    return configured;
  }

  if (mode === "agent") {
    return "agent";
  }

  if (mode === "roundtrip") {
    return "echo";
  }

  return "sink";
}

function toEnvelope(providerId: string, message: Message<LoopbackRawMessage>): InboundEnvelope {
  return {
    author: message.author.isMe ? "assistant" : "user",
    id: message.id,
    provider: providerId,
    raw: message.raw,
    sentAt: message.metadata.dateSent.toISOString(),
    text: message.text,
    threadId: message.threadId,
  };
}

function toThreadAddress(target: NormalizedTarget): ThreadAddress {
  const address: ThreadAddress = { id: target.id };
  if (target.channelId) {
    address.channelId = target.channelId;
  }
  if (target.threadId) {
    address.threadId = target.threadId;
  }
  return address;
}

function toPostableText(message: AdapterPostableMessage): string {
  if (typeof message === "string") {
    return message;
  }
  if ("raw" in message) {
    return message.raw;
  }
  if ("markdown" in message) {
    return message.markdown;
  }
  if ("ast" in message) {
    return toPlainText(message.ast);
  }
  if ("card" in message) {
    return message.fallbackText ?? "[card]";
  }
  return "[card]";
}
