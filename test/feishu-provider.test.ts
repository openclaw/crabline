import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeishuProviderAdapter,
  resolveFeishuAdapterConfig,
} from "../src/providers/builtin/feishu.js";
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
const providers: FeishuProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createFeishuConfig(): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "feishu",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    feishu: {
      appId: "feishu-app",
      appSecret: "feishu-secret",
      recorder: { path: path.join(directory, "feishu.jsonl") },
    },
    platform: "feishu",
    status: "active",
  };
}

function createFakeFeishuRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
    disconnect: vi.fn(async () => {}),
    fetchChannelInfo: vi.fn(async (channelId: string) => ({ id: channelId })),
    openDM: vi.fn(async (userId: string) => `lark:${userId}:`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "feishu-sent",
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

  async function emitInbound(payload: FakeInboundPayload, kind = "subscribed") {
    const handlersByKind = {
      direct: directHandlers,
      mention: mentionHandlers,
      message: messageHandlers,
      subscribed: subscribedHandlers,
    } as const;
    const message = createFakeMessage(payload);
    const thread = { id: message.threadId };
    for (const handler of handlersByKind[kind as keyof typeof handlersByKind]) {
      await handler(thread, message);
    }
  }

  return {
    adapter,
    chat,
    emitInbound,
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
      id: "feishu-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "feishu",
      retries: 0,
      tags: [],
      target: {
        id: "oc_123",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "feishu",
    userName: "crabline",
  };
}

describe("feishu provider", () => {
  it("resolves adapter config from provider settings and env", () => {
    expect(
      resolveFeishuAdapterConfig(
        {
          adapter: "feishu",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          feishu: {
            appId: "config-app",
            appSecret: "config-secret",
            recorder: {},
          },
          platform: "feishu",
          status: "active",
        },
        { FEISHU_BOT_USERNAME: "crabline_feishu" },
      ),
    ).toMatchObject({
      appId: "config-app",
      appSecret: "config-secret",
      userName: "crabline_feishu",
    });
  });

  it("validates required adapter config", () => {
    const config: ProviderConfig = {
      adapter: "feishu",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      feishu: { recorder: {} },
      platform: "feishu",
      status: "active",
    };

    expect(() => resolveFeishuAdapterConfig(config, {})).toThrow(/app id is required/u);
    expect(() =>
      resolveFeishuAdapterConfig({ ...config, feishu: { appId: "app", recorder: {} } }, {}),
    ).toThrow(/app secret is required/u);
  });

  it("normalizes Feishu chat and thread IDs", async () => {
    const runtime = createFakeFeishuRuntime();
    const config = await createFeishuConfig();
    const provider = new FeishuProviderAdapter("feishu", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "oc_123", metadata: {} })).toMatchObject({
      channelId: "lark:oc_123:",
    });
    expect(
      provider.normalizeTarget({ id: "oc_123", metadata: {}, threadId: "om_root" }),
    ).toMatchObject({
      threadId: "lark:oc_123:om_root",
    });
  });

  it("probes, sends, and records inbound events", async () => {
    const runtime = createFakeFeishuRuntime();
    const config = await createFeishuConfig();
    const provider = new FeishuProviderAdapter("feishu", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("websocket transport enabled");

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });
    expect(result.threadId).toBe("lark:oc_123:");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith("lark:oc_123:", "hello");
    expect(runtime.subscriptions.has("lark:oc_123:")).toBe(true);

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "lark:oc_123:",
      timeoutMs: 500,
    });

    await runtime.emitInbound({
      id: "evt-1",
      text: "ACK nonce-2",
      threadId: "lark:oc_123:",
    });

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-1",
      text: "ACK nonce-2",
    });
  });

  it("opens DMs when the target is a user id", async () => {
    const runtime = createFakeFeishuRuntime();
    const config = await createFeishuConfig();
    const provider = new FeishuProviderAdapter("feishu", config, "crabline", runtime.runtime);
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: { id: "ou_123", metadata: {} },
      },
      mode: "roundtrip",
      nonce: "nonce-dm",
      text: "hello dm",
    });

    expect(result.threadId).toBe("lark:ou_123:");
    expect(runtime.adapter.openDM).toHaveBeenCalledWith("ou_123");
  });
});
