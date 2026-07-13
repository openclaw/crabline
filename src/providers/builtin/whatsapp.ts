import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import { matchesInbound } from "../../core/matcher.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, type LocalMockWebhookConfig } from "../local-mock.js";
import {
  appendRecordedInboundBatch,
  cloneRecordedInboundCursor,
  createRecordedInboundCursor,
  waitForRecordedInbound,
  watchRecordedInbound,
  type RecordedInboundCursor,
  type RecordedInboundEnvelope,
} from "../recorder.js";
import type {
  InboundEnvelope,
  ProbeResult,
  ProviderAdapter,
  ProviderContext,
  SendContext,
  SendResult,
  WaitContext,
  WatchContext,
} from "../types.js";
import { getBuiltinTargetCodec, WHATSAPP_WA_ID_RULE } from "../target-normalizers.js";
import { startWebhookServer, type StartedWebhookServer } from "../webhook-server.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  normalizeAuthor,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

type NormalizedWhatsAppWebhookMessage = {
  author?: "assistant" | "system" | "user";
  authorIsBot?: boolean;
  id?: string;
  message?: {
    author?: "assistant" | "system" | "user";
    authorIsBot?: boolean;
    id?: string;
    raw?: unknown;
    sentAt?: string;
    text?: string;
    threadId?: string;
  };
  raw?: unknown;
  sentAt?: string;
  text?: string;
  threadId?: string;
};

type WhatsAppEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "WHATSAPP_ACCESS_TOKEN"
    | "WHATSAPP_APP_SECRET"
    | "WHATSAPP_PHONE_NUMBER_ID"
    | "WHATSAPP_VERIFY_TOKEN"
  >
>;

const DEFAULT_WHATSAPP_WEBHOOK = {
  host: "127.0.0.1",
  path: "/whatsapp/webhook",
  port: 8789,
} as const;
const MAX_WAIT_CURSORS = 64;
const MAX_WHATSAPP_WEBHOOK_BODY_BYTES = 1024 * 1024;
const WHATSAPP_WEBHOOK_BODY_TIMEOUT_MS = 5_000;

class WhatsAppWebhookBodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readWhatsAppWebhookBody(
  request: Request,
  lifecycleSignal: AbortSignal,
): Promise<string> {
  if (!request.body) {
    return "";
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new WhatsAppWebhookBodyError("webhook request body timed out", 408));
  }, WHATSAPP_WEBHOOK_BODY_TIMEOUT_MS);
  timeout.unref();
  const signal = AbortSignal.any([lifecycleSignal, request.signal, timeoutController.signal]);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let completed = false;
  let failure: unknown;

  try {
    while (true) {
      const result = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
        (resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void reader.read().then(
            (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
        },
      );
      if (result.done) {
        completed = true;
        return Buffer.concat(chunks).toString("utf8");
      }
      const chunk = Buffer.from(result.value);
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_WHATSAPP_WEBHOOK_BODY_BYTES) {
        throw new WhatsAppWebhookBodyError("request body too large", 413);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!completed) {
      void reader.cancel(failure ?? signal.reason).catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
}

export function resolveWhatsAppAdapterConfig(
  config: ProviderConfig,
  env: WhatsAppEnvironment = process.env,
) {
  const appSecret = config.whatsapp?.appSecret ?? env.WHATSAPP_APP_SECRET;
  const verifyToken = config.whatsapp?.verifyToken ?? env.WHATSAPP_VERIFY_TOKEN;
  if (!appSecret || !verifyToken) {
    throw new CrablineError(
      "WhatsApp webhook operation requires appSecret and verifyToken configuration.",
      { kind: "config" },
    );
  }
  return {
    accessToken: config.whatsapp?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN ?? "local-mock-token",
    appSecret,
    ...((config.whatsapp?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID)
      ? { phoneNumberId: config.whatsapp?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID! }
      : {}),
    verifyToken,
  };
}

type ResolvedWhatsAppAdapterConfig = ReturnType<typeof resolveWhatsAppAdapterConfig>;
type WaitCursorState = {
  active: number;
  cursor?: RecordedInboundCursor | undefined;
};

function cursorHasAdvanced(
  candidate: RecordedInboundCursor,
  current: RecordedInboundCursor | undefined,
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.readState.generation !== current.readState.generation) {
    return candidate.readState.generation > current.readState.generation;
  }
  if (candidate.readState.offset !== current.readState.offset) {
    return candidate.readState.offset > current.readState.offset;
  }
  return candidate.buffered.length < current.buffered.length;
}

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

function pruneSettledWaitCursors(cursors: Map<string, WaitCursorState>): void {
  if ([...cursors.values()].some((state) => state.active > 0)) {
    return;
  }
  pruneInactiveWaitCursors(cursors);
}

export class WhatsAppProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  readonly #config: ProviderConfig;
  readonly #env: WhatsAppEnvironment;
  readonly #lifecycleAbort = new AbortController();
  readonly #publicUrl: string | undefined;
  readonly #recorderPath: string;
  readonly #webhook: LocalMockWebhookConfig | undefined;
  #cleanedUp = false;
  #cleanupBegun = false;
  #cleanupPromise: Promise<void> | null = null;
  readonly #inFlightSends = new Set<Promise<SendResult>>();
  readonly #inFlightWebhookRequests = new Set<Promise<Response>>();
  readonly #waitCursors = new Map<string, WaitCursorState>();
  #server: StartedWebhookServer | null = null;
  #serverClosing: Promise<void> | null = null;
  #serverStarting: Promise<StartedWebhookServer> | null = null;

  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    super({
      codec: getBuiltinTargetCodec("whatsapp"),
      config,
      id,
      options: {
        defaultWebhook: DEFAULT_WHATSAPP_WEBHOOK,
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeWhatsAppWebhookPayload,
        platform: "whatsapp",
        publicUrl: config.whatsapp?.webhook.publicUrl,
        recorderPath: config.whatsapp?.recorder.path
          ? path.resolve(config.whatsapp.recorder.path)
          : undefined,
        webhook: config.whatsapp?.webhook,
      },
    });
    this.#config = config;
    this.#env = (runtime as { env?: WhatsAppEnvironment } | undefined)?.env ?? process.env;
    this.#publicUrl = config.whatsapp?.webhook.publicUrl;
    this.#recorderPath = config.whatsapp?.recorder.path
      ? path.resolve(config.whatsapp.recorder.path)
      : path.resolve(".crabline", "recorders", `${id}.jsonl`);
    this.#webhook = config.whatsapp?.webhook;
  }

  override async probe(context: ProviderContext): Promise<ProbeResult> {
    context.signal?.throwIfAborted();
    const server = await this.#ensureWebhookServer();
    if (this.#cleanupBegun || this.#cleanedUp) {
      throw this.#cleanedUpError();
    }
    context.signal?.throwIfAborted();
    const target = this.normalizeTarget(context.fixture.target);
    const details = [
      "whatsapp local mock ready",
      `recorder path ${this.#recorderPath}`,
      `webhook endpoint ${server.endpointUrl}`,
    ];
    if (this.#publicUrl) {
      details.push(`public webhook ${this.#publicUrl}`);
    }
    if (target.threadId) {
      details.push(`thread reachable ${target.threadId}`);
    } else if (target.channelId) {
      details.push(`channel reachable ${target.channelId}`);
    } else {
      details.push(`dm reachable ${target.id}`);
    }
    return { details, healthy: true };
  }

  override async send(context: SendContext): Promise<SendResult> {
    if (this.#cleanupBegun || this.#cleanedUp) {
      throw this.#cleanedUpError();
    }
    const sending = super.send(context);
    this.#inFlightSends.add(sending);
    try {
      return await sending;
    } finally {
      this.#inFlightSends.delete(sending);
    }
  }

  override async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    if (context.signal?.aborted) {
      return null;
    }
    try {
      await this.#ensureWebhookServer();
    } catch (error) {
      if (this.#cleanupBegun) {
        return null;
      }
      throw error;
    }
    if (this.#cleanupBegun) {
      return null;
    }
    const target = this.normalizeTarget(context.fixture.target);
    const channelId = context.threadId ?? target.threadId ?? target.channelId ?? target.id;
    const cursorKey = JSON.stringify([
      context.nonce,
      context.since,
      channelId,
      context.fixture.inboundMatch,
    ]);
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
          isAddressInChannel(candidate.threadId, channelId) &&
          matchesInbound(candidate, context.fixture.inboundMatch, context.nonce),
        since: context.since,
        signal: this.#operationSignal(context.signal),
        timeoutMs: context.timeoutMs,
      });
      if (
        this.#waitCursors.get(cursorKey) === cursorState &&
        cursorHasAdvanced(cursor, cursorState.cursor)
      ) {
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
      pruneSettledWaitCursors(this.#waitCursors);
    }
  }

  override async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    if (context.signal?.aborted) {
      return;
    }
    try {
      await this.#ensureWebhookServer();
    } catch (error) {
      if (this.#cleanupBegun) {
        return;
      }
      throw error;
    }
    if (this.#cleanupBegun) {
      return;
    }
    const target = this.normalizeTarget(context.fixture.target);
    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) =>
        entry.provider === this.id &&
        !isOutboundRecord(entry) &&
        isAddressInChannel(entry.threadId, target.threadId ?? target.channelId ?? target.id),
      signal: this.#operationSignal(context.signal),
      since: context.since,
    })) {
      yield event;
    }
  }

  beginCleanup(): void {
    if (this.#cleanupBegun) {
      return;
    }
    this.#cleanupBegun = true;
    this.#lifecycleAbort.abort(this.#cleanedUpError());
    this.#serverClosing = this.#closeWebhookServer();
    void this.#serverClosing.catch(() => undefined);
  }

  override async cleanup(): Promise<void> {
    this.beginCleanup();
    this.#cleanedUp = true;
    this.#waitCursors.clear();
    this.#cleanupPromise ??= (async () => {
      await Promise.allSettled([...this.#inFlightSends, ...this.#inFlightWebhookRequests]);
      const errors: unknown[] = [];
      try {
        await this.#serverClosing;
      } catch (error) {
        errors.push(error);
      }
      try {
        await super.cleanup();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "WhatsApp cleanup failed");
      }
    })();
    await this.#cleanupPromise;
  }

  #handleWebhookRequest(
    request: Request,
    resolvedConfig: ResolvedWhatsAppAdapterConfig,
  ): Promise<Response> {
    if (this.#cleanupBegun) {
      return Promise.resolve(this.#cleanedUpResponse());
    }
    const handling = this.#handleWebhook(request, resolvedConfig);
    this.#inFlightWebhookRequests.add(handling);
    void handling.then(
      () => this.#inFlightWebhookRequests.delete(handling),
      () => this.#inFlightWebhookRequests.delete(handling),
    );
    return handling;
  }

  async #handleWebhook(
    request: Request,
    resolvedConfig: ResolvedWhatsAppAdapterConfig,
  ): Promise<Response> {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const mode = url.searchParams.get("hub.mode");
      const providedValue = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (
        mode === "subscribe" &&
        providedValue === resolvedConfig.verifyToken &&
        challenge !== null
      ) {
        return new Response(challenge, {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        });
      }
      return new Response("forbidden", { status: 403 });
    }

    let rawBody: string;
    try {
      rawBody = await readWhatsAppWebhookBody(request, this.#lifecycleAbort.signal);
    } catch (error) {
      if (this.#cleanupBegun) {
        return this.#cleanedUpResponse();
      }
      if (error instanceof WhatsAppWebhookBodyError) {
        return new Response(error.message, { status: error.status });
      }
      return new Response("invalid request body", { status: 400 });
    }
    if (
      !hasValidWhatsAppSignature(
        rawBody,
        request.headers.get("x-hub-signature-256"),
        resolvedConfig.appSecret,
      )
    ) {
      return new Response("invalid webhook signature", { status: 401 });
    }
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return new Response("expected application/json", { status: 415 });
    }

    let messages: NormalizedWhatsAppWebhookMessage[];
    try {
      messages = normalizeWhatsAppWebhookPayload(JSON.parse(rawBody), resolvedConfig.phoneNumberId);
    } catch (error) {
      return new Response(ensureErrorMessage(error), { status: 400 });
    }

    const ids: string[] = [];
    const records: InboundEnvelope[] = [];
    for (const message of messages) {
      const id = message.message?.id ?? message.id ?? createMessageId();
      const threadId = message.message?.threadId ?? message.threadId;
      const text = message.message?.text ?? message.text;
      if (!threadId || !text) {
        return new Response("payload requires message.threadId and message.text", { status: 400 });
      }

      records.push({
        author: authorFromPayload(message),
        id,
        provider: this.id,
        raw: message.message?.raw ?? message.raw ?? message,
        sentAt: message.message?.sentAt ?? message.sentAt ?? new Date().toISOString(),
        text,
        threadId,
      });
      ids.push(id);
    }
    await appendRecordedInboundBatch(this.#recorderPath, records);

    return new Response(
      JSON.stringify(ids.length === 1 ? { id: ids[0], ok: true } : { ids, ok: true }),
      {
        headers: { "content-type": "application/json" },
        status: 200,
      },
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

    const resolvedConfig = resolveWhatsAppAdapterConfig(this.#config, this.#env);
    const host = this.#webhook?.host ?? DEFAULT_WHATSAPP_WEBHOOK.host;
    const port = this.#webhook?.port ?? DEFAULT_WHATSAPP_WEBHOOK.port;
    const webhookPath = this.#webhook?.path ?? DEFAULT_WHATSAPP_WEBHOOK.path;
    const starting = (async (): Promise<StartedWebhookServer> => {
      let server: StartedWebhookServer;
      try {
        server = await startWebhookServer({
          handle: (request) => this.#handleWebhookRequest(request, resolvedConfig),
          host,
          methods: ["GET", "POST"],
          path: webhookPath,
          port,
        });
      } catch (error) {
        throw new CrablineError(
          `whatsapp local mock webhook server failed: ${ensureErrorMessage(error)}`,
          { cause: error, kind: "connectivity" },
        );
      }

      this.#server = server;
      if (this.#cleanupBegun) {
        throw this.#cleanedUpError();
      }
      return server;
    })();
    this.#serverStarting = starting;

    try {
      return await starting;
    } finally {
      if (this.#serverStarting === starting) {
        this.#serverStarting = null;
      }
    }
  }

  async #closeWebhookServer(): Promise<void> {
    const starting = this.#serverStarting;
    if (starting) {
      try {
        await starting;
      } catch {
        // A failed startup has no listener; a cleanup race publishes one below.
      }
    }
    const server = this.#server;
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

  #cleanedUpResponse(): Response {
    return new Response(`Provider "${this.id}" has been cleaned up.`, { status: 503 });
  }

  #operationSignal(signal: AbortSignal | undefined): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.#lifecycleAbort.signal])
      : this.#lifecycleAbort.signal;
  }
}

