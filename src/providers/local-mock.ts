import path from "node:path";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import type { ProviderConfig, ProviderPlatform } from "../config/schema.js";
import {
  appendRecordedInbound,
  createRecordedInboundCursor,
  waitForRecordedInbound,
  watchRecordedInbound,
  type RecordedInboundCursor,
} from "./recorder.js";
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

export { createGenericLocalMockTargetCodec } from "./target-normalizers.js";

export type LocalMockWebhookConfig = {
  host?: string;
  path?: string;
  port?: number;
  publicUrl?: string | undefined;
};

export type LocalMockAdapterOptions = {
  authenticateWebhookRequest?: (
    request: Request,
    rawBody: string,
  ) => Promise<Response | undefined> | Response | undefined;
  defaultWebhook: Required<Pick<LocalMockWebhookConfig, "host" | "path" | "port">>;
  endpointLabel: string;
  matchesThread?: (
    candidateThreadId: string,
    expectedThreadId: string | undefined,
    target: NormalizedTarget,
  ) => boolean;
  handleWebhookPayload?: (payload: unknown) => Promise<Response | undefined> | Response | undefined;
  normalizeWebhookPayload?: (payload: unknown) => unknown;
  platform: ProviderPlatform;
  publicUrl?: string | undefined;
  recorderPath?: string | undefined;
  webhook?: LocalMockWebhookConfig | undefined;
};

const MAX_WAIT_CURSORS = 64;

export type LocalMockTargetCodec = {
  normalize(target: ProviderContext["fixture"]["target"]): NormalizedTarget;
  resolveThreadId(target: ProviderContext["fixture"]["target"]): string;
};

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

function isOutboundRecord(event: InboundEnvelope): boolean {
  return (
    event.raw !== null &&
    typeof event.raw === "object" &&
    "direction" in event.raw &&
    event.raw.direction === "outbound"
  );
}

