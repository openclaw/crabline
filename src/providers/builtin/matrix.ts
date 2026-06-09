import path from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";
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

type MatrixAdapterApi = {
  fetchChannelInfo(channelId: string): Promise<unknown>;
  postMessage(
    threadId: string,
    message: string,
  ): Promise<{
    id: string;
    threadId: string;
  }>;
};

type MatrixProviderAuth = NonNullable<NonNullable<ProviderConfig["matrix"]>["auth"]>;

type MatrixMessage = {
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

type MatrixThread = {
  id: string;
};

type MatrixState = {
  subscribe(threadId: string): Promise<void>;
};

type MatrixChat = {
  getState(): MatrixState;
  initialize(): Promise<void>;
  onDirectMessage(
    handler: (thread: MatrixThread, message: MatrixMessage) => void | Promise<void>,
  ): void;
  onNewMention(
    handler: (thread: MatrixThread, message: MatrixMessage) => void | Promise<void>,
  ): void;
  onNewMessage(
    pattern: RegExp,
    handler: (thread: MatrixThread, message: MatrixMessage) => void | Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: MatrixThread, message: MatrixMessage) => void | Promise<void>,
  ): void;
};

type MatrixRuntime = {
  createAdapter(config: ProviderConfig, userName: string): MatrixAdapterApi;
  createChat(adapter: MatrixAdapterApi, userName: string): MatrixChat;
};

type MatrixEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "MATRIX_ACCESS_TOKEN"
    | "MATRIX_BASE_URL"
    | "MATRIX_PASSWORD"
    | "MATRIX_RECOVERY_KEY"
    | "MATRIX_USERNAME"
    | "MATRIX_USER_ID"
  >
>;

export function resolveMatrixAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: MatrixEnvironment = process.env,
) {
  const matrixConfig = config.matrix;
  const baseURL = matrixConfig?.baseURL ?? env.MATRIX_BASE_URL;
  if (!baseURL) {
    throw new CrablineError("Matrix base URL is required. Set matrix.baseURL or MATRIX_BASE_URL.", {
      kind: "config",
    });
  }

  return {
    auth: resolveMatrixAuth(matrixConfig?.auth, env),
    baseURL,
    ...(matrixConfig?.commandPrefix ? { commandPrefix: matrixConfig.commandPrefix } : {}),
    ...((matrixConfig?.recoveryKey ?? env.MATRIX_RECOVERY_KEY)
      ? { recoveryKey: matrixConfig?.recoveryKey ?? env.MATRIX_RECOVERY_KEY! }
      : {}),
    ...(matrixConfig?.roomAllowlist ? { roomAllowlist: matrixConfig.roomAllowlist } : {}),
    userName,
  };
}

const DEFAULT_RUNTIME: MatrixRuntime = {
  createAdapter(config, userName) {
    return createMatrixAdapter(
      resolveMatrixAdapterConfig(config, userName),
    ) as unknown as MatrixAdapterApi;
  },
  createChat(adapter, userName) {
    return new Chat<{ matrix: Adapter }>({
      adapters: { matrix: adapter as unknown as Adapter },
      state: createMemoryState(),
      userName,
    }) as unknown as MatrixChat;
  },
};

function normalizeMatrixChannelId(value: string): string {
  return value.startsWith("matrix:") ? value : `matrix:${encodeURIComponent(value)}`;
}

function normalizeMatrixThreadId(channelId: string, threadId: string): string {
  if (threadId.startsWith("matrix:")) {
    return threadId;
  }

  const roomID = decodeURIComponent(channelId.replace(/^matrix:/u, ""));
  return `matrix:${encodeURIComponent(roomID)}:${encodeURIComponent(threadId)}`;
}

