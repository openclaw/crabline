import path from "node:path";
import { createDiscordAdapter } from "@chat-adapter/discord";
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

type DiscordThread = {
  id: string;
};

type DiscordMessage = {
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

type DiscordState = {
  subscribe(threadId: string): Promise<void>;
};

type DiscordAdapterApi = {
  fetchChannelInfo(channelId: string): Promise<unknown>;
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
  startGatewayListener(
    options: { waitUntil(task: Promise<unknown>): void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
};

type DiscordChat = {
  getState(): DiscordState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: DiscordThread, message: DiscordMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: DiscordThread, message: DiscordMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: DiscordThread, message: DiscordMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: DiscordThread, message: DiscordMessage) => void | Promise<void>,
  ): void;
};

type DiscordRuntime = {
  createAdapter(
    config: ProviderConfig,
    userName: string,
  ): Promise<DiscordAdapterApi> | DiscordAdapterApi;
  createChat(adapter: DiscordAdapterApi, userName: string): Promise<DiscordChat> | DiscordChat;
};

type DiscordEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "DISCORD_APPLICATION_ID" | "DISCORD_BOT_TOKEN" | "DISCORD_PUBLIC_KEY">
>;

type DiscordApplicationMetadata = {
  applicationId: string;
  publicKey: string;
};

async function fetchDiscordApplicationMetadata(
  botToken: string,
): Promise<DiscordApplicationMetadata> {
  let response: Response;

  try {
    response = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    });
  } catch (error) {
    throw new CrablineError(
      `Discord application metadata lookup failed: ${ensureErrorMessage(error)}`,
      {
        cause: error,
        kind: "connectivity",
      },
    );
  }

  if (!response.ok) {
    throw new CrablineError(`Discord application metadata lookup failed: HTTP ${response.status}`, {
      kind: response.status === 401 || response.status === 403 ? "auth" : "connectivity",
    });
  }

  const payload = (await response.json()) as {
    id?: unknown;
    verify_key?: unknown;
  };

  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new CrablineError("Discord application metadata lookup returned no application id.", {
      kind: "connectivity",
    });
  }

  if (typeof payload.verify_key !== "string" || payload.verify_key.length === 0) {
    throw new CrablineError("Discord application metadata lookup returned no public key.", {
      kind: "connectivity",
    });
  }

  return {
    applicationId: payload.id,
    publicKey: payload.verify_key,
  };
}

export async function resolveDiscordAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: DiscordEnvironment = process.env,
) {
  const discordConfig = config.discord;
  const botToken = discordConfig?.botToken ?? env.DISCORD_BOT_TOKEN;
  let applicationId = discordConfig?.applicationId ?? env.DISCORD_APPLICATION_ID;
  let publicKey = discordConfig?.publicKey ?? env.DISCORD_PUBLIC_KEY;

  if (!botToken) {
    throw new CrablineError(
      "Discord bot token is required. Set discord.botToken or DISCORD_BOT_TOKEN.",
      {
        kind: "config",
      },
    );
  }

  if (!applicationId || !publicKey) {
    const metadata = await fetchDiscordApplicationMetadata(botToken);
    applicationId ??= metadata.applicationId;
    publicKey ??= metadata.publicKey;
  }

  return {
    applicationId,
    botToken,
    ...(discordConfig?.mentionRoleIds ? { mentionRoleIds: discordConfig.mentionRoleIds } : {}),
    publicKey,
    userName,
  };
}

