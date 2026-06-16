import path from "node:path";
import { createTeamsAdapter, type TeamsAdapterConfig } from "@chat-adapter/teams";
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

type MsTeamsThread = {
  id: string;
};

type MsTeamsMessage = {
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

type MsTeamsState = {
  subscribe(threadId: string): Promise<void>;
};

type MsTeamsAdapterApi = {
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

type MsTeamsChat = {
  getState(): MsTeamsState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: MsTeamsThread, message: MsTeamsMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: MsTeamsThread, message: MsTeamsMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: MsTeamsThread, message: MsTeamsMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: MsTeamsThread, message: MsTeamsMessage) => void | Promise<void>,
  ): void;
};

type MsTeamsRuntime = {
  createAdapter(config: ProviderConfig): MsTeamsAdapterApi;
  createChat(adapter: MsTeamsAdapterApi, userName: string): MsTeamsChat;
};

type MsTeamsEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "TEAMS_API_URL"
    | "TEAMS_APP_ID"
    | "TEAMS_APP_PASSWORD"
    | "TEAMS_APP_TENANT_ID"
    | "TEAMS_APP_TYPE"
    | "TEAMS_BOT_USERNAME"
    | "TEAMS_FEDERATED_CLIENT_AUDIENCE"
    | "TEAMS_FEDERATED_CLIENT_ID"
  >
>;

export function resolveMsTeamsAdapterConfig(
  config: ProviderConfig,
  env: MsTeamsEnvironment = process.env,
) {
  const teamsConfig = config.msteams;
  const appId = teamsConfig?.appId ?? env.TEAMS_APP_ID;
  const appPassword = teamsConfig?.appPassword ?? env.TEAMS_APP_PASSWORD;
  const appTenantId = teamsConfig?.appTenantId ?? env.TEAMS_APP_TENANT_ID;
  const appType = teamsConfig?.appType ?? env.TEAMS_APP_TYPE;
  const resolvedAppType =
    appType === "MultiTenant" || appType === "SingleTenant" ? appType : undefined;
  const federatedClientId = teamsConfig?.federated?.clientId ?? env.TEAMS_FEDERATED_CLIENT_ID;
  const federatedClientAudience =
    teamsConfig?.federated?.clientAudience ?? env.TEAMS_FEDERATED_CLIENT_AUDIENCE;

  if (!appId) {
    throw new CrablineError(
      "Microsoft Teams app id is required. Set msteams.appId or TEAMS_APP_ID.",
      {
        kind: "config",
      },
    );
  }

  if (!appPassword && !federatedClientId) {
    throw new CrablineError(
      "Microsoft Teams app password or federated client id is required. Set msteams.appPassword, TEAMS_APP_PASSWORD, msteams.federated.clientId, or TEAMS_FEDERATED_CLIENT_ID.",
      { kind: "config" },
    );
  }

  if (resolvedAppType === "SingleTenant" && !appTenantId) {
    throw new CrablineError(
      "Microsoft Teams single-tenant apps require msteams.appTenantId or TEAMS_APP_TENANT_ID.",
      { kind: "config" },
    );
  }

  const adapterConfig: TeamsAdapterConfig = {
    appId,
    ...(appPassword ? { appPassword } : {}),
    ...(appTenantId ? { appTenantId } : {}),
    ...(resolvedAppType ? { appType: resolvedAppType } : {}),
    ...((teamsConfig?.apiUrl ?? env.TEAMS_API_URL)
      ? { apiUrl: teamsConfig?.apiUrl ?? env.TEAMS_API_URL! }
      : {}),
    ...(teamsConfig?.dialogOpenTimeoutMs !== undefined
      ? { dialogOpenTimeoutMs: teamsConfig.dialogOpenTimeoutMs }
      : {}),
    ...(federatedClientId
      ? {
          federated: {
            clientId: federatedClientId,
            ...(federatedClientAudience ? { clientAudience: federatedClientAudience } : {}),
          },
        }
      : {}),
    ...((teamsConfig?.userName ?? env.TEAMS_BOT_USERNAME)
      ? { userName: teamsConfig?.userName ?? env.TEAMS_BOT_USERNAME! }
      : {}),
  };

  return adapterConfig;
}