function toRecorderPath(providerId: string, config: ProviderConfig): string {
  const configuredPath = config.matrix?.recorder.path;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function classifyMatrixFailure(error: unknown): CrablineError {
  if (error instanceof CrablineError) {
    return error;
  }

  const message = ensureErrorMessage(error);
  if (/access token|401|unauthorized|forbidden/i.test(message)) {
    return new CrablineError(message, { cause: error, kind: "auth" });
  }

  return new CrablineError(message, { cause: error, kind: "connectivity" });
}

function resolveMatrixAuthFromEnv(env: MatrixEnvironment) {
  if (env.MATRIX_ACCESS_TOKEN) {
    return {
      accessToken: env.MATRIX_ACCESS_TOKEN,
      type: "accessToken" as const,
      ...(env.MATRIX_USER_ID ? { userID: env.MATRIX_USER_ID } : {}),
    };
  }

  if (env.MATRIX_USERNAME && env.MATRIX_PASSWORD) {
    return {
      password: env.MATRIX_PASSWORD,
      type: "password" as const,
      username: env.MATRIX_USERNAME,
      ...(env.MATRIX_USER_ID ? { userID: env.MATRIX_USER_ID } : {}),
    };
  }

  throw new CrablineError(
    "Matrix auth is required. Set matrix.auth or MATRIX_ACCESS_TOKEN or MATRIX_USERNAME/MATRIX_PASSWORD.",
    { kind: "config" },
  );
}

function resolveMatrixAuth(auth: MatrixProviderAuth | undefined, env: MatrixEnvironment) {
  if (auth?.type === "accessToken") {
    if (!auth.accessToken) {
      throw new CrablineError("Matrix accessToken auth requires auth.accessToken.", {
        kind: "config",
      });
    }

    return {
      accessToken: auth.accessToken,
      type: "accessToken" as const,
      ...(auth.userID ? { userID: auth.userID } : {}),
    };
  }

  if (auth?.type === "password") {
    if (!auth.username || !auth.password) {
      throw new CrablineError("Matrix password auth requires auth.username and auth.password.", {
        kind: "config",
      });
    }

    return {
      password: auth.password,
      type: "password" as const,
      username: auth.username,
      ...(auth.userID ? { userID: auth.userID } : {}),
    };
  }

  return resolveMatrixAuthFromEnv(env);
}

export class MatrixProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform = "matrix" as const;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #config: ProviderConfig;
  readonly #recorderPath: string;
  readonly #runtime: MatrixRuntime;
  readonly #seenMessages = new Set<string>();
  readonly #userName: string;
  #adapter: MatrixAdapterApi | null = null;
  #chat: MatrixChat | null = null;

  constructor(
    id: string,
    config: ProviderConfig,
    userName: string,
    runtime: MatrixRuntime = DEFAULT_RUNTIME,
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
      normalized.channelId = normalizeMatrixChannelId(target.channelId);
    } else if (!target.threadId) {
      normalized.channelId = normalizeMatrixChannelId(target.id);
    }

    if (target.threadId) {
      if (!normalized.channelId) {
        throw new CrablineError(
          `Matrix target "${target.id}" requires channelId for thread send.`,
          {
            kind: "config",
          },
        );
      }

      normalized.threadId = normalizeMatrixThreadId(normalized.channelId, target.threadId);
    }

    return normalized;
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    try {
      await this.#getChat().initialize();
      const target = this.normalizeTarget(context.fixture.target);
      const details = [`recorder path ${this.#recorderPath}`];
      if (target.channelId) {
        await this.#getAdapter().fetchChannelInfo(target.channelId);
        details.push(`room reachable ${target.channelId}`);
      }

      return { details, healthy: true };
    } catch (error) {
      throw classifyMatrixFailure(error);
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
      await this.#getChat().initialize();
      return (
        (await waitForRecordedInbound({
          filePath: this.#recorderPath,
          matches: (event) => event.provider === this.id && event.threadId === context.threadId,
          since: context.since,
          timeoutMs: context.timeoutMs,
        })) ?? null
      );
    } catch (error) {
      throw classifyMatrixFailure(error);
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const target = this.normalizeTarget(context.fixture.target);
    await this.#getChat().initialize();
    const expectedThreadId = target.threadId ?? target.channelId;

    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) => entry.provider === this.id && entry.threadId === expectedThreadId,
      since: context.since,
    })) {
      yield event;
    }
  }

  #resolveThreadId(target: ProviderContext["fixture"]["target"]): string {
    const normalized = this.normalizeTarget(target);
    return normalized.threadId ?? normalized.channelId ?? normalized.id;
  }

  #registerInboundHandlers(): void {
    const chat = this.#chat;
    if (!chat) {
      return;
    }

    const record = async (thread: MatrixThread, message: MatrixMessage) => {
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

  #getAdapter(): MatrixAdapterApi {
    if (!this.#adapter) {
      this.#adapter = this.#runtime.createAdapter(this.#config, this.#userName);
    }

    return this.#adapter;
  }

  #getChat(): MatrixChat {
    if (!this.#chat) {
      this.#chat = this.#runtime.createChat(this.#getAdapter(), this.#userName);
      this.#registerInboundHandlers();
    }

    return this.#chat;
  }
}
