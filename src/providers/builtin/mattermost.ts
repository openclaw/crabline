import path from "node:path";
import { createMattermostAdapter, type MattermostAdapterConfig } from "chat-adapter-mattermost";
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

type MattermostThread = {
  id: string;
};

type MattermostMessage = {
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

type MattermostState = {
  subscribe(threadId: string): Promise<void>;
};

type MattermostAdapterApi = {
  disconnect?(): Promise<void>;
  fetchChannelInfo(channelId: string): Promise<unknown>;
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

type MattermostChat = {
  getState(): MattermostState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: MattermostThread, message: MattermostMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: MattermostThread, message: MattermostMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: MattermostThread, message: MattermostMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: MattermostThread, message: MattermostMessage) => void | Promise<void>,
  ): void;
};

type MattermostRuntime = {
  createAdapter(config: ProviderConfig): MattermostAdapterApi;
  createChat(adapter: MattermostAdapterApi, userName: string): MattermostChat;
};

type MattermostEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "MATTERMOST_BASE_URL"
    | "MATTERMOST_BOT_TOKEN"
    | "MATTERMOST_BOT_USERNAME"
    | "MATTERMOST_CALLBACK_URL"
  >
>;

export function resolveMattermostAdapterConfig(
  config: ProviderConfig,
  env: MattermostEnvironment = process.env,
): MattermostAdapterConfig {
  const mattermostConfig = config.mattermost;
  const baseUrl = mattermostConfig?.baseUrl ?? env.MATTERMOST_BASE_URL;
  const botToken = mattermostConfig?.botToken ?? env.MATTERMOST_BOT_TOKEN;

  if (!baseUrl) {
    throw new CrablineError(
      "Mattermost base URL is required. Set mattermost.baseUrl or MATTERMOST_BASE_URL.",
      { kind: "config" },
    );
  }

  if (!botToken) {
    throw new CrablineError(
      "Mattermost bot token is required. Set mattermost.botToken or MATTERMOST_BOT_TOKEN.",
      { kind: "config" },
    );
  }

  return {
    baseUrl,
    botToken,
    ...((mattermostConfig?.callbackUrl ??
    mattermostConfig?.webhook.publicUrl ??
    env.MATTERMOST_CALLBACK_URL)
      ? {
          callbackUrl:
            mattermostConfig?.callbackUrl ??
            mattermostConfig?.webhook.publicUrl ??
            env.MATTERMOST_CALLBACK_URL!,
        }
      : {}),
    ...((mattermostConfig?.userName ?? env.MATTERMOST_BOT_USERNAME)
      ? { userName: mattermostConfig?.userName ?? env.MATTERMOST_BOT_USERNAME! }
      : {}),
    ...(mattermostConfig?.websocket
      ? {
          websocket: {
            ...(mattermostConfig.websocket.enabled !== undefined
              ? { enabled: mattermostConfig.websocket.enabled }
              : {}),
            ...(mattermostConfig.websocket.maxReconnectDelayMs !== undefined
              ? { maxReconnectDelayMs: mattermostConfig.websocket.maxReconnectDelayMs }
              : {}),
            ...(mattermostConfig.websocket.reconnectDelayMs !== undefined
              ? { reconnectDelayMs: mattermostConfig.websocket.reconnectDelayMs }
              : {}),
          },
        }
      : {}),
  };
}

const DEFAULT_RUNTIME: MattermostRuntime = {
  createAdapter(config) {
    return createMattermostAdapter(
      resolveMattermostAdapterConfig(config),
    ) as unknown as MattermostAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ mattermost: Adapter }>({
      adapters: { mattermost: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as MattermostChat;
  },
};

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isMattermostEncodedId(value: string): boolean {
  return value.startsWith("mattermost:");
}

function isMattermostUserTarget(target: ProviderContext["fixture"]["target"]): boolean {
  return target.metadata.type === "dm" || target.metadata.targetType === "user";
}

function normalizeMattermostChannelId(value: string): string {
  return isMattermostEncodedId(value) ? value : `mattermost:${base64Url(value)}`;
}

function normalizeMattermostThreadId(channelId: string, threadId: string): string {
  if (isMattermostEncodedId(threadId)) {
    return threadId;
  }

  return `${channelId}:${base64Url(threadId)}`;
}

function toWebhookPath(config: ProviderConfig): string {
  return config.mattermost?.webhook.path ?? "/mattermost/webhook";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.mattermost?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyMattermostFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|bot token|unauthorized|forbidden|token/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class MattermostProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "mattermost" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: MattermostRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: MattermostAdapterApi | null = null;
  #chat: MattermostChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: MattermostRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeMattermostChannelId(target.channelId);
    } else if (!target.threadId && !isMattermostUserTarget(target)) {
      normalized.channelId = normalizeMattermostChannelId(target.id);
    }

    if (target.threadId) {
      normalized.channelId ??= normalizeMattermostChannelId(target.channelId ?? target.id);
      normalized.threadId = normalizeMattermostThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      await this.#getChat().initialize();
      const server = await this.#ensureWebhookServer(true);
      const target = this.normalizeTarget(context.fixture.target);
      const details = [
        `recorder path ${this.#recorderPath}`,
        "websocket transport enabled",
        `webhook endpoint ${server.endpointUrl}`,
      ];

      if (this.#config.mattermost?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.mattermost.webhook.publicUrl}`);
      }

      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`channel reachable ${target.channelId}`);
      } else {
        const threadId = await this.#getAdapter().openDM(target.id);
        details.push(`dm reachable ${threadId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyMattermostFailure(error);
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
      throw classifyMattermostFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    await this.#getChat().initialize();
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
    await this.#adapter?.disconnect?.();

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
    const record = async (thread: MattermostThread, message: MattermostMessage) => {
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
      this.#server = await startWebhookServer({
        handle: (request) => this.#getAdapter().handleWebhook(request),
        host: this.#config.mattermost?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.mattermost?.webhook.port ?? 8793,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.mattermost?.webhook.host ?? "127.0.0.1"}:${this.#config.mattermost?.webhook.port ?? 8793}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`Mattermost webhook server failed: ${ensureErrorMessage(error)}`, {
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

  #getAdapter(): MattermostAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): MattermostChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
