import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveZaloAdapterConfig, ZaloProviderAdapter } from "../src/providers/builtin/zalo.js";
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
const providers: ZaloProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createZaloConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "zalo",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "zalo",
    status: "active",
    zalo: {
      botToken: "zalo-token",
      recorder: { path: path.join(directory, "zalo.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/zalo/webhook",
        port,
      },
      webhookSecret: "zalo-secret",
    },
  };
}

function createFakeZaloRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
    fetchThread: vi.fn(async (threadId: string) => ({ id: threadId })),
    handleWebhook: vi.fn(async (request: Request) => {
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
    openDM: vi.fn(async (userId: string) => `zalo:${userId}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "zalo-sent",
      threadId,
    })),
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
      id: "zalo-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "zalo",
      retries: 0,
      tags: [],
      target: {
        id: "chat-123",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "zalo",
    userName: "crabline",
  };
}

describe("zalo provider", () => {
  it("resolves adapter config from provider settings and env", () => {
    expect(
      resolveZaloAdapterConfig(
        {
          adapter: "zalo",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "zalo",
          status: "active",
          zalo: {
            botToken: "config-token",
            recorder: {},
            userName: "crabline_zalo",
            webhook: { host: "127.0.0.1", path: "/zalo/webhook", port: 8794 },
            webhookSecret: "config-secret",
          },
        },
        {},
      ),
    ).toMatchObject({
      botToken: "config-token",
      userName: "crabline_zalo",
      webhookSecret: "config-secret",
    });
  });

  it("validates required adapter config", () => {
    const config: ProviderConfig = {
      adapter: "zalo",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      platform: "zalo",
      status: "active",
      zalo: {
        recorder: {},
        webhook: { host: "127.0.0.1", path: "/zalo/webhook", port: 8794 },
      },
    };

    expect(() => resolveZaloAdapterConfig(config, {})).toThrow(/bot token is required/u);
    expect(() =>
      resolveZaloAdapterConfig({ ...config, zalo: { ...config.zalo!, botToken: "token" } }, {}),
    ).toThrow(/webhook secret is required/u);
  });

  it("normalizes raw Zalo IDs into Chat SDK thread IDs", async () => {
    const runtime = createFakeZaloRuntime();
    const config = await createZaloConfig(0);
    const provider = new ZaloProviderAdapter("zalo", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "chat-123", metadata: {} })).toMatchObject({
      channelId: "zalo:chat-123",
    });
    expect(
      provider.normalizeTarget({ id: "ignored", metadata: {}, threadId: "zalo:chat-456" }),
    ).toMatchObject({
      threadId: "zalo:chat-456",
    });
  });

  it("probes, sends, and records webhook inbound events", async () => {
    const runtime = createFakeZaloRuntime();
    const config = await createZaloConfig(0);
    const provider = new ZaloProviderAdapter("zalo", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("webhook endpoint http://127.0.0.1:");

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });
    expect(result.threadId).toBe("zalo:chat-123");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith("zalo:chat-123", "hello");
    expect(runtime.subscriptions.has("zalo:chat-123")).toBe(true);

    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "zalo:chat-123",
      timeoutMs: 500,
    });

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "zalo:chat-123",
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