export function normalizeWhatsAppWebhookPayload(
  payload: unknown,
  expectedPhoneNumberId?: string,
): NormalizedWhatsAppWebhookMessage[] {
  if (!isRecord(payload)) {
    throw new CrablineError("WhatsApp webhook payload must be an object", { kind: "inbound" });
  }

  const normalized: NormalizedWhatsAppWebhookMessage[] = [];
  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      if (!isRecord(entry) || !Array.isArray(entry.changes)) {
        continue;
      }
      for (const change of entry.changes) {
        if (!isRecord(change)) {
          continue;
        }
        const value = optionalRecord(change, "value");
        if (!value || !Array.isArray(value.messages)) {
          continue;
        }
        const metadata = optionalRecord(value, "metadata");
        if (
          expectedPhoneNumberId !== undefined &&
          optionalString(metadata ?? {}, "phone_number_id") !== expectedPhoneNumberId
        ) {
          continue;
        }
        for (const message of value.messages) {
          if (!isRecord(message)) {
            throw new CrablineError("WhatsApp webhook messages[] entries must be objects", {
              kind: "inbound",
            });
          }
          const normalizedMessage = normalizeWhatsAppMessage(message);
          if (normalizedMessage) {
            normalized.push(normalizedMessage);
          }
        }
      }
    }
    return normalized;
  }

  const fallback = genericMockPayloadWithNativeThread({
    channelRule: WHATSAPP_WA_ID_RULE,
    payload,
    threadRule: WHATSAPP_WA_ID_RULE,
  }) as Record<string, unknown>;
  return [normalizeWhatsAppFallback(fallback, payload)];
}

