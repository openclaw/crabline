import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelegramAdapterConfig,
  TelegramProviderAdapter,
} from "../src/providers/builtin/telegram.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type FakeInboundPayload = {
  authorIsBot?: boolean;
  id: string;
  text: string;
  threadId: string;
};

type FakeMessage = {
  author: { isBot: boolean };
  id: string;
  metadata: { dateSent: Date };
  raw: Record<string, never>;
  text: string;
  threadId: string;
};

const directories: string[] = [];
const providers: TelegramProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createTelegramConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "telegram",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "telegram",
    status: "active",
    telegram: {
      botToken: "telegram-token",
      mode: "webhook",
      recorder: { path: path.join(directory, "telegram.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/telegram/webhook",
        port,
      },
    },
  };
}

function createFakeTelegramRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
    fetchChannelInfo: vi.fn(async (channelId: string) => ({ id: channelId })),
    openDM: vi.fn(async (userId: string) => `telegram:${userId}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "telegram-sent",
      threadId,
    })),
    stopPolling: vi.fn(async () => {}),
  };

  const chat = {
    getState() {
      return {
        subscribe: vi.fn(async (threadId: string) => {
          subscriptions.add(threadId);
        }),
      };
    },
    initialize: vi.fn(async () => {}),
    onDirectMessage(
      handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void,
    ) {
      directHandlers.push(handler);
    },
    onNewMention(handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void) {
      mentionHandlers.push(handler);
    },
    onNewMessage(
      _pattern: RegExp,
      handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void,
    ) {
      messageHandlers.push(handler);
    },
    onSubscribedMessage(
      handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void,
    ) {
      subscribedHandlers.push(handler);
    },
    webhooks: {
      telegram: vi.fn(async (request: Request) => {
        const payload = (await request.json()) as {
          kind?: "direct" | "mention" | "message" | "subscribed";
          message: FakeInboundPayload;
        };
        const handlersByKind = {
          direct: directHandlers,
          mention: mentionHandlers,
          message: messageHandlers,
          subscribed: subscribedHandlers,
        } as const;

        const kind = payload.kind ?? "subscribed";
        const message = createFakeMessage(payload.message);
        const thread = { id: message.threadId };
        for (const handler of handlersByKind[kind]) {
          await handler(thread, message);
        }

        return new Response("ok");
      }),
    },
  };

  return {
    adapter,
    chat,
    runtime: {
      createAdapter: () => adapter,
      createChat: () => chat,
    },
    subscriptions,
  };
}

function createFakeMessage(payload: FakeInboundPayload): FakeMessage {
  return {
    author: { isBot: payload.authorIsBot ?? true },
    id: payload.id,
    metadata: { dateSent: new Date() },
    raw: {},
    text: payload.text,
    threadId: payload.threadId,
  };
}

function createContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "telegram-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "telegram",
      retries: 0,
      tags: [],
      target: {
        id: "123456789",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "telegram",
    userName: "crabline",
  };
}

describe("telegram provider", () => {
  it("resolves adapter config from provider settings and env", () => {
    expect(
      resolveTelegramAdapterConfig(
        {
          adapter: "telegram",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "telegram",
          status: "active",
          telegram: {
            botToken: "config-token",
            mode: "polling",
            recorder: {},
            webhook: { host: "127.0.0.1", path: "/telegram/webhook", port: 8790 },
          },
        },
        {
          TELEGRAM_API_BASE_URL: "https://telegram.example.com",
          TELEGRAM_BOT_USERNAME: "crabline_bot",
          TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
        },
      ),
    ).toMatchObject({
      apiUrl: "https://telegram.example.com",
      botToken: "config-token",
      mode: "polling",
      secretToken: "secret",
      userName: "crabline_bot",
    });
  });

  it("normalizes chat and topic targets", async () => {
    const runtime = createFakeTelegramRuntime();
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "-100123", metadata: {} })).toMatchObject({
      channelId: "telegram:-100123",
    });
    expect(
      provider.normalizeTarget({
        channelId: "telegram:-100123",
        id: "topic",
        metadata: {},
        threadId: "42",
      }),
    ).toMatchObject({
      channelId: "telegram:-100123",
      threadId: "telegram:-100123:42",
    });
  });

  it("probes and sends through the provider adapter", async () => {
    const runtime = createFakeTelegramRuntime();
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("webhook endpoint http://127.0.0.1:");
    expect(runtime.adapter.fetchChannelInfo).toHaveBeenCalledWith("telegram:123456789");

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });

    expect(result.threadId).toBe("telegram:123456789");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith("telegram:123456789", "hello");
    expect(runtime.subscriptions.has("telegram:123456789")).toBe(true);
  });

  it("records webhook inbound events", async () => {
    const runtime = createFakeTelegramRuntime();
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "telegram:123456789",
      timeoutMs: 500,
    });

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "telegram:123456789",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-1",
      text: "ACK nonce-2",
    });
  });
});
