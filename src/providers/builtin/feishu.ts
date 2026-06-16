import path from "node:path";
import { createLarkAdapter, type LarkAdapterConfig } from "@larksuite/vercel-chat-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Adapter } from "chat";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import {
  appendRecordedInbound,
  waitForRecordedInbound,
  watchRecordedInbound,
} from "../recorder.js";
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

type FeishuThread = {
  id: string;
};

type FeishuMessage = {
  author: {
    isBot: boolean;
  };
  id: string;
  metadata: {
    dateSent: Date;
  };
  raw?: unknown;
  text: string;
  threadId: string;
};

type FeishuState = {
  subscribe(threadId: string): Promise<void>;
};

type FeishuAdapterApi = {
  disconnect?(): Promise<void>;
  fetchChannelInfo(channelId: string): Promise<unknown>;
  openDM(userId: string): Promise<string>;
  postMessage(
    threadId: string,
    message: string,
  ): Promise<{
    id: string;
    threadId: string;
  }>;
};

type FeishuChat = {
  getState(): FeishuState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: FeishuThread, message: FeishuMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: FeishuThread, message: FeishuMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: FeishuThread, message: FeishuMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: FeishuThread, message: FeishuMessage) => void | Promise<void>,
  ): void;
};

type FeishuRuntime = {
  createAdapter(config: ProviderConfig): FeishuAdapterApi;
  createChat(adapter: FeishuAdapterApi, userName: string): FeishuChat;
};

type FeishuEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "FEISHU_APP_ID"
    | "FEISHU_APP_SECRET"
    | "FEISHU_BOT_USERNAME"
    | "LARK_APP_ID"
    | "LARK_APP_SECRET"
    | "LARK_BOT_USERNAME"
  >
>;

export function resolveFeishuAdapterConfig(
  config: ProviderConfig,
  env: FeishuEnvironment = process.env,
): LarkAdapterConfig {
  const feishuConfig = config.feishu;
  const appId = feishuConfig?.appId ?? env.FEISHU_APP_ID ?? env.LARK_APP_ID;
  const appSecret = feishuConfig?.appSecret ?? env.FEISHU_APP_SECRET ?? env.LARK_APP_SECRET;

  if (!appId) {
    throw new CrablineError("Feishu app id is required. Set feishu.appId or FEISHU_APP_ID.", {
      kind: "config",
    });
  }

  if (!appSecret) {
    throw new CrablineError(
      "Feishu app secret is required. Set feishu.appSecret or FEISHU_APP_SECRET.",
      { kind: "config" },
    );
  }

  return {
    appId,
    appSecret,
    ...((feishuConfig?.userName ?? env.FEISHU_BOT_USERNAME ?? env.LARK_BOT_USERNAME)
      ? { userName: feishuConfig?.userName ?? env.FEISHU_BOT_USERNAME ?? env.LARK_BOT_USERNAME! }
      : {}),
  };
}

