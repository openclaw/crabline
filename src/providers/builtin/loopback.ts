import { randomUUID } from "node:crypto";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, resolveGeneratedLocalMockRecorderPath } from "../local-mock.js";
import { getBuiltinTargetCodec } from "../target-normalizers.js";
import type { LoopbackMessage, LoopbackRawMessage, ProviderAdapter } from "../types.js";

type ThreadAddress = {
  channelId?: string | undefined;
  id: string;
  threadId?: string | undefined;
};

type PostableMessage =
  | string
  | { card: unknown; fallbackText?: string }
  | { markdown: string }
  | { raw: string };

type StoredLoopbackMessage = {
  message: LoopbackMessage;
  sequence: number;
};

const LOOPBACK_V2_PREFIX = "loopback+v2:";

function createMessageId(): string {
  return `loopback-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRawMessage(raw: LoopbackRawMessage): LoopbackRawMessage {
  return { ...raw };
}

function cloneMessage(message: LoopbackMessage): LoopbackMessage {
  return {
    ...message,
    author: { ...message.author },
    metadata: {
      dateSent: new Date(message.metadata.dateSent),
      edited: message.metadata.edited,
      ...(message.metadata.editedAt ? { editedAt: new Date(message.metadata.editedAt) } : {}),
    },
    raw: cloneRawMessage(message.raw),
  };
}

function toPostableText(message: PostableMessage): string {
  if (typeof message === "string") {
    return message;
  }
  if ("raw" in message) {
    return message.raw;
  }
  if ("markdown" in message) {
    return message.markdown;
  }
  return message.fallbackText ?? "[card]";
}

function malformedThreadAddress(cause?: unknown): CrablineError {
  return new CrablineError("Loopback v2 thread address is malformed.", {
    ...(cause === undefined ? {} : { cause }),
    kind: "inbound",
  });
}

function decodeThreadAddressComponent(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    throw malformedThreadAddress(error);
  }
  if (!decoded || encodeURIComponent(decoded) !== value) {
    throw malformedThreadAddress();
  }
  return decoded;
}

export class LoopbackChatAdapter {
  readonly name = "loopback";
  readonly persistMessageHistory = true;
  readonly userName;

  readonly #messages = new Map<string, StoredLoopbackMessage[]>();
  readonly #nextSequence = new Map<string, number>();

  constructor(userName: string) {
    this.userName = userName;
  }

  addReaction(): Promise<void> {
    return Promise.resolve();
  }

  channelIdFromThreadId(threadId: string): string {
    const [address = threadId] = threadId.split("::");
    if (!threadId.startsWith(LOOPBACK_V2_PREFIX)) {
      return address;
    }
    return this.decodeThreadId(threadId).channelId ?? address;
  }

  decodeThreadId(threadId: string): ThreadAddress {
    if (threadId.startsWith(LOOPBACK_V2_PREFIX)) {
      const threadParts = threadId.split("::");
      if (threadParts.length > 2) {
        throw malformedThreadAddress();
      }
      const [address = "", rawThreadId] = threadParts;
      const addressParts = address.slice(LOOPBACK_V2_PREFIX.length).split(":");
      if (
        (addressParts.length !== 1 && addressParts.length !== 2) ||
        addressParts.some((part) => part.length === 0) ||
        rawThreadId === ""
      ) {
        throw malformedThreadAddress();
      }
      const [rawChannelOrId = "", rawId] = addressParts;
      const decoded: ThreadAddress = {
        id: decodeThreadAddressComponent(rawId ?? rawChannelOrId),
      };
      if (rawId !== undefined) {
        decoded.channelId = decodeThreadAddressComponent(rawChannelOrId);
      }
      if (rawThreadId !== undefined) {
        decoded.threadId = decodeThreadAddressComponent(rawThreadId);
      }
      return decoded;
    }

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
      messages.filter((entry) => entry.message.id !== messageId),
    );
    return Promise.resolve();
  }

  editMessage(
    threadId: string,
    messageId: string,
    message: PostableMessage,
  ): Promise<{ id: string; raw: LoopbackRawMessage; threadId: string }> {
    const messages = this.#messages.get(threadId) ?? [];
    const stored = messages.find((entry) => entry.message.id === messageId);
    if (!stored) {
      throw new CrablineError(`Loopback message not found: ${messageId}`, { kind: "inbound" });
    }

    const existing = stored.message;
    const text = toPostableText(message);
    existing.text = text;
    existing.formatted = text;
    existing.metadata.edited = true;
    existing.metadata.editedAt = new Date();
    existing.raw.text = text;
    return Promise.resolve({ id: existing.id, raw: cloneRawMessage(existing.raw), threadId });
  }

  encodeThreadId(platformData: ThreadAddress): string {
    const address = platformData.channelId
      ? `${LOOPBACK_V2_PREFIX}${encodeURIComponent(platformData.channelId)}:${encodeURIComponent(platformData.id)}`
      : `${LOOPBACK_V2_PREFIX}${encodeURIComponent(platformData.id)}`;
    return platformData.threadId
      ? `${address}::${encodeURIComponent(platformData.threadId)}`
      : address;
  }

  fetchMessages(
    threadId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ messages: LoopbackMessage[]; nextCursor?: string }> {
    const storedMessages = [...(this.#messages.get(threadId) ?? [])];
    if (
      options?.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit <= 0)
    ) {
      throw new CrablineError("Loopback message limit must be a positive safe integer.", {
        kind: "config",
      });
    }
    const limit = options?.limit ?? storedMessages.length;
    let cursor: number | undefined;
    if (options?.cursor) {
      if (!/^[1-9]\d*$/u.test(options.cursor)) {
        throw new CrablineError("Loopback message cursor must be a positive safe integer.", {
          kind: "config",
        });
      }
      cursor = Number(options.cursor);
      if (!Number.isSafeInteger(cursor) || cursor > (this.#nextSequence.get(threadId) ?? 0)) {
        throw new CrablineError(
          "Loopback message cursor must be a positive safe integer within message history.",
          { kind: "config" },
        );
      }
    }

    const eligibleMessages =
      cursor === undefined
        ? storedMessages
        : storedMessages.filter((entry) => entry.sequence < cursor);
    const page = eligibleMessages.slice(-limit);
    const result: { messages: LoopbackMessage[]; nextCursor?: string } = {
      messages: page.map((entry) => cloneMessage(entry.message)),
    };
    if (eligibleMessages.length > page.length && page[0]) {
      result.nextCursor = String(page[0].sequence);
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

  handleWebhook(_request?: Request): Promise<Response> {
    return Promise.resolve(
      new Response("loopback adapter has no webhook surface", { status: 501 }),
    );
  }

  isDM(): boolean {
    return true;
  }

  parseMessage(raw: LoopbackRawMessage): LoopbackMessage {
    return {
      author: {
        isMe: raw.author === "assistant",
        userName: raw.author === "assistant" ? this.userName : "loopback",
      },
      formatted: raw.text,
      id: raw.id,
      metadata: {
        dateSent: new Date(raw.timestamp),
        edited: false,
      },
      raw: cloneRawMessage(raw),
      text: raw.text,
      threadId: raw.threadId,
    };
  }

  postMessage(
    threadId: string,
    message: PostableMessage,
  ): Promise<{ id: string; raw: LoopbackRawMessage; threadId: string }> {
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
    return Promise.resolve({ id: raw.id, raw: cloneRawMessage(raw), threadId });
  }

  removeReaction(): Promise<void> {
    return Promise.resolve();
  }

  renderFormatted(content: string): string {
    return content;
  }

  startTyping(): Promise<void> {
    return Promise.resolve();
  }

  ingestUserMessage(threadId: string, text: string): LoopbackMessage {
    const raw = {
      author: "user",
      id: createMessageId(),
      text,
      threadId,
      timestamp: new Date().toISOString(),
    } satisfies LoopbackRawMessage;
    const parsed = this.parseMessage(raw);
    this.#append(threadId, parsed);
    return cloneMessage(parsed);
  }

  listSince(threadId: string, since: string): LoopbackMessage[] {
    const sinceTime = new Date(since).getTime();
    return (this.#messages.get(threadId) ?? [])
      .map((entry) => entry.message)
      .filter((message) => message.metadata.dateSent.getTime() >= sinceTime)
      .map(cloneMessage);
  }

  #append(threadId: string, message: LoopbackMessage): void {
    const bucket = this.#messages.get(threadId) ?? [];
    const sequence = (this.#nextSequence.get(threadId) ?? 0) + 1;
    bucket.push({ message: cloneMessage(message), sequence });
    this.#messages.set(threadId, bucket);
    this.#nextSequence.set(threadId, sequence);
  }
}

export class LoopbackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string) {
    super({
      codec: getBuiltinTargetCodec("loopback"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/loopback/webhook", port: 0 },
        endpointLabel: "webhook endpoint",
        platform: "loopback",
        recorderPath: resolveGeneratedLocalMockRecorderPath(id, `-${randomUUID()}`),
      },
    });
  }
}
