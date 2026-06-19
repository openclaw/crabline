import path from "node:path";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import type { ProviderConfig, ProviderPlatform } from "../config/schema.js";
import { appendRecordedInbound, waitForRecordedInbound, watchRecordedInbound } from "./recorder.js";
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
} from "./types.js";
import { startWebhookServer, type StartedWebhookServer } from "./webhook-server.js";

export type LocalMockWebhookConfig = {
  host?: string;
  path?: string;
  port?: number;
  publicUrl?: string | undefined;
};

export type LocalMockAdapterOptions = {
  defaultWebhook: Required<Pick<LocalMockWebhookConfig, "host" | "path" | "port">>;
  endpointLabel: string;
  platform: ProviderPlatform;
  publicUrl?: string | undefined;
  recorderPath?: string | undefined;
  webhook?: LocalMockWebhookConfig | undefined;
};

export type LocalMockTargetCodec = {
  normalize(target: ProviderContext["fixture"]["target"]): NormalizedTarget;
  resolveThreadId(target: ProviderContext["fixture"]["target"]): string;
};

export function createGenericLocalMockTargetCodec(
  platform: ProviderPlatform,
): LocalMockTargetCodec {
  const prefix = `${platform}:`;
  const encode = (value: string) => (value.startsWith(prefix) ? value : `${prefix}${value}`);
  return {
    normalize(target): NormalizedTarget {
      const normalized: NormalizedTarget = {
        id: target.id,
        metadata: target.metadata,
      };
      if (target.channelId) {
        normalized.channelId = encode(target.channelId);
      } else if (!target.threadId) {
        normalized.channelId = encode(target.id);
      }
      if (target.threadId) {
        normalized.channelId ??= encode(target.id);
        normalized.threadId = target.threadId.startsWith(prefix)
          ? target.threadId
          : `${normalized.channelId}:${target.threadId}`;
      }
      return normalized;
    },
    resolveThreadId(target) {
      const normalized = this.normalize(target);
      return normalized.threadId ?? normalized.channelId ?? encode(normalized.id);
    },
  };
}

type MockWebhookPayload = {
  author?: "assistant" | "system" | "user";
  authorIsBot?: boolean;
  id?: string;
  message?: {
    author?: "assistant" | "system" | "user";
    authorIsBot?: boolean;
    id?: string;
    raw?: unknown;
    text?: string;
    threadId?: string;
  };
  raw?: unknown;
  text?: string;
  threadId?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }
  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}