const DEFAULT_RUNTIME: MsTeamsRuntime = {
  createAdapter(config) {
    return createTeamsAdapter(resolveMsTeamsAdapterConfig(config)) as unknown as MsTeamsAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ teams: Adapter }>({
      adapters: { teams: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as MsTeamsChat;
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

function isMsTeamsEncodedId(value: string): boolean {
  return value.startsWith("teams:");
}

function encodeMsTeamsThreadId(conversationId: string, serviceUrl: string): string {
  return `teams:${base64Url(conversationId)}:${base64Url(serviceUrl)}`;
}

function normalizeMsTeamsChannelId(
  target: ProviderContext["fixture"]["target"],
  value: string,
): string {
  if (isMsTeamsEncodedId(value)) {
    return value;
  }

  const serviceUrl = target.metadata.serviceUrl;
  if (!serviceUrl) {
    throw new CrablineError(
      "Microsoft Teams raw channel targets require target.metadata.serviceUrl or an encoded teams: thread id.",
      { kind: "config" },
    );
  }

  return encodeMsTeamsThreadId(value, serviceUrl);
}

function normalizeMsTeamsThreadId(
  target: ProviderContext["fixture"]["target"],
  threadId: string,
): string {
  if (isMsTeamsEncodedId(threadId)) {
    return threadId;
  }

  const serviceUrl = target.metadata.serviceUrl;
  if (!serviceUrl) {
    throw new CrablineError(
      "Microsoft Teams raw thread targets require target.metadata.serviceUrl or an encoded teams: thread id.",
      { kind: "config" },
    );
  }

  const conversationId = target.channelId ?? target.id;
  const replyConversationId = `${conversationId};messageid=${threadId}`;
  return encodeMsTeamsThreadId(replyConversationId, serviceUrl);
}

function toWebhookPath(config: ProviderConfig): string {
  return config.msteams?.webhook.path ?? "/msteams/webhook";
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.msteams?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyMsTeamsFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/401|403|app id|app password|tenant|unauthorized|forbidden|token/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

export class MsTeamsProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "msteams" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: MsTeamsRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: MsTeamsAdapterApi | null = null;
  #chat: MsTeamsChat | null = null;
  #server: StartedWebhookServer | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: MsTeamsRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeMsTeamsChannelId(target, target.channelId);
    } else if (isMsTeamsEncodedId(target.id)) {
      normalized.channelId = target.id;
    } else if (!target.threadId && target.metadata.serviceUrl) {
      normalized.channelId = normalizeMsTeamsChannelId(target, target.id);
    }

    if (target.threadId) {
      normalized.threadId = normalizeMsTeamsThreadId(target, target.threadId);
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

      if (this.#config.msteams?.webhook.publicUrl) {
        details.push(`public webhook ${this.#config.msteams.webhook.publicUrl}`);
      }

      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`conversation reachable ${target.channelId}`);
      } else {
        const threadId = await this.#getAdapter().openDM(target.id);
        details.push(`dm reachable ${threadId}`);
      }

      return {
        details,
        healthy: true,
      };
    } catch (error) {
      throw classifyMsTeamsFailure(error);
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
      throw classifyMsTeamsFailure(error);
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
    const record = async (thread: MsTeamsThread, message: MsTeamsMessage) => {
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
        host: this.#config.msteams?.webhook.host ?? "127.0.0.1",
        path: toWebhookPath(this.#config),
        port: this.#config.msteams?.webhook.port ?? 8791,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${this.#config.msteams?.webhook.host ?? "127.0.0.1"}:${this.#config.msteams?.webhook.port ?? 8791}${toWebhookPath(this.#config)}`,
        };
      }

      throw new CrablineError(
        `Microsoft Teams webhook server failed: ${ensureErrorMessage(error)}`,
        {
          cause: error,
          kind: "connectivity",
        },
      );
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

  #getAdapter(): MsTeamsAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config);
    }

    return this.#adapter;
  }

  #getChat(): MsTeamsChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
