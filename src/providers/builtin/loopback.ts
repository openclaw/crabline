import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
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

export class LoopbackChatAdapter {
  readonly name = "loopback";
  readonly persistMessageHistory = true;
  readonly userName;

  readonly #messages = new Map<string, LoopbackMessage[]>();

  constructor(userName: string) {
    this.userName = userName;
  }

  addReaction(): Promise<void> {
    return Promise.resolve();
  }

  channelIdFromThreadId(threadId: string): string {
    const [address = threadId] = threadId.split("::");
    if (!address.startsWith("loopback+v2:")) {
      return address;
    }
    return this.decodeThreadId(threadId).channelId ?? address;
  }

  decodeThreadId(threadId: string): ThreadAddress {
    const [address = threadId, rawThreadId] = threadId.split("::");
    const [platform, rawChannelOrId, rawId] = address.split(":");
    if (platform !== "loopback+v2" || !rawChannelOrId) {
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

    const decoded: ThreadAddress = {
      id: decodeURIComponent(rawId ?? rawChannelOrId),
    };
    if (rawId) {
      decoded.channelId = decodeURIComponent(rawChannelOrId);
    }
    if (rawThreadId) {
      decoded.threadId = decodeURIComponent(rawThreadId);
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
    message: PostableMessage,
  ): Promise<{ id: string; raw: LoopbackRawMessage; threadId: string }> {
    const messages = this.#messages.get(threadId) ?? [];
    const existing = messages.find((entry) => entry.id === messageId);
    if (!existing) {
      throw new CrablineError(`Loopback message not found: ${messageId}`, { kind: "inbound" });
    }

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
      ? `loopback+v2:${encodeURIComponent(platformData.channelId)}:${encodeURIComponent(platformData.id)}`
      : `loopback+v2:${encodeURIComponent(platformData.id)}`;
    return platformData.threadId
      ? `${address}::${encodeURIComponent(platformData.threadId)}`
      : address;
  }

  fetchMessages(
    threadId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ messages: LoopbackMessage[]; nextCursor?: string }> {
    const messages = [...(this.#messages.get(threadId) ?? [])];
    const limit = options?.limit ?? messages.length;
    if (!options?.cursor) {
      const result: { messages: LoopbackMessage[]; nextCursor?: string } = {
        messages: messages.slice(-limit).map(cloneMessage),
      };
      if (messages.length - limit > 0) {
        result.nextCursor = String(messages.length - limit);
      }
      return Promise.resolve(result);
    }

    const offset = Number(options.cursor);
    const result: { messages: LoopbackMessage[]; nextCursor?: string } = {
      messages: messages.slice(Math.max(0, offset - limit), offset).map(cloneMessage),
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
      .filter((entry) => entry.metadata.dateSent.getTime() >= sinceTime)
      .map(cloneMessage);
  }

  #append(threadId: string, message: LoopbackMessage): void {
    const bucket = this.#messages.get(threadId) ?? [];
    bucket.push(cloneMessage(message));
    this.#messages.set(threadId, bucket);
  }
}

export class LoopbackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string) {
    super({
      codec: getBuiltinTargetCodec("loopback"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/loopback/webhook", port: 8786 },
        endpointLabel: "webhook endpoint",
        platform: "loopback",
      },
    });
  }
}