function createMessageId(platform: ProviderPlatform) {
  return `${platform}-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRecorderPath(providerId: string, configuredPath?: string): string {
  return configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(".crabline", "recorders", `${providerId}.jsonl`);
}

function authorFromPayload(payload: MockWebhookPayload): InboundEnvelope["author"] {
  const explicit = payload.message?.author ?? payload.author;
  if (explicit) {
    return explicit;
  }
  return (payload.message?.authorIsBot ?? payload.authorIsBot ?? true) ? "assistant" : "user";
}

function normalizeWebhookPayload(payload: unknown): MockWebhookPayload {
  if (!payload || typeof payload !== "object") {
    throw new CrablineError("mock webhook payload must be an object", { kind: "inbound" });
  }
  return payload as MockWebhookPayload;
}

function mockReplyText(params: { platform: ProviderPlatform; text: string }) {
  return `[${params.platform} mock] ${params.text}`;
}

export class LocalMockProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status = "ready" as const;
  readonly supports = ["probe", "send", "roundtrip", "agent"] as const;

  readonly #codec: LocalMockTargetCodec;
  readonly #config: ProviderConfig;
  readonly #options: LocalMockAdapterOptions;
  readonly #recorderPath: string;
  #server: StartedWebhookServer | null = null;

  constructor(params: {
    codec: LocalMockTargetCodec;
    config: ProviderConfig;
    id: string;
    options: LocalMockAdapterOptions;
  }) {
    this.id = params.id;
    this.platform = params.options.platform;
    this.#codec = params.codec;
    this.#config = params.config;
    this.#options = params.options;
    this.#recorderPath = toRecorderPath(params.id, params.options.recorderPath);
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    return this.#codec.normalize(target);
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    const server = await this.#ensureWebhookServer(true);
    const target = this.normalizeTarget(context.fixture.target);
    const details = [
      `${this.platform} local mock ready`,
      `recorder path ${this.#recorderPath}`,
      `${this.#options.endpointLabel} ${server.endpointUrl}`,
    ];
    if (this.#options.publicUrl) {
      details.push(`public webhook ${this.#options.publicUrl}`);
    }
    if (target.threadId) {
      details.push(`thread reachable ${target.threadId}`);
    } else if (target.channelId) {
      details.push(`channel reachable ${target.channelId}`);
    } else {
      details.push(`dm reachable ${this.#codec.resolveThreadId(context.fixture.target)}`);
    }
    return { details, healthy: true };
  }

  async send(context: SendContext): Promise<SendResult> {
    const threadId = this.#codec.resolveThreadId(context.fixture.target);
    const messageId = createMessageId(this.platform);
    await appendRecordedInbound(this.#recorderPath, {
      author: "user",
      id: messageId,
      provider: this.id,
      raw: {
        direction: "outbound",
        mode: context.mode,
        platform: this.platform,
      },
      sentAt: new Date().toISOString(),
      text: context.text,
      threadId,
    });

    if (context.mode !== "send" && context.fixture.target.behavior !== "sink") {
      await sleep(this.#config.loopback?.delayMs ?? 25);
      await appendRecordedInbound(this.#recorderPath, {
        author: "assistant",
        id: `${messageId}-reply`,
        provider: this.id,
        raw: {
          direction: "mock-reply",
          mode: context.mode,
          platform: this.platform,
        },
        sentAt: new Date().toISOString(),
        text: mockReplyText({ platform: this.platform, text: context.text }),
        threadId,
      });
    }

    return {
      accepted: true,
      messageId,
      threadId,
    };
  }

  async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    await this.#ensureWebhookServer(true);
    const target = this.normalizeTarget(context.fixture.target);
    const expectedAuthor = context.fixture.inboundMatch.author;
    return await waitForRecordedInbound({
      filePath: this.#recorderPath,
      matches: (event) =>
        event.provider === this.id &&
        (expectedAuthor === "any" || event.author === expectedAuthor) &&
        isAddressInChannel(event.threadId, context.threadId ?? target.threadId ?? target.channelId),
      since: context.since,
      timeoutMs: context.timeoutMs,
    });
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    await this.#ensureWebhookServer(false);
    const target = this.normalizeTarget(context.fixture.target);
    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) =>
        entry.provider === this.id &&
        isAddressInChannel(entry.threadId, target.threadId ?? target.channelId),
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

  async #handleWebhook(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return new Response("expected application/json", { status: 415 });
    }
    let payload: MockWebhookPayload;
    try {
      payload = normalizeWebhookPayload(await request.json());
    } catch (error) {
      return new Response(ensureErrorMessage(error), { status: 400 });
    }

    const id = payload.message?.id ?? payload.id ?? createMessageId(this.platform);
    const threadId = payload.message?.threadId ?? payload.threadId;
    const text = payload.message?.text ?? payload.text;
    if (!threadId || !text) {
      return new Response("payload requires message.threadId and message.text", { status: 400 });
    }

    await appendRecordedInbound(this.#recorderPath, {
      author: authorFromPayload(payload),
      id,
      provider: this.id,
      raw: payload.message?.raw ?? payload.raw ?? payload,
      sentAt: new Date().toISOString(),
      text,
      threadId,
    });
    return new Response(JSON.stringify({ ok: true, id }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }

  async #ensureWebhookServer(allowExisting: boolean): Promise<StartedWebhookServer> {
    if (this.#server) {
      return this.#server;
    }

    const webhook = this.#options.webhook;
    const host = webhook?.host ?? this.#options.defaultWebhook.host;
    const port = webhook?.port ?? this.#options.defaultWebhook.port;
    const webhookPath = webhook?.path ?? this.#options.defaultWebhook.path;
    try {
      this.#server = await startWebhookServer({
        handle: (request) => this.#handleWebhook(request),
        host,
        path: webhookPath,
        port,
      });
      return this.#server;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowExisting && code === "EADDRINUSE") {
        return {
          async close() {},
          endpointUrl: `http://${host}:${port}${webhookPath}`,
        };
      }
      throw new CrablineError(
        `${this.platform} local mock webhook server failed: ${ensureErrorMessage(error)}`,
        { cause: error, kind: "connectivity" },
      );
    }
  }
}
