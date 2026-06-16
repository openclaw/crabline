import path from "node:path";
import { createZaloAdapter } from "chat-adapter-zalo";
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
import { startWebhookServer, type StartedWebhookServer } from "../webhook-server.js";

type ZaloThread = {
  id: string;
};

type ZaloMessage = {
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

type ZaloState = {
  subscribe(threadId: string): Promise<void>;
};

type ZaloAdapterApi = {
  fetchThread(threadId: string): Promise<unknown>;
  handleWebhook(request: Request): Promise<Response>;
  openDM(userId: string): Promise<string>;
  postMessage(
    threadId: string,
    message: string,
  ): Promise<{
    id: string;
    threadId: string;
  }>;
};

type ZaloChat = {
  getState(): ZaloState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: ZaloThread, message: ZaloMessage) => void | Promise<void>,
  ): void;
  onNewMention(handler: (thread: ZaloThread, message: ZaloMessage) => void | Promise<void>): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: ZaloThread, message: ZaloMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: ZaloThread, message: ZaloMessage) => void | Promise<void>,
  ): void;
};

type ZaloRuntime = {
  createAdapter(config: ProviderConfig): ZaloAdapterApi;
  createChat(adapter: ZaloAdapterApi, userName: string): ZaloChat;
};

type ZaloEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "ZALO_BOT_TOKEN" | "ZALO_BOT_USERNAME" | "ZALO_WEBHOOK_SECRET">
>;

export function resolveZaloAdapterConfig(
  config: ProviderConfig,
  env: ZaloEnvironment = process.env,
) {
  const zaloConfig = config.zalo;
  const botToken = zaloConfig?.botToken ?? env.ZALO_BOT_TOKEN;
  const webhookSecret = zaloConfig?.webhookSecret ?? env.ZALO_WEBHOOK_SECRET;

  if (!botToken) {
    throw new CrablineError("Zalo bot token is required. Set zalo.botToken or ZALO_BOT_TOKEN.", {
      kind: "config",
    });
  }

  if (!webhookSecret) {
    throw new CrablineError(
      "Zalo webhook secret is required. Set zalo.webhookSecret or ZALO_WEBHOOK_SECRET.",
      { kind: "config" },
    );
  }

  return {
    botToken,
    webhookSecret,
    ...((zaloConfig?.userName ?? env.ZALO_BOT_USERNAME)
      ? { userName: zaloConfig?.userName ?? env.ZALO_BOT_USERNAME! }
      : {}),
  };
}

const DEFAULT_RUNTIME: ZaloRuntime = {
  createAdapter(config) {
    return createZaloAdapter(resolveZaloAdapterConfig(config)) as unknown as ZaloAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ zalo: Adapter }>({
      adapters: { zalo: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as ZaloChat;
  },
};

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isZaloEncodedId(value: string): boolean {
  return value.startsWith("zalo:");
}

function normalizeZaloThreadId(value: string): string {
  return isZaloEncodedId(value) ? value : `zalo:${value}`;
}

function toWebhookPath(config: ProviderConfig): string {
  return config.zalo?.webhook.path ?? "/zalo/webhook";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.zalo?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyZaloFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|bot token|webhook secret|secret token|unauthorized|forbidden/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class ZaloProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "zalo" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: ZaloRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: ZaloAdapterApi | null = null;
  #chat: ZaloChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: ZaloRuntime = DEFAULT_RUNTIME,
  ) {
    this.id = id;
    this.#config = config;
    this.#recorderPath = toRecorderPath(id, config);
    this.#runtime = runtime;
    this.#userName = userName;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    const normalizedThreadId = normalizeZaloThreadId(
      target.threadId ?? target.channelId ?? target.id,
    );
    return {
      channelId: normalizedThreadId,
      id: target.id,
      metadata: target.metadata,
      ...(target.threadId ? { threadId: normalizedThreadId } : {}),
    };
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      await this.#getChat().initialize();
      const server = await this.#ensureWebhookServer(true);
      const target = this.normalizeTarget(context.fixture.target);
      const details = [
        `recorder path ${this.#recorderPath}`,
        `webhook endpoint ${server.endpointUrl}`,
      ];

      if (this.#config.zalo?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.zalo.webhook.publicUrl}`);
      }

      await this.#getAdapter().fetchThread(target.threadId ?? target.channelId ?? target.id);
      details.push(`chat reachable ${target.threadId ?? target.channelId ?? target.id}`);

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyZaloFailure(error);
    }
  }

  async send(context: SendContext): Promise<SendResult> {
    try {
      const chat = this.#getChat();
      await chat.initialize();
      const threadId = this.#resolveThreadId(context.fixture.target);
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
      await this.#ensureWebhookServer(true);
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
      throw classifyZaloFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    await this.#ensureWebhookServer(false);

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
    if (!this.#server) {
      return;
    }

    await this.#server.close();
    this.#server = null;
  }

  #registerInboundHandlers(): void {
    const chat = this.#chat;
    if (!chat) {
      return;
    }
    const record = async (thread: ZaloThread, message: ZaloMessage) => {
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

  async #ensureWebhookServer(allowExisting: boolean): Promise<StartedWebhookServer> {
    if (this.#server) {
      return this.#server;
    }

    try {
      const chat = this.#getChat();
      await chat.initialize();
      this.#server = await startWebhookServer({
        handle: (request) => this.#getAdapter().handleWebhook(request),
        host: this.#config.zalo?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.zalo?.webhook.port ?? 8794,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.zalo?.webhook.host ?? "127.0.0.1"}:${this.#config.zalo?.webhook.port ?? 8794}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`Zalo webhook server failed: ${ensureErrorMessage(error)}`, {
        cause: error,
        kind: "connectivity",
      });
    }
  }

  #resolveThreadId(target: ProviderContext["fixture"]["target"]): string {
    const normalized = this.normalizeTarget(target);
    return normalized.threadId ?? normalized.channelId ?? normalizeZaloThreadId(normalized.id);
  }

  #getAdapter(): ZaloAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): ZaloChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
