import path from "node:path";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import { matchesInbound } from "../../core/matcher.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter, type LocalMockWebhookConfig } from "../local-mock.js";
import {
  appendRecordedInbound,
  waitForRecordedInbound,
  watchRecordedInbound,
} from "../recorder.js";
import type {
  InboundEnvelope,
  ProbeResult,
  ProviderAdapter,
  ProviderContext,
  WaitContext,
  WatchContext,
} from "../types.js";
import { startWebhookServer, type StartedWebhookServer } from "../webhook-server.js";
import {
  authorFromBotFlag,
  createNativeTargetCodec,
  genericMockPayloadWithNativeThread,
  isRecord,
  normalizeAuthor,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
  type NativeIdRule,
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
    text?: string;
    threadId?: string;
  };
  raw?: unknown;
  text?: string;
  threadId?: string;
};

const WHATSAPP_WA_ID_RULE: NativeIdRule = {
  example: "15551234567",
  name: "WhatsApp wa_id",
  pattern: /^\d{7,15}$/u,
};

const DEFAULT_WHATSAPP_WEBHOOK = {
  host: "127.0.0.1",
  path: "/whatsapp/webhook",
  port: 8789,
} as const;

export function resolveWhatsAppAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    accessToken: config.whatsapp?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN ?? "local-mock-token",
    appSecret: config.whatsapp?.appSecret ?? env.WHATSAPP_APP_SECRET ?? "local-mock-secret",
    phoneNumberId:
      config.whatsapp?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID ?? "local-mock-phone",
    verifyToken: config.whatsapp?.verifyToken ?? env.WHATSAPP_VERIFY_TOKEN ?? "local-mock-verify",
  };
}

export class WhatsAppProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  readonly #publicUrl: string | undefined;
  readonly #recorderPath: string;
  readonly #webhook: LocalMockWebhookConfig | undefined;
  #server: StartedWebhookServer | null = null;
  #serverClosing: Promise<void> | null = null;
  #serverStarting: Promise<StartedWebhookServer> | null = null;

  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: WHATSAPP_WA_ID_RULE,
        channelLabel: "WhatsApp wa_id",
      }),
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
    this.#publicUrl = config.whatsapp?.webhook.publicUrl;
    this.#recorderPath = config.whatsapp?.recorder.path
      ? path.resolve(config.whatsapp.recorder.path)
      : path.resolve(".crabline", "recorders", `${id}.jsonl`);
    this.#webhook = config.whatsapp?.webhook;
  }

  override async probe(context: ProviderContext): Promise<ProbeResult> {
    const server = await this.#ensureWebhookServer();
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

  override async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    await this.#ensureWebhookServer();
    const target = this.normalizeTarget(context.fixture.target);
    return await waitForRecordedInbound({
      filePath: this.#recorderPath,
      matches: (event) =>
        event.provider === this.id &&
        isAddressInChannel(
          event.threadId,
          context.threadId ?? target.threadId ?? target.channelId ?? target.id,
        ) &&
        matchesInbound(event, context.fixture.inboundMatch, context.nonce),
      since: context.since,
      timeoutMs: context.timeoutMs,
    });
  }

  override async *watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    await this.#ensureWebhookServer();
    const target = this.normalizeTarget(context.fixture.target);
    for await (const event of watchRecordedInbound({
      filePath: this.#recorderPath,
      matches: (entry) =>
        entry.provider === this.id &&
        isAddressInChannel(entry.threadId, target.threadId ?? target.channelId ?? target.id),
      since: context.since,
    })) {
      yield event;
    }
  }

  override async cleanup(): Promise<void> {
    if (this.#serverClosing) {
      await this.#serverClosing;
    } else {
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
    await super.cleanup();
  }

  async #handleWebhook(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return new Response("expected application/json", { status: 415 });
    }

    let messages: NormalizedWhatsAppWebhookMessage[];
    try {
      messages = normalizeWhatsAppWebhookPayload(await request.json());
    } catch (error) {
      return new Response(ensureErrorMessage(error), { status: 400 });
    }

    const ids: string[] = [];
    for (const message of messages) {
      const id = message.message?.id ?? message.id ?? createMessageId();
      const threadId = message.message?.threadId ?? message.threadId;
      const text = message.message?.text ?? message.text;
      if (!threadId || !text) {
        return new Response("payload requires message.threadId and message.text", { status: 400 });
      }

      await appendRecordedInbound(this.#recorderPath, {
        author: authorFromPayload(message),
        id,
        provider: this.id,
        raw: message.message?.raw ?? message.raw ?? message,
        sentAt: new Date().toISOString(),
        text,
        threadId,
      });
      ids.push(id);
    }

    return new Response(
      JSON.stringify(ids.length === 1 ? { id: ids[0], ok: true } : { ids, ok: true }),
      {
        headers: { "content-type": "application/json" },
        status: 200,
      },
    );
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

    const host = this.#webhook?.host ?? DEFAULT_WHATSAPP_WEBHOOK.host;
    const port = this.#webhook?.port ?? DEFAULT_WHATSAPP_WEBHOOK.port;
    const webhookPath = this.#webhook?.path ?? DEFAULT_WHATSAPP_WEBHOOK.path;
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
          `whatsapp local mock webhook server failed: ${ensureErrorMessage(error)}`,
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

export function normalizeWhatsAppWebhookPayload(
  payload: unknown,
): NormalizedWhatsAppWebhookMessage[] {
  if (!isRecord(payload)) {
    throw new CrablineError("WhatsApp webhook payload must be an object", { kind: "inbound" });
  }

  const normalized: NormalizedWhatsAppWebhookMessage[] = [];
  let firstMalformedMessageError: unknown;
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
        for (const message of value.messages) {
          if (!isRecord(message)) {
            continue;
          }
          try {
            const normalizedMessage = normalizeWhatsAppMessage(message);
            if (normalizedMessage) {
              normalized.push(normalizedMessage);
            }
          } catch (error) {
            firstMalformedMessageError ??= error;
          }
        }
      }
    }

    if (normalized.length > 0) {
      return normalized;
    }
    if (firstMalformedMessageError) {
      throw firstMalformedMessageError;
    }
    return [];
  }

  const fallback = genericMockPayloadWithNativeThread({
    channelRule: WHATSAPP_WA_ID_RULE,
    payload,
    threadRule: WHATSAPP_WA_ID_RULE,
  }) as Record<string, unknown>;
  return [normalizeWhatsAppFallback(fallback)];
}

function normalizeWhatsAppFallback(
  fallback: Record<string, unknown>,
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

  const message = optionalRecord(fallback, "message");
  if (message) {
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
  return {
    author: authorFromBotFlag(false),
    ...(messageId ? { id: messageId } : {}),
    raw: message,
    text: body,
    threadId: requireNativeInboundId(from, WHATSAPP_WA_ID_RULE, "WhatsApp messages[].from"),
  };
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

function isAddressInChannel(threadId: string, channelId?: string): boolean {
  if (!channelId) {
    return true;
  }
  return threadId === channelId || threadId.startsWith(`${channelId}:`);
}
