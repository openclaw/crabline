import path from "node:path";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import type { ProviderConfig, ProviderPlatform } from "../config/schema.js";
import {
  appendRecordedInbound,
  cloneRecordedInboundCursor,
  createRecordedInboundCursor,
  waitForRecordedInbound,
  watchRecordedInbound,
  type RecordedInboundEnvelope,
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
  createWebhookSuccessResponse?: (payload: unknown, id: string) => Promise<Response> | Response;
  defaultWebhook: Required<Pick<LocalMockWebhookConfig, "host" | "path" | "port">>;
  endpointLabel: string;
  matchesThread?: (
    candidateThreadId: string,
    expectedThreadId: string | undefined,
    target: NormalizedTarget,
    raw?: unknown,
  ) => boolean;
  handleWebhookPayload?: (payload: unknown) => Promise<Response | undefined> | Response | undefined;
  normalizeWebhookPayload?: (payload: unknown) => unknown;
  platform: ProviderPlatform;
  publicUrl?: string | undefined;
  recorderPath?: string | undefined;
  webhook?: LocalMockWebhookConfig | undefined;
};

const MAX_WAIT_CURSORS = 64;

type WaitCursorState = {
  active: number;
  cursor?: RecordedInboundCursor | undefined;
};

function pruneInactiveWaitCursors(cursors: Map<string, WaitCursorState>): void {
  for (const [key, state] of cursors) {
    if (cursors.size <= MAX_WAIT_CURSORS) {
      return;
    }
    if (state.active === 0) {
      cursors.delete(key);
    }
  }
}

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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CrablineError("mock webhook payload must be an object", { kind: "inbound" });
  }

  const record = payload as Record<string, unknown>;
  const messageValue = record.message;
  if (
    messageValue !== undefined &&
    (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue))
  ) {
    throw new CrablineError("mock webhook payload message must be an object", {
      kind: "inbound",
    });
  }

  for (const [label, envelope] of [
    ["payload", record],
    ["payload.message", messageValue as Record<string, unknown> | undefined],
  ] as const) {
    if (!envelope) {
      continue;
    }
    if (
      envelope.author !== undefined &&
      envelope.author !== "assistant" &&
      envelope.author !== "system" &&
      envelope.author !== "user"
    ) {
      throw new CrablineError(`${label}.author must be assistant, system, or user`, {
        kind: "inbound",
      });
    }
    if (envelope.authorIsBot !== undefined && typeof envelope.authorIsBot !== "boolean") {
      throw new CrablineError(`${label}.authorIsBot must be a boolean`, { kind: "inbound" });
    }
    for (const field of ["id", "text", "threadId"] as const) {
      const value = envelope[field];
      if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
        throw new CrablineError(`${label}.${field} must be a non-empty string`, {
          kind: "inbound",
        });
      }
    }
  }

  return payload as MockWebhookPayload;
}

function mockReplyText(params: { platform: ProviderPlatform; text: string }) {
  return `[${params.platform} mock] ${params.text}`;
}

