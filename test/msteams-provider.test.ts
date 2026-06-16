import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MsTeamsProviderAdapter,
  resolveMsTeamsAdapterConfig,
} from "../src/providers/builtin/msteams.js";
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
const providers: MsTeamsProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function encodeTeamsThreadId(conversationId: string, serviceUrl: string): string {
  return `teams:${base64Url(conversationId)}:${base64Url(serviceUrl)}`;
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

async function createMsTeamsConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "msteams",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    msteams: {
      appId: "teams-app",
      appPassword: "teams-secret",
      recorder: { path: path.join(directory, "msteams.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/msteams/webhook",
        port,
      },
    },
    platform: "msteams",
    status: "active",
  };
}

function createFakeMsTeamsRuntime() {
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
    openDM: vi.fn(async (userId: string) => `teams:dm:${userId}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "teams-sent",
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
      id: "msteams-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "msteams",
      retries: 0,
      tags: [],
      target: {
        id: "19:conversation@thread.v2",
        metadata: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "msteams",
    userName: "crabline",
  };
}

describe("msteams provider", () => {
  it("resolves adapter config from provider settings and env", () => {
    expect(
      resolveMsTeamsAdapterConfig(
        {
          adapter: "msteams",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          msteams: {
            appId: "config-app",
            appPassword: "config-secret",
            recorder: {},
            webhook: { host: "127.0.0.1", path: "/msteams/webhook", port: 8791 },
          },
          platform: "msteams",
          status: "active",
        },
        {
          TEAMS_API_URL: "https://teams.example.com",
          TEAMS_APP_TYPE: "MultiTenant",
          TEAMS_BOT_USERNAME: "crabline_teams",
        },
      ),
    ).toMatchObject({
      apiUrl: "https://teams.example.com",
      appId: "config-app",
      appPassword: "config-secret",
      appType: "MultiTenant",
      userName: "crabline_teams",
    });
  });

  it("validates required adapter auth config", () => {
    const baseConfig: ProviderConfig = {
      adapter: "msteams",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      msteams: {
        recorder: {},
        webhook: { host: "127.0.0.1", path: "/msteams/webhook", port: 8791 },
      },
      platform: "msteams",
      status: "active",
    };

    expect(() => resolveMsTeamsAdapterConfig(baseConfig, {})).toThrow(/app id is required/u);
    expect(() =>
      resolveMsTeamsAdapterConfig(
        {
          ...baseConfig,
          msteams: {
            ...baseConfig.msteams!,
            appId: "teams-app",
            appPassword: "teams-secret",
            appType: "SingleTenant",
          },
        },
        {},
      ),
    ).toThrow(/single-tenant apps require/u);
  });

  it("supports federated adapter auth config", () => {
    expect(
      resolveMsTeamsAdapterConfig(
        {
          adapter: "msteams",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          msteams: {
            appId: "teams-app",
            recorder: {},
            webhook: { host: "127.0.0.1", path: "/msteams/webhook", port: 8791 },
          },
          platform: "msteams",
          status: "active",
        },
        {
          TEAMS_FEDERATED_CLIENT_AUDIENCE: "api://AzureADTokenExchange",
          TEAMS_FEDERATED_CLIENT_ID: "client-id",
        },
      ),
    ).toMatchObject({
      federated: {
        clientAudience: "api://AzureADTokenExchange",
        clientId: "client-id",
      },
    });
  });

  it("normalizes raw Teams conversation IDs into Chat SDK thread IDs", async () => {
    const runtime = createFakeMsTeamsRuntime();
    const config = await createMsTeamsConfig(0);
    const provider = new MsTeamsProviderAdapter("msteams", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(
      provider.normalizeTarget({
        id: "19:conversation@thread.v2",
        metadata: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
      }),
    ).toMatchObject({
      channelId: encodeTeamsThreadId(
        "19:conversation@thread.v2",
        "https://smba.trafficmanager.net/amer/",
      ),
    });
    expect(
      provider.normalizeTarget({
        id: "19:conversation@thread.v2",
        metadata: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
        threadId: "1710000000000",
      }),
    ).toMatchObject({
      threadId: encodeTeamsThreadId(
        "19:conversation@thread.v2;messageid=1710000000000",
        "https://smba.trafficmanager.net/amer/",
      ),
    });

    const sendResult = await provider.send({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: {
          id: "19:conversation@thread.v2",
          metadata: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
          threadId: "1710000000000",
        },
      },
      mode: "roundtrip",
      nonce: "nonce-thread",
      text: "hello thread",
    });
    expect(sendResult.threadId).toBe(
      encodeTeamsThreadId(
        "19:conversation@thread.v2;messageid=1710000000000",
        "https://smba.trafficmanager.net/amer/",
      ),
    );
  });

  it("probes and sends through the provider adapter", async () => {
    const runtime = createFakeMsTeamsRuntime();
    const config = await createMsTeamsConfig(0);
    const provider = new MsTeamsProviderAdapter("msteams", config, "crabline", runtime.runtime);
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

    const threadId = encodeTeamsThreadId(
      "19:conversation@thread.v2",
      "https://smba.trafficmanager.net/amer/",
    );
    expect(result.threadId).toBe(threadId);
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith(threadId, "hello");
    expect(runtime.subscriptions.has(threadId)).toBe(true);
  });

  it("opens DMs when the target is not a conversation id", async () => {
    const runtime = createFakeMsTeamsRuntime();
    const config = await createMsTeamsConfig(0);
    const provider = new MsTeamsProviderAdapter("msteams", config, "crabline", runtime.runtime);
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: { id: "user-123", metadata: {} },
      },
      mode: "roundtrip",
      nonce: "nonce-dm",
      text: "hello dm",
    });

    expect(result.threadId).toBe("teams:dm:user-123");
    expect(runtime.adapter.openDM).toHaveBeenCalledWith("user-123");
  });

  it("reports the configured webhook endpoint when its port is already in use", async () => {
    const occupied = await occupyPort();
    try {
      const runtime = createFakeMsTeamsRuntime();
      const config = await createMsTeamsConfig(occupied.port);
      config.msteams!.webhook.publicUrl = "https://example.com/msteams/webhook";
      const provider = new MsTeamsProviderAdapter("msteams", config, "crabline", runtime.runtime);
      providers.push(provider);

      const probe = await provider.probe(createContext(config));

      expect(probe).toMatchObject({ healthy: true });
      expect(probe.details).toContain(
        `webhook endpoint http://127.0.0.1:${occupied.port}/msteams/webhook`,
      );
      expect(probe.details).toContain("public webhook https://example.com/msteams/webhook");
    } finally {
      await occupied.close();
    }
  });

  it("records webhook inbound events", async () => {
    const runtime = createFakeMsTeamsRuntime();
    const config = await createMsTeamsConfig(0);
    const provider = new MsTeamsProviderAdapter("msteams", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const threadId = encodeTeamsThreadId(
      "19:conversation@thread.v2",
      "https://smba.trafficmanager.net/amer/",
    );
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
});
