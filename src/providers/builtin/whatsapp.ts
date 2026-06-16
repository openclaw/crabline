import path from "node:path";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
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

type WhatsAppThread = {
  id: string;
};

type WhatsAppMessage = {
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

type WhatsAppState = {
  subscribe(threadId: string): Promise<void>;
};

type WhatsAppAdapterApi = {
  fetchThread(threadId: string): Promise<unknown>;
  openDM(userId: string): Promise<string>;
  postMessage(
    threadId: string,
    message: string,
  ): Promise<{
    id: string;
    threadId: string;
  }>;
};

type WhatsAppChat = {
  getState(): WhatsAppState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: WhatsAppThread, message: WhatsAppMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: WhatsAppThread, message: WhatsAppMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: WhatsAppThread, message: WhatsAppMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: WhatsAppThread, message: WhatsAppMessage) => void | Promise<void>,
  ): void;
  webhooks: {
    whatsapp(request: Request): Promise<Response>;
  };
};

type WhatsAppRuntime = {
  createAdapter(config: ProviderConfig): WhatsAppAdapterApi;
  createChat(adapter: WhatsAppAdapterApi, userName: string): WhatsAppChat;
};

type WhatsAppEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "WHATSAPP_ACCESS_TOKEN"
    | "WHATSAPP_API_URL"
    | "WHATSAPP_APP_SECRET"
    | "WHATSAPP_BOT_USERNAME"
    | "WHATSAPP_PHONE_NUMBER_ID"
    | "WHATSAPP_VERIFY_TOKEN"
  >
>;

export function resolveWhatsAppAdapterConfig(
  config: ProviderConfig,
  env: WhatsAppEnvironment = process.env,
) {
  const whatsappConfig = config.whatsapp;
  const accessToken = whatsappConfig?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN;
  const appSecret = whatsappConfig?.appSecret ?? env.WHATSAPP_APP_SECRET;
  const phoneNumberId = whatsappConfig?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = whatsappConfig?.verifyToken ?? env.WHATSAPP_VERIFY_TOKEN;

  if (!accessToken) {
    throw new CrablineError(
      "WhatsApp access token is required. Set whatsapp.accessToken or WHATSAPP_ACCESS_TOKEN.",
      { kind: "config" },
    );
  }
  if (!appSecret) {
    throw new CrablineError(
      "WhatsApp app secret is required. Set whatsapp.appSecret or WHATSAPP_APP_SECRET.",
      { kind: "config" },
    );
  }
  if (!phoneNumberId) {
    throw new CrablineError(
      "WhatsApp phone number id is required. Set whatsapp.phoneNumberId or WHATSAPP_PHONE_NUMBER_ID.",
      { kind: "config" },
    );
  }
  if (!verifyToken) {
    throw new CrablineError(
      "WhatsApp verify token is required. Set whatsapp.verifyToken or WHATSAPP_VERIFY_TOKEN.",
      { kind: "config" },
    );
  }

  return {
    accessToken,
    appSecret,
    phoneNumberId,
    verifyToken,
    ...((whatsappConfig?.apiUrl ?? env.WHATSAPP_API_URL)
      ? { apiUrl: whatsappConfig?.apiUrl ?? env.WHATSAPP_API_URL! }
      : {}),
    ...(whatsappConfig?.apiVersion ? { apiVersion: whatsappConfig.apiVersion } : {}),
    ...((whatsappConfig?.userName ?? env.WHATSAPP_BOT_USERNAME)
      ? { userName: whatsappConfig?.userName ?? env.WHATSAPP_BOT_USERNAME! }
      : {}),
  };
}

const DEFAULT_RUNTIME: WhatsAppRuntime = {
  createAdapter(config) {
    return createWhatsAppAdapter(
      resolveWhatsAppAdapterConfig(config),
    ) as unknown as WhatsAppAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ whatsapp: Adapter }>({
      adapters: { whatsapp: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as WhatsAppChat;
  },
};

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isWhatsAppEncodedId(value: string): boolean {
  return value.startsWith("whatsapp:");
}

function encodeWhatsAppThreadId(phoneNumberId: string, userWaId: string): string {
  return `whatsapp:${phoneNumberId}:${userWaId}`;
}

function configuredPhoneNumberId(config: ProviderConfig): string | undefined {
  return config.whatsapp?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function normalizeWhatsAppThreadId(config: ProviderConfig, value: string): string {
  if (isWhatsAppEncodedId(value)) {
    return value;
  }

  const phoneNumberId = configuredPhoneNumberId(config);
  if (!phoneNumberId) {
    throw new CrablineError(
      "WhatsApp raw targets require whatsapp.phoneNumberId or WHATSAPP_PHONE_NUMBER_ID.",
      { kind: "config" },
    );
  }

  return encodeWhatsAppThreadId(phoneNumberId, value);
}

function toWebhookPath(config: ProviderConfig): string {
  return config.whatsapp?.webhook.path ?? "/whatsapp/webhook";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.whatsapp?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyWhatsAppFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|access token|app secret|verify token|signature|unauthorized/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class WhatsAppProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "whatsapp" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: WhatsAppRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: WhatsAppAdapterApi | null = null;
  #chat: WhatsAppChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: WhatsAppRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeWhatsAppThreadId(this.#config, target.channelId);
    } else if (!target.threadId) {
      normalized.channelId = normalizeWhatsAppThreadId(this.#config, target.id);
    }

    if (target.threadId) {
      normalized.threadId = normalizeWhatsAppThreadId(this.#config, target.threadId);
      normalized.channelId ??= normalized.threadId;
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

      if (this.#config.whatsapp?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.whatsapp.webhook.publicUrl}`);
      }

      if (target.threadId ?? target.channelId) {
        details.push(`dm thread ${target.threadId ?? target.channelId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyWhatsAppFailure(error);
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
      throw classifyWhatsAppFailure(error);
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
    const record = async (thread: WhatsAppThread, message: WhatsAppMessage) => {
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
        handle: (request) => chat.webhooks.whatsapp(request),
        host: this.#config.whatsapp?.webhook.host ?? "127.0.0.1",
        methods: ["GET", "POST"],
        path: toWebhookPath(this.#config),
        port: this.#config.whatsapp?.webhook.port ?? 8789,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.whatsapp?.webhook.host ?? "127.0.0.1"}:${this.#config.whatsapp?.webhook.port ?? 8789}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`WhatsApp webhook server failed: ${ensureErrorMessage(error)}`, {
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

  #getAdapter(): WhatsAppAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): WhatsAppChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