export class LocalMockProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status = "ready" as const;
  readonly supports: ProviderAdapter["supports"];

  readonly #codec: LocalMockTargetCodec;
  readonly #config: ProviderConfig;
  readonly #options: LocalMockAdapterOptions;
  readonly #publicUrl: string | undefined;
  readonly #recorderPath: string;
  readonly #waitCursors = new Map<string, RecordedInboundCursor>();
  #server: StartedWebhookServer | null = null;
  #serverClosing: Promise<void> | null = null;
  #serverStarting: Promise<StartedWebhookServer> | null = null;

  constructor(params: {
    codec: LocalMockTargetCodec;
    config: ProviderConfig;
    id: string;
    options: LocalMockAdapterOptions;
  }) {
    this.id = params.id;
    this.platform = params.options.platform;
    this.supports = [...params.config.capabilities];
    this.#codec = params.codec;
    this.#config = params.config;
    this.#options = params.options;
    this.#publicUrl = params.options.publicUrl ?? params.options.webhook?.publicUrl;
    this.#recorderPath = toRecorderPath(params.id, params.options.recorderPath);
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    return this.#codec.normalize(target);
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    const server = await this.#ensureWebhookServer();
    const target = this.normalizeTarget(context.fixture.target);
    const details = [
      `${this.platform} local mock ready`,
      `recorder path ${this.#recorderPath}`,
      `${this.#options.endpointLabel} ${server.endpointUrl}`,
    ];
    if (this.#publicUrl) {
      details.push(`public webhook ${this.#publicUrl}`);
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
    await this.#ensureWebhookServer();
    const target = this.normalizeTarget(context.fixture.target);
    const expectedAuthor = context.fixture.inboundMatch.author;
    const channelId = context.threadId ?? target.threadId ?? target.channelId;
    const cursorKey = JSON.stringify([context.nonce, context.since, channelId]);
    const existingCursor = this.#waitCursors.get(cursorKey);
    if (existingCursor) {
      this.#waitCursors.delete(cursorKey);
    }
    const cursor = existingCursor ?? createRecordedInboundCursor();
    this.#waitCursors.set(cursorKey, cursor);
    while (this.#waitCursors.size > MAX_WAIT_CURSORS) {
      const oldestKey = this.#waitCursors.keys().next().value;
      if (oldestKey !== undefined) {
        this.#waitCursors.delete(oldestKey);
      }
    }

    try {
      const event = await waitForRecordedInbound({
        cursor,
        filePath: this.#recorderPath,
        matches: (candidate) =>
          candidate.provider === this.id &&
          !isOutboundRecord(candidate) &&
          (expectedAuthor === "any" || candidate.author === expectedAuthor) &&
          (this.#options.matchesThread ?? isAddressInChannel)(
            candidate.threadId,
            channelId,
            target,
          ),
        since: context.since,
        signal: context.signal,
        timeoutMs: context.timeoutMs,
      });
      if (!event) {
        this.#waitCursors.delete(cursorKey);
      }
      return event;
    } catch (error) {
      this.#waitCursors.delete(cursorKey);
      throw error;
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    await this.#ensureWebhookServer();
    const target = this.normalizeTarget(context.fixture.target);
    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) =>
        entry.provider === this.id &&
        !isOutboundRecord(entry) &&
        (this.#options.matchesThread ?? isAddressInChannel)(
          entry.threadId,
          target.threadId ?? target.channelId,
          target,
        ),
      signal: context.signal,
      since: context.since,
    })) {
      yield event;
    }
  }

  async cleanup(): Promise<void> {
    this.#waitCursors.clear();
    if (this.#serverClosing) {
      await this.#serverClosing;
      return;
    }

    const closing = this.#closeWebhookServer();
    this.#serverClosing = closing;
    try {
      await closing;
    } finally {
      if (this.#serverClosing === closing) {
        this.#serverClosing = null;
      }
    }
  }

  async #handleWebhook(request: Request): Promise<Response> {
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return new Response("expected application/json", { status: 415 });
    }
    let payload: MockWebhookPayload;
    try {
      const rawBody = await request.text();
      const authenticationFailure = await this.#options.authenticateWebhookRequest?.(
        request,
        rawBody,
      );
      if (authenticationFailure) {
        return authenticationFailure;
      }
      const rawPayload = JSON.parse(rawBody) as unknown;
      const directResponse = await this.#options.handleWebhookPayload?.(rawPayload);
      if (directResponse) {
        return directResponse;
      }
      payload = normalizeWebhookPayload(
        this.#options.normalizeWebhookPayload
          ? this.#options.normalizeWebhookPayload(rawPayload)
          : rawPayload,
      );
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

  async #ensureWebhookServer(): Promise<StartedWebhookServer> {
    if (this.#serverClosing) {
      await this.#serverClosing;
    }
    if (this.#server) {
      return this.#server;
    }
    if (this.#serverStarting) {
      return await this.#serverStarting;
    }

    const webhook = this.#options.webhook;
    const host = webhook?.host ?? this.#options.defaultWebhook.host;
    const port = webhook?.port ?? this.#options.defaultWebhook.port;
    const webhookPath = webhook?.path ?? this.#options.defaultWebhook.path;
    const starting = (async () => {
      try {
        return await startWebhookServer({
          handle: (request) => this.#handleWebhook(request),
          host,
          path: webhookPath,
          port,
        });
      } catch (error) {
        throw new CrablineError(
          `${this.platform} local mock webhook server failed: ${ensureErrorMessage(error)}`,
          { cause: error, kind: "connectivity" },
        );
      }
    })();
    this.#serverStarting = starting;

    try {
      const server = await starting;
      this.#server = server;
      return server;
    } finally {
      if (this.#serverStarting === starting) {
        this.#serverStarting = null;
      }
    }
  }

  async #closeWebhookServer(): Promise<void> {
    let server = this.#server;
    if (!server && this.#serverStarting) {
      try {
        server = await this.#serverStarting;
      } catch {
        return;
      }
    }
    if (!server) {
      return;
    }

    if (this.#server === server) {
      this.#server = null;
    }
    await server.close();
  }
}