function isOutboundRecord(event: RecordedInboundEnvelope): boolean {
  if (event.recordedDirection !== undefined) {
    return event.recordedDirection === "outbound";
  }
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
  readonly #activeSends = new Set<Promise<SendResult>>();
  readonly #cleanupController = new AbortController();
  readonly #waitCursors = new Map<string, WaitCursorState>();
  #cleanupBegun = false;
  #cleanupPromise: Promise<void> | null = null;
  #server: StartedWebhookServer | null = null;
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
    this.#assertActive();
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

  send(context: SendContext): Promise<SendResult> {
    try {
      this.#assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    const sending = this.#send(context);
    this.#activeSends.add(sending);
    void sending.then(
      () => this.#activeSends.delete(sending),
      () => this.#activeSends.delete(sending),
    );
    return sending;
  }

  async #send(context: SendContext): Promise<SendResult> {
    const threadId = this.#codec.resolveThreadId(context.fixture.target);
    const messageId = createMessageId(this.platform);
    this.#assertActive();
    await appendRecordedInbound(this.#recorderPath, {
      author: "user",
      id: messageId,
      provider: this.id,
      raw: {
        direction: "outbound",
        mode: context.mode,
        platform: this.platform,
      },
      recordedDirection: "outbound",
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
        recordedDirection: "inbound",
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
    this.#assertActive();
    const signal = this.#signalFor(context.signal);
    await this.#ensureWebhookServer();
    const target = this.normalizeTarget(context.fixture.target);
    const expectedAuthor = context.fixture.inboundMatch.author;
    const channelId = context.threadId ?? target.threadId ?? target.channelId;
    const cursorKey = JSON.stringify([context.nonce, context.since, channelId, expectedAuthor]);
    const cursorState = this.#waitCursors.get(cursorKey) ?? { active: 0 };
    const cursor = cursorState.cursor
      ? cloneRecordedInboundCursor(cursorState.cursor)
      : createRecordedInboundCursor();
    cursorState.active++;
    this.#waitCursors.delete(cursorKey);
    this.#waitCursors.set(cursorKey, cursorState);
    pruneInactiveWaitCursors(this.#waitCursors);

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
            candidate.raw,
          ),
        since: context.since,
        signal,
        timeoutMs: context.timeoutMs,
      });
      if (event && this.#waitCursors.get(cursorKey) === cursorState) {
        cursorState.cursor = cursor;
      }
      return event;
    } finally {
      cursorState.active--;
      if (
        cursorState.active === 0 &&
        !cursorState.cursor &&
        this.#waitCursors.get(cursorKey) === cursorState
      ) {
        this.#waitCursors.delete(cursorKey);
      }
    }
  }

  async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    this.#assertActive();
    const signal = this.#signalFor(context.signal);
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
          entry.raw,
        ),
      signal,
      since: context.since,
    })) {
      yield event;
    }
  }

  #beginCleanup(): void {
    if (this.#cleanupBegun) {
      return;
    }
    this.#cleanupBegun = true;
    this.#cleanupController.abort(this.#cleanedUpError());
    this.#waitCursors.clear();
  }

  async cleanup(): Promise<void> {
    this.#beginCleanup();
    this.#cleanupPromise ??= (async () => {
      const sends = [...this.#activeSends];
      const [serverResult] = await Promise.allSettled([this.#closeWebhookServer(), ...sends]);
      if (serverResult?.status === "rejected") {
        throw serverResult.reason;
      }
    })();
    await this.#cleanupPromise;
  }

  async #handleWebhook(request: Request): Promise<Response> {
    if (this.#cleanupBegun) {
      return new Response("provider is shutting down", { status: 503 });
    }
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return new Response("expected application/json", { status: 415 });
    }
    const rawBody = await request.text();
    const authenticationFailure = await this.#options.authenticateWebhookRequest?.(
      request,
      rawBody,
    );
    if (authenticationFailure) {
      return authenticationFailure;
    }
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawBody) as unknown;
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }
    const directResponse = await this.#options.handleWebhookPayload?.(rawPayload);
    if (directResponse) {
      return directResponse;
    }
    let payload: MockWebhookPayload;
    try {
      payload = normalizeWebhookPayload(
        this.#options.normalizeWebhookPayload
          ? this.#options.normalizeWebhookPayload(rawPayload)
          : rawPayload,
      );
    } catch (error) {
      if (error instanceof CrablineError && error.kind === "inbound") {
        return new Response(ensureErrorMessage(error), { status: 400 });
      }
      throw error;
    }

    const id = payload.message?.id ?? payload.id ?? createMessageId(this.platform);
    const threadId = payload.message?.threadId ?? payload.threadId;
    const text = payload.message?.text ?? payload.text;
    if (!threadId || !text) {
      return new Response("payload requires message.threadId and message.text", { status: 400 });
    }
    if (this.#cleanupBegun) {
      return new Response("provider is shutting down", { status: 503 });
    }

    await appendRecordedInbound(this.#recorderPath, {
      author: authorFromPayload(payload),
      id,
      provider: this.id,
      raw: payload.message?.raw ?? payload.raw ?? payload,
      recordedDirection: "inbound",
      sentAt: new Date().toISOString(),
      text,
      threadId,
    });
    return (
      (await this.#options.createWebhookSuccessResponse?.(rawPayload, id)) ??
      new Response(JSON.stringify({ ok: true, id }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    );
  }

  async #ensureWebhookServer(): Promise<StartedWebhookServer> {
    if (this.#cleanupBegun) {
      throw this.#cleanedUpError();
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
      if (this.#cleanupBegun) {
        throw this.#cleanedUpError();
      }
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

  #cleanedUpError(): CrablineError {
    return new CrablineError(`Provider "${this.id}" has been cleaned up.`, { kind: "config" });
  }

  #assertActive(): void {
    if (this.#cleanupBegun) {
      throw this.#cleanedUpError();
    }
  }

  #signalFor(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.#cleanupController.signal])
      : this.#cleanupController.signal;
  }
}
