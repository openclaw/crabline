import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MattermostProviderAdapter,
  resolveMattermostAdapterConfig,
} from "../src/providers/builtin/mattermost.js";
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
const providers: MattermostProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function createMattermostConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "mattermost",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    mattermost: {
      baseUrl: "https://mattermost.example.com",
      botToken: "mattermost-token",
      recorder: { path: path.join(directory, "mattermost.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/mattermost/webhook",
        port,
      },
    },
    platform: "mattermost",
    status: "active",
  };
}

function createFakeMattermostRuntime() {
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
    openDM: vi.fn(async (userId: string) => `mattermost:dm:${userId}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "mattermost-sent",
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
      id: "mattermost-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "mattermost",
      retries: 0,
      tags: [],
      target: {
        id: "channel-id",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "mattermost",
    userName: "crabline",
  };
}

describe("mattermost provider", () => {
  it("resolves adapter config from provider settings and webhook public URL", () => {
    expect(
      resolveMattermostAdapterConfig(
        {
          adapter: "mattermost",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          mattermost: {
            baseUrl: "https://mattermost.example.com",
            botToken: "config-token",
            recorder: {},
            userName: "crabline_mm",
            webhook: {
              host: "127.0.0.1",
              path: "/mattermost/webhook",
              port: 8793,
              publicUrl: "https://example.com/mattermost/webhook",
            },
            websocket: { enabled: false },
          },
          platform: "mattermost",
          status: "active",
        },
        {},
      ),
    ).toMatchObject({
      baseUrl: "https://mattermost.example.com",
      botToken: "config-token",
      callbackUrl: "https://example.com/mattermost/webhook",
      userName: "crabline_mm",
      websocket: { enabled: false },
    });
  });

  it("validates required adapter config", () => {
    const config: ProviderConfig = {
      adapter: "mattermost",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      mattermost: {
        recorder: {},
        webhook: { host: "127.0.0.1", path: "/mattermost/webhook", port: 8793 },
      },
      platform: "mattermost",
      status: "active",
    };

    expect(() => resolveMattermostAdapterConfig(config, {})).toThrow(/base URL is required/u);
    expect(() =>
      resolveMattermostAdapterConfig(
        { ...config, mattermost: { ...config.mattermost!, baseUrl: "https://example.com" } },
        {},
      ),
    ).toThrow(/bot token is required/u);
  });

  it("normalizes raw Mattermost IDs into Chat SDK thread IDs", async () => {
    const runtime = createFakeMattermostRuntime();
    const config = await createMattermostConfig(0);
    const provider = new MattermostProviderAdapter(
      "mattermost",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "channel-id", metadata: {} })).toMatchObject({
      channelId: `mattermost:${base64Url("channel-id")}`,
    });
    expect(
      provider.normalizeTarget({ id: "channel-id", metadata: {}, threadId: "root-post" }),
    ).toMatchObject({
      threadId: `mattermost:${base64Url("channel-id")}:${base64Url("root-post")}`,
    });
  });

  it("probes, sends, and records webhook inbound events", async () => {
    const runtime = createFakeMattermostRuntime();
    const config = await createMattermostConfig(0);
    const provider = new MattermostProviderAdapter(
      "mattermost",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("webhook endpoint http://127.0.0.1:");

    const threadId = `mattermost:${base64Url("channel-id")}`;
    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });
    expect(result.threadId).toBe(threadId);
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith(threadId, "hello");
    expect(runtime.subscriptions.has(threadId)).toBe(true);

    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId,
      timeoutMs: 500,
    });

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId,
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

  it("opens DMs when the target is marked as a user", async () => {
    const runtime = createFakeMattermostRuntime();
    const config = await createMattermostConfig(0);
    const provider = new MattermostProviderAdapter(
      "mattermost",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: { id: "user-id", metadata: { targetType: "user" } },
      },
      mode: "roundtrip",
      nonce: "nonce-dm",
      text: "hello dm",
    });

    expect(result.threadId).toBe("mattermost:dm:user-id");
    expect(runtime.adapter.openDM).toHaveBeenCalledWith("user-id");
  });
});