const DEFAULT_RUNTIME: FeishuRuntime = {
  createAdapter(config) {
    return createLarkAdapter(resolveFeishuAdapterConfig(config)) as unknown as FeishuAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ lark: Adapter }>({
      adapters: { lark: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as FeishuChat;
  },
};

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isFeishuEncodedId(value: string): boolean {
  return value.startsWith("lark:");
}

function isFeishuChatId(value: string): boolean {
  return value.startsWith("oc_");
}

function normalizeFeishuChannelId(value: string): string {
  return isFeishuEncodedId(value) ? value : `lark:${value}:`;
}

function normalizeFeishuThreadId(channelId: string, threadId: string): string {
  if (isFeishuEncodedId(threadId)) {
    return threadId;
  }

  const chatId = channelId.replace(/^lark:/u, "").replace(/:$/u, "");
  return `lark:${chatId}:${threadId}`;
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.feishu?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyFeishuFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|app id|app secret|unauthorized|forbidden|token/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class FeishuProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "feishu" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: FeishuRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: FeishuAdapterApi | null = null;
  #chat: FeishuChat | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: FeishuRuntime = DEFAULT_RUNTIME,
  ) {
    this.id = id;
    this.#config = config;
    this.#recorderPath = toRecorderPath(id, config);
    this.#runtime = runtime;
    this.#userName = userName;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    const normalized: NormalizedTarget = {
      id: target.id,
      metadata: target.metadata,
    };

    if (target.channelId) {
      normalized.channelId = normalizeFeishuChannelId(target.channelId);
    } else if (!target.threadId && (isFeishuEncodedId(target.id) || isFeishuChatId(target.id))) {
      normalized.channelId = normalizeFeishuChannelId(target.id);
    }

    if (target.threadId) {
      normalized.channelId ??= normalizeFeishuChannelId(target.channelId ?? target.id);
      normalized.threadId = normalizeFeishuThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      await this.#getChat().initialize();
      const target = this.normalizeTarget(context.fixture.target);
      const details = [`recorder path ${this.#recorderPath}`, "websocket transport enabled"];

      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`chat reachable ${target.channelId}`);
      } else {
        const threadId = await this.#getAdapter().openDM(target.id);
        details.push(`dm reachable ${threadId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyFeishuFailure(error);
    }
  }

  async send(context: SendContext): Promise<SendResult> {
    try {
      const chat = this.#getChat();
      await chat.initialize();
      const threadId = await this.#resolveThreadId(context.fixture.target);
      await chat.getState().subscribe(threadId);
      const sent = await this.#getAdapter().postMessage(threadId, context.text);
      return {
        accepted: true,
        messageId: sent.id,
        threadId: sent.threadId,
      };
    } catch (error) {
      const kind = error instanceof CrablineError ? error.kind : "outbound";
      throw new CrablineError(ensureErrorMessage(error), {
        cause: error,
        ...(kind ? { kind } : {}),
      });
    }
  }

  async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    try {
      await this.#getChat().initialize();
      const target = this.normalizeTarget(context.fixture.target);
      const inbound = await waitForRecordedInbound({
        filePath: this.#recorderPath,
        matches: (event) =>
          event.provider === this.id &&
          isAddressInChannel(event.threadId, context.threadId ?? target.channelId),
        since: context.since,
        timeoutMs: context.timeoutMs,
      });
      return inbound ?? null;
    } catch (error) {
      throw classifyFeishuFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    await this.#getChat().initialize();

    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) =>
        entry.provider === this.id && isAddressInChannel(entry.threadId, target.channelId),
      since: context.since,
    })) {
      yield event;
    }
  }

  async cleanup(): Promise<void> {
    await this.#adapter?.disconnect?.();
  }

  #registerInboundHandlers(): void {
    const chat = this.#chat;
    if (!chat) {
      return;
    }
    const record = async (thread: FeishuThread, message: FeishuMessage) => {
      const key = `${thread.id}:${message.id}`;
      if (this.#seenMessages.has(key)) {
        return;
      }
      this.#seenMessages.add(key);

      await appendRecordedInbound(this.#recorderPath, {
        author: message.author.isBot ? "assistant" : "user",
        id: message.id,
        provider: this.id,
        raw: message.raw,
        sentAt: message.metadata.dateSent.toISOString(),
        text: message.text,
        threadId: thread.id,
      });
    };

    chat.onDirectMessage(record);
    chat.onNewMention(record);
    chat.onNewMessage(/[\s\S]+/u, record);
    chat.onSubscribedMessage(record);
  }

  async #resolveThreadId(target: ProviderContext["fixture"]["target"]): Promise<string> {
    const normalized = this.normalizeTarget(target);
    if (normalized.threadId) {
      return normalized.threadId;
    }

    if (normalized.channelId) {
      return normalized.channelId;
    }

    return this.#getAdapter().openDM(normalized.id);
  }

  #getAdapter(): FeishuAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): FeishuChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