function normalizeWhatsAppFallback(
  fallback: Record<string, unknown>,
  source: Record<string, unknown>,
): NormalizedWhatsAppWebhookMessage {
  const normalized: NormalizedWhatsAppWebhookMessage = {
    raw: fallback.raw ?? fallback,
  };
  const author = normalizeAuthor(fallback.author);
  if (author) {
    normalized.author = author;
  }
  if (typeof fallback.authorIsBot === "boolean") {
    normalized.authorIsBot = fallback.authorIsBot;
  }
  const id = optionalString(fallback, "id");
  if (id) {
    normalized.id = id;
  }
  const text = optionalString(fallback, "text");
  if (text) {
    normalized.text = text;
  }
  const threadId = optionalString(fallback, "threadId");
  if (threadId) {
    normalized.threadId = threadId;
  }
  const sentAt = optionalString(source, "sentAt");
  if (sentAt) {
    normalized.sentAt = whatsAppFallbackTimestampToIso(sentAt, "sentAt");
  }

  const message = optionalRecord(fallback, "message");
  if (message) {
    const sourceMessage = optionalRecord(source, "message");
    const normalizedMessage: NonNullable<NormalizedWhatsAppWebhookMessage["message"]> = {};
    const messageAuthor = normalizeAuthor(message.author);
    if (messageAuthor) {
      normalizedMessage.author = messageAuthor;
    }
    if (typeof message.authorIsBot === "boolean") {
      normalizedMessage.authorIsBot = message.authorIsBot;
    }
    const messageId = optionalString(message, "id");
    if (messageId) {
      normalizedMessage.id = messageId;
    }
    if (message.raw !== undefined) {
      normalizedMessage.raw = message.raw;
    }
    const messageSentAt = sourceMessage ? optionalString(sourceMessage, "sentAt") : undefined;
    if (messageSentAt) {
      normalizedMessage.sentAt = whatsAppFallbackTimestampToIso(messageSentAt, "message.sentAt");
    }
    const messageText = optionalString(message, "text");
    if (messageText) {
      normalizedMessage.text = messageText;
    }
    const messageThreadId = optionalString(message, "threadId");
    if (messageThreadId) {
      normalizedMessage.threadId = messageThreadId;
    }
    normalized.message = normalizedMessage;
  }

  return normalized;
}

