import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordProviderAdapter } from "../src/providers/builtin/discord.js";
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
const providers: DiscordProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createDiscordConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "discord",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    discord: {
      applicationId: "123456789012345678",
      botToken: "discord-token",
      gatewayDurationMs: 60_000,
      publicKey: "a".repeat(64),
      recorder: { path: path.join(directory, "discord.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/discord/interactions",
        port,
      },
    },
    env: [],
    platform: "discord",
    status: "active",
  };
}

async function resolveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve free port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function createFakeDiscordRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
    fetchChannelInfo: vi.fn(async (channelId: string) => ({ id: channelId })),
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
    openDM: vi.fn(async (userId: string) => `discord:@me:dm-${userId}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "discord-sent",
      threadId,
    })),
    startGatewayListener: vi.fn(
      async (
        options: { waitUntil(task: Promise<unknown>): void },
        _durationMs?: number,
        abortSignal?: AbortSignal,
        _webhookUrl?: string,
      ) => {
        const gatewayTask = new Promise<void>((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        options.waitUntil(gatewayTask);
        return new Response(JSON.stringify({ status: "listening" }), { status: 200 });
      },
    ),
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
      id: "discord-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "discord-native",
      retries: 0,
      tags: [],
      target: {
        id: "123456789012345678",
        metadata: { guildId: "987654321098765432" },
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "discord-native",
    userName: "crabline",
  };
}

describe("discord provider", () => {
  it("normalizes channel, thread, encoded, and DM targets", async () => {
    const runtime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    expect(
      provider.normalizeTarget({
        id: "123456789012345678",
        metadata: { guildId: "987654321098765432" },
      }),
    ).toMatchObject({
      channelId: "discord:987654321098765432:123456789012345678",
    });
    expect(
      provider.normalizeTarget({
        channelId: "123456789012345678",
        id: "reply-target",
        metadata: { guildId: "987654321098765432" },
        threadId: "223456789012345678",
      }),
    ).toMatchObject({
      channelId: "discord:987654321098765432:123456789012345678",
      threadId: "discord:987654321098765432:123456789012345678:223456789012345678",
    });
    expect(
      provider.normalizeTarget({
        id: "discord:987654321098765432:123456789012345678:223456789012345678",
        metadata: {},
      }),
    ).toMatchObject({
      channelId: "discord:987654321098765432:123456789012345678",
      threadId: "discord:987654321098765432:123456789012345678:223456789012345678",
    });
    expect(provider.normalizeTarget({ id: "555555555555555555", metadata: {} })).toMatchObject({
      id: "555555555555555555",
    });
  });

  it("rejects thread targets without guild metadata", async () => {
    const runtime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    expect(() =>
      provider.normalizeTarget({
        id: "123456789012345678",
        metadata: {},
        threadId: "223456789012345678",
      }),
    ).toThrow(/requires target.metadata.guildId/u);
  });

  it("probes native discord configuration and DM targets", async () => {
    const runtime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(0);
    config.discord!.webhook.publicUrl = "https://example.ngrok.app/discord/interactions";
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const result = await provider.probe(createContext(config));
    expect(result.healthy).toBe(true);
    expect(result.details.join("\n")).toContain("interactions endpoint http://127.0.0.1:");
    expect(result.details.join("\n")).toContain(
      "public webhook https://example.ngrok.app/discord/interactions",
    );
    expect(runtime.adapter.fetchChannelInfo).toHaveBeenCalledWith(
      "discord:987654321098765432:123456789012345678",
    );

    const dmResult = await provider.probe({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: {
          id: "555555555555555555",
          metadata: {},
        },
      },
    });
    expect(dmResult.details.join("\n")).toContain("dm reachable discord:@me:dm-555555555555555555");
    expect(runtime.adapter.openDM).toHaveBeenCalledWith("555555555555555555");
  });

  it("sends to a discord channel and subscribes to the thread", async () => {
    const runtime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });

    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("discord:987654321098765432:123456789012345678");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith(
      "discord:987654321098765432:123456789012345678",
      "hello",
    );
    expect(runtime.subscriptions.has("discord:987654321098765432:123456789012345678")).toBe(true);
  });

  it("records webhook inbound events and waits for them", async () => {
    const runtime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(0);
    config.discord!.webhook.publicUrl = "https://example.ngrok.app/discord/interactions";
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("interactions endpoint "));
    expect(endpoint).toBeDefined();

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "discord:987654321098765432:123456789012345678",
      timeoutMs: 500,
    });

    await fetch(endpoint!.replace("interactions endpoint ", ""), {
      body: JSON.stringify({
        kind: "subscribed",
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "discord:987654321098765432:123456789012345678",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-1",
      text: "ACK nonce-2",
    });
    expect(runtime.adapter.startGatewayListener).toHaveBeenCalledTimes(1);
    expect(runtime.adapter.startGatewayListener.mock.calls[0]?.[3]).toBe(
      "https://example.ngrok.app/discord/interactions",
    );
  });

  it("streams gateway-backed watch events", async () => {
    const runtime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("interactions endpoint "));
    expect(endpoint).toBeDefined();

    const watchStream = provider.watch({
      ...createContext(config),
      since: new Date(Date.now() - 1000).toISOString(),
    });
    const iterator = watchStream[Symbol.asyncIterator]();

    await fetch(endpoint!.replace("interactions endpoint ", ""), {
      body: JSON.stringify({
        kind: "message",
        message: {
          authorIsBot: false,
          id: "evt-2",
          text: "user message",
          threadId: "discord:987654321098765432:123456789012345678",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.author).toBe("user");
    expect(next.value?.id).toBe("evt-2");
  });

  it("maps Discord auth failures and gateway failures", async () => {
    const runtime = createFakeDiscordRuntime();
    runtime.adapter.fetchChannelInfo.mockRejectedValueOnce(new Error("401 unauthorized"));
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter(
      "discord-native",
      config,
      "crabline",
      runtime.runtime,
    );
    providers.push(provider);

    await expect(provider.probe(createContext(config))).rejects.toMatchObject({ kind: "auth" });

    runtime.adapter.startGatewayListener.mockResolvedValueOnce(
      new Response("gateway offline", { status: 503 }),
    );

    await expect(
      provider.waitForInbound({
        ...createContext(config),
        nonce: "nonce-3",
        since: new Date(Date.now() - 1000).toISOString(),
        threadId: "discord:987654321098765432:123456789012345678",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ kind: "connectivity" });
  });

  it("reuses an existing interactions listener during probe", async () => {
    const primaryRuntime = createFakeDiscordRuntime();
    const config = await createDiscordConfig(await resolveFreePort());
    const primary = new DiscordProviderAdapter(
      "discord-primary",
      {
        ...config,
        discord: { ...config.discord!, recorder: { path: config.discord!.recorder.path } },
      },
      "crabline",
      primaryRuntime.runtime,
    );
    providers.push(primary);

    const secondaryRuntime = createFakeDiscordRuntime();
    const secondary = new DiscordProviderAdapter(
      "discord-secondary",
      {
        ...config,
        discord: {
          ...config.discord!,
          recorder: {
            path: config.discord!.recorder.path?.replace(
              "discord.jsonl",
              "discord-secondary.jsonl",
            ),
          },
        },
      },
      "crabline",
      secondaryRuntime.runtime,
    );
    providers.push(secondary);

    const primaryProbe = await primary.probe(createContext(config));
    const secondaryProbe = await secondary.probe(
      createContext({
        ...config,
        discord: {
          ...config.discord!,
          recorder: {
            path: config.discord!.recorder.path?.replace(
              "discord.jsonl",
              "discord-secondary.jsonl",
            ),
          },
        },
      }),
    );

    expect(primaryProbe.healthy).toBe(true);
    expect(secondaryProbe.healthy).toBe(true);
  });
});
