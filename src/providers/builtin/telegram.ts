import path from "node:path";
import { createTelegramAdapter } from "@chat-adapter/telegram";
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

type TelegramThread = {
  id: string;
};

type TelegramMessage = {
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

type TelegramState = {
  subscribe(threadId: string): Promise<void>;
};

type TelegramAdapterApi = {
  fetchChannelInfo(channelId: string): Promise<unknown>;
  openDM(userId: string): Promise<string>;
  postMessage(
    threadId: string,
    message: string,
  ): Promise<{
    id: string;
    threadId: string;
  }>;
  stopPolling?(): Promise<void>;
};

type TelegramChat = {
  getState(): TelegramState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: TelegramThread, message: TelegramMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: TelegramThread, message: TelegramMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: TelegramThread, message: TelegramMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: TelegramThread, message: TelegramMessage) => void | Promise<void>,
  ): void;
  webhooks: {
    telegram(request: Request): Promise<Response>;
  };
};

type TelegramRuntime = {
  createAdapter(config: ProviderConfig): TelegramAdapterApi;
  createChat(adapter: TelegramAdapterApi, userName: string): TelegramChat;
};

type TelegramEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "TELEGRAM_API_BASE_URL"
    | "TELEGRAM_BOT_TOKEN"
    | "TELEGRAM_BOT_USERNAME"
    | "TELEGRAM_WEBHOOK_SECRET_TOKEN"
  >
>;

function resolveLongPollingConfig(
  longPolling: NonNullable<NonNullable<ProviderConfig["telegram"]>["longPolling"]> | undefined,
) {
  if (!longPolling) {
    return undefined;
  }

  return {
    ...(longPolling.allowedUpdates ? { allowedUpdates: [...longPolling.allowedUpdates] } : {}),
    ...(longPolling.deleteWebhook !== undefined
      ? { deleteWebhook: longPolling.deleteWebhook }
      : {}),
    ...(longPolling.dropPendingUpdates !== undefined
      ? { dropPendingUpdates: longPolling.dropPendingUpdates }
      : {}),
    ...(longPolling.limit !== undefined ? { limit: longPolling.limit } : {}),
    ...(longPolling.retryDelayMs !== undefined ? { retryDelayMs: longPolling.retryDelayMs } : {}),
    ...(longPolling.timeout !== undefined ? { timeout: longPolling.timeout } : {}),
  };
}

export function resolveTelegramAdapterConfig(
  config: ProviderConfig,
  env: TelegramEnvironment = process.env,
) {
  const telegramConfig = config.telegram;
  const botToken = telegramConfig?.botToken ?? env.TELEGRAM_BOT_TOKEN;
  const longPolling = resolveLongPollingConfig(telegramConfig?.longPolling);

  if (!botToken) {
    throw new CrablineError(
      "Telegram bot token is required. Set telegram.botToken or TELEGRAM_BOT_TOKEN.",
      { kind: "config" },
    );
  }

  return {
    botToken,
    ...((telegramConfig?.apiUrl ?? env.TELEGRAM_API_BASE_URL)
      ? { apiUrl: telegramConfig?.apiUrl ?? env.TELEGRAM_API_BASE_URL! }
      : {}),
    ...(longPolling ? { longPolling } : {}),
    ...(telegramConfig?.mode ? { mode: telegramConfig.mode } : {}),
    ...((telegramConfig?.secretToken ?? env.TELEGRAM_WEBHOOK_SECRET_TOKEN)
      ? { secretToken: telegramConfig?.secretToken ?? env.TELEGRAM_WEBHOOK_SECRET_TOKEN! }
      : {}),
    ...((telegramConfig?.userName ?? env.TELEGRAM_BOT_USERNAME)
      ? { userName: telegramConfig?.userName ?? env.TELEGRAM_BOT_USERNAME! }
      : {}),
  };
}

const DEFAULT_RUNTIME: TelegramRuntime = {
  createAdapter(config) {
    return createTelegramAdapter(
      resolveTelegramAdapterConfig(config),
    ) as unknown as TelegramAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ telegram: Adapter }>({
      adapters: { telegram: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as TelegramChat;
  },
};

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isTelegramEncodedId(value: string): boolean {
  return value.startsWith("telegram:");
}

function normalizeTelegramChannelId(value: string): string {
  return isTelegramEncodedId(value) ? value : `telegram:${value}`;
}

function normalizeTelegramThreadId(channelId: string, threadId: string): string {
  if (isTelegramEncodedId(threadId)) {
    return threadId;
  }

  const chatId = channelId.replace(/^telegram:/u, "");
  return `telegram:${chatId}:${threadId}`;
}

function toWebhookPath(config: ProviderConfig): string {
  return config.telegram?.webhook.path ?? "/telegram/webhook";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.telegram?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyTelegramFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|bot token|unauthorized|forbidden|secret token/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class TelegramProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "telegram" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: TelegramRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: TelegramAdapterApi | null = null;
  #chat: TelegramChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: TelegramRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeTelegramChannelId(target.channelId);
    } else if (!target.threadId) {
      normalized.channelId = normalizeTelegramChannelId(target.id);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        normalized.channelId = normalizeTelegramChannelId(target.id);
      }

      normalized.threadId = normalizeTelegramThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      await this.#getChat().initialize();
      const server =
        this.#config.telegram?.mode === "polling" ? null : await this.#ensureWebhookServer(true);
      const target = this.normalizeTarget(context.fixture.target);
      const details = [`recorder path ${this.#recorderPath}`];

      if (server) {
        details.push(`webhook endpoint ${server.endpointUrl}`);
      } else {
        details.push("polling mode enabled");
      }

      if (this.#config.telegram?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.telegram.webhook.publicUrl}`);
      }

      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`chat reachable ${target.channelId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyTelegramFailure(error);
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
      if (this.#config.telegram?.mode !== "polling") {
        await this.#ensureWebhookServer(true);
      }
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
      throw classifyTelegramFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    if (this.#config.telegram?.mode !== "polling") {
      await this.#ensureWebhookServer(false);
    } else {
      await this.#getChat().initialize();
    }

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
    await this.#adapter?.stopPolling?.();

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
    const record = async (thread: TelegramThread, message: TelegramMessage) => {
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
      this.#server = await startWebhookServer({
        handle: (request) => chat.webhooks.telegram(request),
        host: this.#config.telegram?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.telegram?.webhook.port ?? 8790,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.telegram?.webhook.host ?? "127.0.0.1"}:${this.#config.telegram?.webhook.port ?? 8790}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`Telegram webhook server failed: ${ensureErrorMessage(error)}`, {
        cause: error,
        kind: "connectivity",
      });
    }
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

  #getAdapter(): TelegramAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): TelegramChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
