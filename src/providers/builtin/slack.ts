import path from "node:path";
import { createSlackAdapter } from "@chat-adapter/slack";
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

type SlackThread = {
  id: string;
};

type SlackMessage = {
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

type SlackState = {
  subscribe(threadId: string): Promise<void>;
};

type SlackAdapterApi = {
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

type SlackChat = {
  getState(): SlackState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: SlackThread, message: SlackMessage) => void | Promise<void>,
  ): void;
  onNewMention(handler: (thread: SlackThread, message: SlackMessage) => void | Promise<void>): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: SlackThread, message: SlackMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: SlackThread, message: SlackMessage) => void | Promise<void>,
  ): void;
  webhooks: {
    slack(request: Request): Promise<Response>;
  };
};

type SlackRuntime = {
  createAdapter(userName: string): SlackAdapterApi;
  createChat(adapter: SlackAdapterApi, userName: string): SlackChat;
};

const DEFAULT_RUNTIME: SlackRuntime = {
  createAdapter(userName) {
    return createSlackAdapter({ userName });
  },
  createChat(adapter, userName) {
    return new Chat<{ slack: Adapter }>({
      adapters: { slack: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as SlackChat;
  },
};

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isSlackUserId(value: string): boolean {
  return /^U[A-Z0-9]+$/u.test(value);
}

function normalizeSlackChannelId(value: string): string {
  return value.startsWith("slack:") ? value : `slack:${value}`;
}

function normalizeSlackThreadId(channelId: string, threadId: string): string {
  if (threadId.startsWith("slack:")) {
    return threadId;
  }

  const channel = channelId.replace(/^slack:/u, "");
  return `slack:${channel}:${threadId}`;
}

function toWebhookPath(config: ProviderConfig): string {
  return config.slack?.webhook.path ?? "/slack/events";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.slack?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifySlackFailure(error: unknown): CrablineError {
  const message = ensureErrorMessage(error);
  if (/not_authed|invalid_auth|token/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class SlackProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "slack" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #seenMessages = new Set<string>();
  readonly #runtime: SlackRuntime;
  readonly #userName: string;
  #adapter: SlackAdapterApi | null = null;
  #chat: SlackChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: SlackRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeSlackChannelId(target.channelId);
    } else if (!target.threadId && !isSlackUserId(target.id)) {
      normalized.channelId = normalizeSlackChannelId(target.id);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        throw new CrablineError(`Slack target "${target.id}" requires channelId for thread send.`, {
          kind: "config",
        });
      }

      normalized.threadId = normalizeSlackThreadId(normalized.channelId, target.threadId);
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
        `webhook endpoint ${server.endpointUrl}`,
      ];

      if (this.#config.slack?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.slack.webhook.publicUrl}`);
      }

      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`channel reachable ${target.channelId}`);
      } else if (isSlackUserId(target.id)) {
        const threadId = await this.#getAdapter().openDM(target.id);
        details.push(`dm reachable ${threadId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifySlackFailure(error);
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
      throw classifySlackFailure(error);
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
    const record = async (thread: SlackThread, message: SlackMessage) => {
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
        handle: (request) => chat.webhooks.slack(request),
        host: this.#config.slack?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.slack?.webhook.port ?? 8787,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.slack?.webhook.host ?? "127.0.0.1"}:${this.#config.slack?.webhook.port ?? 8787}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`Slack webhook server failed: ${ensureErrorMessage(error)}`, {
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

    if (isSlackUserId(normalized.id)) {
      return this.#getAdapter().openDM(normalized.id);
    }

    throw new CrablineError(`Slack target "${normalized.id}" is not a valid channel or user id.`, {
      kind: "config",
    });
  }

  #getAdapter(): SlackAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#userName);
    }

    return this.#adapter;
  }

  #getChat(): SlackChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
