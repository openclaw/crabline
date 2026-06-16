import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GoogleChatProviderAdapter,
  resolveGoogleChatAdapterConfig,
} from "../src/providers/builtin/googlechat.js";
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
const providers: GoogleChatProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function occupyPort(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    port: address.port,
  };
}

async function createGoogleChatConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "googlechat",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    googlechat: {
      credentials: {
        client_email: "bot@example.iam.gserviceaccount.com",
        private_key: "private-key",
      },
      disableSignatureVerification: true,
      recorder: { path: path.join(directory, "googlechat.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/googlechat/webhook",
        port,
      },
    },
    platform: "googlechat",
    status: "active",
  };
}

function createFakeGoogleChatRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
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
    openDM: vi.fn(async (userId: string) => `gchat:${userId}:dm`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "googlechat-sent",
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
      id: "googlechat-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "googlechat",
      retries: 0,
      tags: [],
      target: {
        id: "spaces/AAAA1234567",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "googlechat",
    userName: "crabline",
  };
}

describe("googlechat provider", () => {
  it("resolves adapter config from provider settings and env", () => {
    expect(
      resolveGoogleChatAdapterConfig(
        {
          adapter: "googlechat",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          googlechat: {
            credentials: {
              client_email: "config@example.iam.gserviceaccount.com",
              private_key: "private-key",
            },
            disableSignatureVerification: true,
            recorder: {},
            webhook: {
              host: "127.0.0.1",
              path: "/googlechat/webhook",
              port: 8792,
              publicUrl: "https://example.com/googlechat/webhook",
            },
          },
          platform: "googlechat",
          status: "active",
        },
        {
          GOOGLE_CHAT_BOT_USERNAME: "crabline_gchat",
          GOOGLE_CHAT_PUBSUB_TOPIC: "projects/test/topics/chat",
        },
      ),
    ).toMatchObject({
      credentials: {
        client_email: "config@example.iam.gserviceaccount.com",
      },
      disableSignatureVerification: true,
      endpointUrl: "https://example.com/googlechat/webhook",
      pubsubTopic: "projects/test/topics/chat",
      userName: "crabline_gchat",
    });
  });

  it("parses credentials JSON from env", () => {
    expect(
      resolveGoogleChatAdapterConfig(
        {
          adapter: "googlechat",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          googlechat: {
            googleChatProjectNumber: "1234567890",
            recorder: {},
            webhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
          },
          platform: "googlechat",
          status: "active",
        },
        {
          GOOGLE_CHAT_CREDENTIALS: JSON.stringify({
            client_email: "env@example.iam.gserviceaccount.com",
            private_key: "private-key",
          }),
        },
      ),
    ).toMatchObject({
      credentials: {
        client_email: "env@example.iam.gserviceaccount.com",
      },
      googleChatProjectNumber: "1234567890",
    });
  });

  it("validates adapter auth and webhook verification config", () => {
    const baseConfig: ProviderConfig = {
      adapter: "googlechat",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      googlechat: {
        recorder: {},
        webhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
      },
      platform: "googlechat",
      status: "active",
    };

    expect(() => resolveGoogleChatAdapterConfig(baseConfig, {})).toThrow(
      /credentials are required/u,
    );
    expect(() =>
      resolveGoogleChatAdapterConfig(
        {
          ...baseConfig,
          googlechat: {
            ...baseConfig.googlechat!,
            credentials: {
              client_email: "config@example.iam.gserviceaccount.com",
              private_key: "private-key",
            },
          },
        },
        {},
      ),
    ).toThrow(/webhook verification is required/u);
    expect(() =>
      resolveGoogleChatAdapterConfig(baseConfig, {
        GOOGLE_CHAT_CREDENTIALS: "{bad-json",
      }),
    ).toThrow(/valid JSON/u);
    expect(() =>
      resolveGoogleChatAdapterConfig(baseConfig, {
        GOOGLE_CHAT_CREDENTIALS: JSON.stringify({ client_email: "missing-private-key" }),
      }),
    ).toThrow(/client_email and private_key/u);
  });

  it("supports Application Default Credentials from env", () => {
    expect(
      resolveGoogleChatAdapterConfig(
        {
          adapter: "googlechat",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          googlechat: {
            recorder: {},
            webhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
          },
          platform: "googlechat",
          status: "active",
        },
        {
          GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION: "true",
          GOOGLE_CHAT_USE_ADC: "true",
        },
      ),
    ).toMatchObject({
      disableSignatureVerification: true,
      useApplicationDefaultCredentials: true,
    });
  });

  it("normalizes raw Google Chat IDs into Chat SDK thread IDs", async () => {
    const runtime = createFakeGoogleChatRuntime();
    const config = await createGoogleChatConfig(0);
    const provider = new GoogleChatProviderAdapter(
      "googlechat",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "spaces/AAAA1234567", metadata: {} })).toMatchObject({
      channelId: "gchat:spaces/AAAA1234567",
    });
    expect(
      provider.normalizeTarget({
        id: "spaces/AAAA1234567",
        metadata: {},
        threadId: "spaces/AAAA1234567/threads/thread-1",
      }),
    ).toMatchObject({
      threadId: `gchat:spaces/AAAA1234567:${base64Url("spaces/AAAA1234567/threads/thread-1")}`,
    });

    const sendResult = await provider.send({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: {
          id: "spaces/AAAA1234567",
          metadata: {},
          threadId: "spaces/AAAA1234567/threads/thread-1",
        },
      },
      mode: "roundtrip",
      nonce: "nonce-thread",
      text: "hello thread",
    });
    expect(sendResult.threadId).toBe(
      `gchat:spaces/AAAA1234567:${base64Url("spaces/AAAA1234567/threads/thread-1")}`,
    );
  });

  it("probes and sends through the provider adapter", async () => {
    const runtime = createFakeGoogleChatRuntime();
    const config = await createGoogleChatConfig(0);
    const provider = new GoogleChatProviderAdapter(
      "googlechat",
      config,
      "crabline",
      runtime.runtime,
    );
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

    expect(result.threadId).toBe("gchat:spaces/AAAA1234567");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith("gchat:spaces/AAAA1234567", "hello");
    expect(runtime.subscriptions.has("gchat:spaces/AAAA1234567")).toBe(true);
  });

  it("opens DMs when the target is not a space id", async () => {
    const runtime = createFakeGoogleChatRuntime();
    const config = await createGoogleChatConfig(0);
    const provider = new GoogleChatProviderAdapter(
      "googlechat",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: { id: "users/1234567890", metadata: {} },
      },
      mode: "roundtrip",
      nonce: "nonce-dm",
      text: "hello dm",
    });

    expect(result.threadId).toBe("gchat:users/1234567890:dm");
    expect(runtime.adapter.openDM).toHaveBeenCalledWith("users/1234567890");
  });

  it("reports the configured webhook endpoint when its port is already in use", async () => {
    const occupied = await occupyPort();
    try {
      const runtime = createFakeGoogleChatRuntime();
      const config = await createGoogleChatConfig(occupied.port);
      config.googlechat!.webhook.publicUrl = "https://example.com/googlechat/webhook";
      const provider = new GoogleChatProviderAdapter(
        "googlechat",
        config,
        "crabline",
        runtime.runtime,
      );
      providers.push(provider);

      const probe = await provider.probe(createContext(config));

      expect(probe).toMatchObject({ healthy: true });
      expect(probe.details).toContain(
        `webhook endpoint http://127.0.0.1:${occupied.port}/googlechat/webhook`,
      );
      expect(probe.details).toContain("public webhook https://example.com/googlechat/webhook");
    } finally {
      await occupied.close();
    }
  });

  it("records webhook inbound events", async () => {
    const runtime = createFakeGoogleChatRuntime();
    const config = await createGoogleChatConfig(0);
    const provider = new GoogleChatProviderAdapter(
      "googlechat",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "gchat:spaces/AAAA1234567",
      timeoutMs: 500,
    });

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "gchat:spaces/AAAA1234567",
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
