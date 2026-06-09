import path from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Adapter } from "chat";
import { createiMessageAdapter } from "chat-adapter-imessage";
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

type IMessageAdapterApi = {
  fetchThread(threadId: string): Promise<unknown>;
  postMessage(
    threadId: string,
    message: string,
  ): Promise<{
    id: string;
    threadId: string;
  }>;
  startGatewayListener(
    options: { waitUntil(task: Promise<unknown>): void },
    durationMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<Response>;
};

type IMessageMessage = {
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

type IMessageThread = {
  id: string;
};

type IMessageState = {
  subscribe(threadId: string): Promise<void>;
};

type IMessageChat = {
  getState(): IMessageState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: IMessageThread, message: IMessageMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: IMessageThread, message: IMessageMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: IMessageThread, message: IMessageMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: IMessageThread, message: IMessageMessage) => void | Promise<void>,
  ): void;
};

type IMessageRuntime = {
  createAdapter(config: ProviderConfig, userName: string): IMessageAdapterApi;
  createChat(adapter: IMessageAdapterApi, userName: string): IMessageChat;
};

type IMessageEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "IMESSAGE_API_KEY" | "IMESSAGE_LOCAL" | "IMESSAGE_SERVER_URL">
>;

export function resolveIMessageAdapterConfig(
  config: ProviderConfig,
  env: IMessageEnvironment = process.env,
) {
  const iMessageConfig = config.imessage;
  const local =
    iMessageConfig?.local ?? (env.IMESSAGE_LOCAL ? env.IMESSAGE_LOCAL !== "false" : undefined);
  const apiKey = iMessageConfig?.apiKey ?? env.IMESSAGE_API_KEY;
  const serverUrl = iMessageConfig?.serverUrl ?? env.IMESSAGE_SERVER_URL;

  if (local === false) {
    if (!serverUrl) {
      throw new CrablineError(
        "iMessage remote mode requires imessage.serverUrl or IMESSAGE_SERVER_URL.",
        {
          kind: "config",
        },
      );
    }
    if (!apiKey) {
      throw new CrablineError(
        "iMessage remote mode requires imessage.apiKey or IMESSAGE_API_KEY.",
        {
          kind: "config",
        },
      );
    }
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(local !== undefined ? { local } : {}),
    ...(serverUrl ? { serverUrl } : {}),
  };
}

const DEFAULT_RUNTIME: IMessageRuntime = {
  createAdapter(config) {
    return createiMessageAdapter(
      resolveIMessageAdapterConfig(config),
    ) as unknown as IMessageAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ imessage: Adapter }>({
      adapters: { imessage: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as IMessageChat;
  },
};

function normalizeIMessageThreadId(value: string): string {
  return value.startsWith("imessage:") ? value : `imessage:${value}`;
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.imessage?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyIMessageFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/api key|unauthorized|401|forbidden/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class IMessageProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "imessage" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: IMessageRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: IMessageAdapterApi | null = null;
  #chat: IMessageChat | null = null;
  #gatewayAbort: AbortController | null = null;
  #gatewayTask: Promise<unknown> | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: IMessageRuntime = DEFAULT_RUNTIME,
  ) {
    this.id = id;
    this.#config = config;
    this.#recorderPath = toRecorderPath(id, config);
    this.#runtime = runtime;
    this.#userName = userName;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    return {
      id: target.id,
      metadata: target.metadata,
      threadId: normalizeIMessageThreadId(target.threadId ?? target.id),
    };
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      await this.#getChat().initialize();
      const target = this.normalizeTarget(context.fixture.target);
      await this.#getAdapter().fetchThread(target.threadId!);
      return {
        details: [`recorder path ${this.#recorderPath}`, `thread reachable ${target.threadId}`],
        healthy: true,
      };
    } catch (error) {
      throw classifyIMessageFailure(error);
    }
  }

  async send(context: SendContext): Promise<SendResult> {
    try {
      const chat = this.#getChat();
      await chat.initialize();
      const threadId = this.normalizeTarget(context.fixture.target).threadId!;
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
      await this.#ensureGatewayListener();
      return (
        (await waitForRecordedInbound({
          filePath: this.#recorderPath,
          matches: (event) => event.provider === this.id && event.threadId === context.threadId,
          since: context.since,
          timeoutMs: context.timeoutMs,
        })) ?? null
      );
    } catch (error) {
      throw classifyIMessageFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const threadId = this.normalizeTarget(context.fixture.target).threadId;
    await this.#getChat().initialize();
    await this.#ensureGatewayListener();

    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) => entry.provider === this.id && entry.threadId === threadId,
      since: context.since,
    })) {
      yield event;
    }
  }

  async cleanup(): Promise<void> {
    this.#gatewayAbort?.abort();
    this.#gatewayAbort = null;
    await this.#gatewayTask?.catch(() => {});
    this.#gatewayTask = null;
  }

  async #ensureGatewayListener(): Promise<void> {
    if (this.#gatewayTask) {
      return;
    }

    this.#gatewayAbort = new AbortController();
    const response = await this.#getAdapter().startGatewayListener(
      {
        waitUntil: (task) => {
          this.#gatewayTask = task.finally(() => {
            this.#gatewayTask = null;
            this.#gatewayAbort = null;
          });
        },
      },
      this.#config.imessage?.gatewayDurationMs ?? 180_000,
      this.#gatewayAbort.signal,
    );

    if (response.status >= 400) {
      throw new CrablineError(`iMessage gateway listener failed: ${await response.text()}`, {
        kind: "connectivity",
      });
    }
  }

  #registerInboundHandlers(): void {
    const chat = this.#chat;
    if (!chat) {
      return;
    }

    const record = async (thread: IMessageThread, message: IMessageMessage) => {
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

  #getAdapter(): IMessageAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config, this.#userName);
    }

    return this.#adapter;
  }

  #getChat(): IMessageChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