const DEFAULT_RUNTIME: DiscordRuntime = {
  async createAdapter(config, userName) {
    return createDiscordAdapter(
      await resolveDiscordAdapterConfig(config, userName),
    ) as unknown as DiscordAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ discord: Adapter }>({
      adapters: { discord: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as DiscordChat;
  },
};

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }

  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function isDiscordEncodedId(value: string): boolean {
  return value.startsWith("discord:");
}

function encodeDiscordChannelId(guildId: string, channelId: string): string {
  return `discord:${guildId}:${channelId}`;
}

function normalizeDiscordChannelId(value: string, guildId?: string): string {
  if (isDiscordEncodedId(value)) {
    return value;
  }

  if (!guildId) {
    throw new CrablineError(
      "Discord guild channels require target.metadata.guildId unless target id is already encoded as discord:guild:channel.",
      {
        kind: "config",
      },
    );
  }

  return encodeDiscordChannelId(guildId, value);
}

function normalizeDiscordThreadId(channelId: string, threadId: string): string {
  if (isDiscordEncodedId(threadId)) {
    return threadId;
  }

  return `${channelId}:${threadId}`;
}

function toWebhookPath(config: ProviderConfig): string {
  return config.discord?.webhook.path ?? "/discord/interactions";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.discord?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyDiscordFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|unauthorized|invalid token|missing access|public key|signature/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class DiscordProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "discord" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: DiscordRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: DiscordAdapterApi | null = null;
  #adapterPromise: Promise<DiscordAdapterApi> | null = null;
  #chat: DiscordChat | null = null;
  #chatPromise: Promise<DiscordChat> | null = null;
  #gatewayAbort: AbortController | null = null;
  #gatewayTask: Promise<unknown> | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: DiscordRuntime = DEFAULT_RUNTIME,
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

    if (isDiscordEncodedId(target.id)) {
      const parts = target.id.split(":");
      if (parts.length >= 3) {
        normalized.channelId = parts.slice(0, 3).join(":");
      }
      if (parts.length >= 4) {
        normalized.threadId = target.id;
      }
    }

    if (target.channelId) {
      normalized.channelId = normalizeDiscordChannelId(target.channelId, target.metadata.guildId);
    } else if (!target.threadId && target.metadata.guildId && !normalized.channelId) {
      normalized.channelId = normalizeDiscordChannelId(target.id, target.metadata.guildId);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        normalized.channelId = target.metadata.guildId
          ? normalizeDiscordChannelId(target.id, target.metadata.guildId)
          : undefined;
      }

      if (!normalized.channelId) {
        throw new CrablineError(
          `Discord target "${target.id}" requires target.metadata.guildId or an encoded target.channelId for thread send.`,
          {
            kind: "config",
          },
        );
      }

      normalized.threadId = normalizeDiscordThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      const chat = await this.#getChat();
      await chat.initialize();
      const server = await this.#ensureWebhookServer(true);
      const target = this.normalizeTarget(context.fixture.target);
      const details = [
        `recorder path ${this.#recorderPath}`,
        `interactions endpoint ${server.endpointUrl}`,
      ];

      if (this.#config.discord?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.discord.webhook.publicUrl}`);
      }

      if (target.threadId) {
        const adapter = await this.#getAdapter();
        await adapter.fetchThread(target.threadId);
        details.push(`thread reachable ${target.threadId}`);
      } else if (target.channelId) {
        const adapter = await this.#getAdapter();
        await adapter.fetchChannelInfo(target.channelId);
        details.push(`channel reachable ${target.channelId}`);
      } else {
        const adapter = await this.#getAdapter();
        const threadId = await adapter.openDM(target.id);
        details.push(`dm reachable ${threadId}`);
      }

      return { details, healthy: true };
    } catch (error) {
      throw classifyDiscordFailure(error);
    }
  }

  async send(context: SendContext): Promise<SendResult> {
    try {
      const chat = await this.#getChat();
      await chat.initialize();
      const threadId = await this.#resolveThreadId(context.fixture.target);
      await chat.getState().subscribe(threadId);
      const adapter = await this.#getAdapter();
      const sent = await adapter.postMessage(threadId, context.text);
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
      const target = this.normalizeTarget(context.fixture.target);
      const chat = await this.#getChat();
      await chat.initialize();
      await this.#ensureWebhookServer(true);
      await this.#ensureGatewayListener();
      return (
        (await waitForRecordedInbound({
          filePath: this.#recorderPath,
          matches: (event) =>
            event.provider === this.id &&
            isAddressInChannel(
              event.threadId,
              context.threadId ?? target.threadId ?? target.channelId,
            ),
          since: context.since,
          timeoutMs: context.timeoutMs,
        })) ?? null
      );
    } catch (error) {
      throw classifyDiscordFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    const expectedThreadId =
      target.threadId ?? target.channelId ?? (await this.#resolveThreadId(context.fixture.target));
    const chat = await this.#getChat();
    await chat.initialize();
    await this.#ensureWebhookServer(false);
    await this.#ensureGatewayListener();

    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) =>
        entry.provider === this.id && isAddressInChannel(entry.threadId, expectedThreadId),
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

    if (!this.#server) {
      return;
    }

    await this.#server.close();
    this.#server = null;
  }

  #registerInboundHandlers(chat: DiscordChat): void {
    const record = async (thread: DiscordThread, message: DiscordMessage) => {
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
      const chat = await this.#getChat();
      await chat.initialize();
      this.#server = await startWebhookServer({
        handle: async (request) => (await this.#getAdapter()).handleWebhook(request),
        host: this.#config.discord?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.discord?.webhook.port ?? 8788,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.discord?.webhook.host ?? "127.0.0.1"}:${this.#config.discord?.webhook.port ?? 8788}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(`Discord webhook server failed: ${ensureErrorMessage(error)}`, {
        cause: error,
        kind: "connectivity",
      });
    }
  }

  async #ensureGatewayListener(): Promise<void> {
    if (this.#gatewayTask) {
      return;
    }

    this.#gatewayAbort = new AbortController();
    const adapter = await this.#getAdapter();
    const response = await adapter.startGatewayListener(
      {
        waitUntil: (task) => {
          this.#gatewayTask = task.finally(() => {
            this.#gatewayTask = null;
            this.#gatewayAbort = null;
          });
        },
      },
      this.#config.discord?.gatewayDurationMs ?? 180_000,
      this.#gatewayAbort.signal,
      this.#config.discord?.webhook.publicUrl,
    );

    if (response.status >= 400) {
      throw new CrablineError(`Discord gateway listener failed: ${await response.text()}`, {
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

    const adapter = await this.#getAdapter();
    return adapter.openDM(normalized.id);
  }

  async #getAdapter(): Promise<DiscordAdapterApi> {
    if (this.#adapter) {
      return this.#adapter;
    }

    if (!this.#adapterPromise) {
      this.#adapterPromise = Promise.resolve(
        this.#runtime.createAdapter(this.#config, this.#userName),
      )
        .then((adapter) => {
          this.#adapter = adapter;
          return adapter;
        })
        .finally(() => {
          this.#adapterPromise = null;
        });
    }

    return this.#adapterPromise;
  }

  async #getChat(): Promise<DiscordChat> {
    if (this.#chat) {
      return this.#chat;
    }

    if (!this.#chatPromise) {
      this.#chatPromise = this.#getAdapter()
        .then((adapter) => Promise.resolve(this.#runtime.createChat(adapter, this.#userName)))
        .then((chat) => {
          this.#chat = chat;
          this.#registerInboundHandlers(chat);
          return chat;
        })
        .finally(() => {
          this.#chatPromise = null;
        });
    }

    return this.#chatPromise;
  }
}
