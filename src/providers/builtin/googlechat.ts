import path from "node:path";
import {
  createGoogleChatAdapter,
  type GoogleChatAdapterBaseConfig,
  type GoogleChatAdapterConfig,
  type ServiceAccountCredentials,
} from "@chat-adapter/gchat";
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

type GoogleChatThread = {
  id: string;
};

type GoogleChatMessage = {
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

type GoogleChatState = {
  subscribe(threadId: string): Promise<void>;
};

type GoogleChatAdapterApi = {
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

type GoogleChatChat = {
  getState(): GoogleChatState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: GoogleChatThread, message: GoogleChatMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: GoogleChatThread, message: GoogleChatMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: GoogleChatThread, message: GoogleChatMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: GoogleChatThread, message: GoogleChatMessage) => void | Promise<void>,
  ): void;
};

type GoogleChatRuntime = {
  createAdapter(config: ProviderConfig): GoogleChatAdapterApi;
  createChat(adapter: GoogleChatAdapterApi, userName: string): GoogleChatChat;
};

type GoogleChatEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "GOOGLE_CHAT_API_URL"
    | "GOOGLE_CHAT_BOT_USERNAME"
    | "GOOGLE_CHAT_CREDENTIALS"
    | "GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION"
    | "GOOGLE_CHAT_ENDPOINT_URL"
    | "GOOGLE_CHAT_IMPERSONATE_USER"
    | "GOOGLE_CHAT_PROJECT_NUMBER"
    | "GOOGLE_CHAT_PUBSUB_AUDIENCE"
    | "GOOGLE_CHAT_PUBSUB_TOPIC"
    | "GOOGLE_CHAT_USE_ADC"
  >
>;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return /^(1|true|yes)$/iu.test(value);
}

function parseCredentials(value: string | undefined): ServiceAccountCredentials | undefined {
  if (!value) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CrablineError("GOOGLE_CHAT_CREDENTIALS must be valid JSON.", {
      cause: error,
      kind: "config",
    });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { client_email?: unknown }).client_email !== "string" ||
    typeof (parsed as { private_key?: unknown }).private_key !== "string"
  ) {
    throw new CrablineError("GOOGLE_CHAT_CREDENTIALS must include client_email and private_key.", {
      kind: "config",
    });
  }

  return parsed as ServiceAccountCredentials;
}

export function resolveGoogleChatAdapterConfig(
  config: ProviderConfig,
  env: GoogleChatEnvironment = process.env,
) {
  const googleChatConfig = config.googlechat;
  const credentials = (googleChatConfig?.credentials ??
    parseCredentials(env.GOOGLE_CHAT_CREDENTIALS)) as ServiceAccountCredentials | undefined;
  const useApplicationDefaultCredentials =
    googleChatConfig?.useApplicationDefaultCredentials ?? parseBooleanEnv(env.GOOGLE_CHAT_USE_ADC);
  const disableSignatureVerification =
    googleChatConfig?.disableSignatureVerification ??
    parseBooleanEnv(env.GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION);
  const googleChatProjectNumber =
    googleChatConfig?.googleChatProjectNumber ?? env.GOOGLE_CHAT_PROJECT_NUMBER;
  const pubsubAudience = googleChatConfig?.pubsubAudience ?? env.GOOGLE_CHAT_PUBSUB_AUDIENCE;

  if (!credentials && !useApplicationDefaultCredentials) {
    throw new CrablineError(
      "Google Chat credentials are required. Set googlechat.credentials, GOOGLE_CHAT_CREDENTIALS, googlechat.useApplicationDefaultCredentials, or GOOGLE_CHAT_USE_ADC.",
      { kind: "config" },
    );
  }

  if (!googleChatProjectNumber && !pubsubAudience && !disableSignatureVerification) {
    throw new CrablineError(
      "Google Chat webhook verification is required. Set googlechat.googleChatProjectNumber, googlechat.pubsubAudience, or googlechat.disableSignatureVerification.",
      { kind: "config" },
    );
  }

  const baseConfig: GoogleChatAdapterBaseConfig = {
    ...(disableSignatureVerification !== undefined ? { disableSignatureVerification } : {}),
    ...(googleChatProjectNumber ? { googleChatProjectNumber } : {}),
    ...(pubsubAudience ? { pubsubAudience } : {}),
    ...((googleChatConfig?.apiUrl ?? env.GOOGLE_CHAT_API_URL)
      ? { apiUrl: googleChatConfig?.apiUrl ?? env.GOOGLE_CHAT_API_URL! }
      : {}),
    ...((googleChatConfig?.endpointUrl ??
    googleChatConfig?.webhook.publicUrl ??
    env.GOOGLE_CHAT_ENDPOINT_URL)
      ? {
          endpointUrl:
            googleChatConfig?.endpointUrl ??
            googleChatConfig?.webhook.publicUrl ??
            env.GOOGLE_CHAT_ENDPOINT_URL!,
        }
      : {}),
    ...((googleChatConfig?.impersonateUser ?? env.GOOGLE_CHAT_IMPERSONATE_USER)
      ? {
          impersonateUser: googleChatConfig?.impersonateUser ?? env.GOOGLE_CHAT_IMPERSONATE_USER!,
        }
      : {}),
    ...((googleChatConfig?.pubsubTopic ?? env.GOOGLE_CHAT_PUBSUB_TOPIC)
      ? { pubsubTopic: googleChatConfig?.pubsubTopic ?? env.GOOGLE_CHAT_PUBSUB_TOPIC! }
      : {}),
    ...((googleChatConfig?.userName ?? env.GOOGLE_CHAT_BOT_USERNAME)
      ? { userName: googleChatConfig?.userName ?? env.GOOGLE_CHAT_BOT_USERNAME! }
      : {}),
  };

  const adapterConfig: GoogleChatAdapterConfig = credentials
    ? {
        ...baseConfig,
        credentials,
      }
    : {
        ...baseConfig,
        useApplicationDefaultCredentials: true,
      };

  return adapterConfig;
}