function normalizeWhatsAppMessage(
  message: Record<string, unknown>,
): NormalizedWhatsAppWebhookMessage | null {
  const messageType = optionalString(message, "type");
  if (messageType && messageType !== "text") {
    return null;
  }

  const text = optionalRecord(message, "text");
  const from = optionalString(message, "from");
  const body = text ? optionalString(text, "body") : undefined;
  if (!from || !body) {
    throw new CrablineError("WhatsApp webhook payload requires messages[].from and text.body", {
      kind: "inbound",
    });
  }

  const messageId = optionalString(message, "id");
  if (!messageId) {
    throw new CrablineError("WhatsApp webhook payload requires messages[].id", {
      kind: "inbound",
    });
  }
  const timestamp = optionalString(message, "timestamp");
  return {
    author: authorFromBotFlag(false),
    id: messageId,
    raw: message,
    ...(timestamp ? { sentAt: whatsAppTimestampToIso(timestamp) } : {}),
    text: body,
    threadId: requireNativeInboundId(from, WHATSAPP_WA_ID_RULE, "WhatsApp messages[].from"),
  };
}

function whatsAppTimestampToIso(timestamp: string): string {
  if (!/^\d+$/u.test(timestamp)) {
    throw new CrablineError("WhatsApp messages[].timestamp must be Unix seconds", {
      kind: "inbound",
    });
  }
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new CrablineError("WhatsApp messages[].timestamp is out of range", { kind: "inbound" });
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new CrablineError("WhatsApp messages[].timestamp is invalid", { kind: "inbound" });
  }
  return date.toISOString();
}

function whatsAppFallbackTimestampToIso(timestamp: string, field: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new CrablineError(`WhatsApp fallback ${field} must be a valid timestamp`, {
      kind: "inbound",
    });
  }
  return date.toISOString();
}

function authorFromPayload(payload: NormalizedWhatsAppWebhookMessage): InboundEnvelope["author"] {
  const explicit = payload.message?.author ?? payload.author;
  if (explicit) {
    return explicit;
  }
  return (payload.message?.authorIsBot ?? payload.authorIsBot ?? true) ? "assistant" : "user";
}

function createMessageId(): string {
  return `whatsapp-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasValidWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
  signingKey: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const signature = signatureHeader.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", signingKey).update(rawBody).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }
  return threadId === channelId || threadId.startsWith(`${channelId}:`);
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