const DEFAULT_RUNTIME: GoogleChatRuntime = {
  createAdapter(config) {
    return createGoogleChatAdapter(
      resolveGoogleChatAdapterConfig(config),
    ) as unknown as GoogleChatAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ gchat: Adapter }>({
      adapters: { gchat: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as GoogleChatChat;
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

function isGoogleChatEncodedId(value: string): boolean {
  return value.startsWith("gchat:");
}

function normalizeGoogleChatChannelId(value: string): string {
  return isGoogleChatEncodedId(value) ? value : `gchat:${value}`;
}

function normalizeGoogleChatThreadId(channelId: string, threadId: string): string {
  if (isGoogleChatEncodedId(threadId)) {
    return threadId;
  }

  const spaceName = channelId.replace(/^gchat:/u, "");
  return `gchat:${spaceName}:${base64Url(threadId)}`;
}

function isGoogleChatSpaceId(value: string): boolean {
  return value.startsWith("spaces/") || value.startsWith("gchat:spaces/");
}

function toWebhookPath(config: ProviderConfig): string {
  return config.googlechat?.webhook.path ?? "/googlechat/webhook";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.googlechat?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyGoogleChatFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|credentials|private_key|signature|unauthorized|forbidden|token/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class GoogleChatProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "googlechat" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: GoogleChatRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: GoogleChatAdapterApi | null = null;
  #chat: GoogleChatChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: GoogleChatRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeGoogleChatChannelId(target.channelId);
    } else if (!target.threadId && isGoogleChatSpaceId(target.id)) {
      normalized.channelId = normalizeGoogleChatChannelId(target.id);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        normalized.channelId = normalizeGoogleChatChannelId(target.id);
      }

      normalized.threadId = normalizeGoogleChatThreadId(normalized.channelId, target.threadId);
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

      if (this.#config.googlechat?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.googlechat.webhook.publicUrl}`);
      }

      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`space reachable ${target.channelId}`);
      } else {
        const threadId = await this.#getAdapter().openDM(target.id);
        details.push(`dm reachable ${threadId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyGoogleChatFailure(error);
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
      throw classifyGoogleChatFailure(error);
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
    const record = async (thread: GoogleChatThread, message: GoogleChatMessage) => {
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
        host: this.#config.googlechat?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.googlechat?.webhook.port ?? 8792,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.googlechat?.webhook.host ?? "127.0.0.1"}:${this.#config.googlechat?.webhook.port ?? 8792}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`Google Chat webhook server failed: ${ensureErrorMessage(error)}`, {
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

  #getAdapter(): GoogleChatAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): GoogleChatChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
