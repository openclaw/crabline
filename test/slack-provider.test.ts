import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackProviderAdapter } from "../src/providers/builtin/slack.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type FakeInboundPayload = {
  authorIsBot?: boolean;
  id: string;
  text: string;
  threadId: string;
};

const directories: string[] = [];
const providers: SlackProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createSlackConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "slack",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "slack",
    slack: {
      recorder: { path: path.join(directory, "slack.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/slack/events",
        port,
      },
    },
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

function createFakeSlackRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
    fetchChannelInfo: vi.fn(async (channelId: string) => ({ id: channelId })),
    openDM: vi.fn(async (userId: string) => `slack:D${userId.slice(1)}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "sent-1",
      raw: {},
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
    webhooks: {
      slack: vi.fn(async (request: Request) => {
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

type FakeMessage = {
  author: { isBot: boolean };
  id: string;
  metadata: { dateSent: Date };
  raw: Record<string, never>;
  text: string;
  threadId: string;
};

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
      id: "slack-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "slack-native",
      retries: 0,
      tags: [],
      target: {
        channelId: "C1234567890",
        id: "C1234567890",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "slack-native",
    userName: "crabline",
  };
}

describe("slack provider", () => {
  it("normalizes channel, thread, and DM targets", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(
      provider.normalizeTarget({
        channelId: "C1234567890",
        id: "C1234567890",
        metadata: {},
      }),
    ).toMatchObject({ channelId: "slack:C1234567890" });
    expect(
      provider.normalizeTarget({
        channelId: "slack:C1234567890",
        id: "reply-target",
        metadata: {},
        threadId: "1712345678.000100",
      }),
    ).toMatchObject({
      channelId: "slack:C1234567890",
      threadId: "slack:C1234567890:1712345678.000100",
    });
    expect(
      provider.normalizeTarget({
        id: "U1234567890",
        metadata: {},
      }),
    ).toMatchObject({ id: "U1234567890" });
  });

  it("rejects thread targets without a channel id", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(() =>
      provider.normalizeTarget({
        id: "reply-target",
        metadata: {},
        threadId: "1712345678.000100",
      }),
    ).toThrow(/requires channelId/);
  });

  it("probes native slack configuration", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    const result = await provider.probe(createContext(config));
    expect(result.healthy).toBe(true);
    expect(result.details.join("\n")).toContain("webhook endpoint http://127.0.0.1:");
    expect(runtime.adapter.fetchChannelInfo).toHaveBeenCalledWith("slack:C1234567890");
  });

  it("probes DM targets and reports the public webhook", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    config.slack!.webhook.publicUrl = "https://example.ngrok.app/slack/events";
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    const result = await provider.probe({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: {
          id: "U1234567890",
          metadata: {},
        },
      },
    });

    expect(result.details.join("\n")).toContain(
      "public webhook https://example.ngrok.app/slack/events",
    );
    expect(runtime.adapter.openDM).toHaveBeenCalledWith("U1234567890");
  });

  it("sends to a slack channel and subscribes to the thread", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });

    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("slack:C1234567890");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith("slack:C1234567890", "hello");
    expect(runtime.subscriptions.has("slack:C1234567890")).toBe(true);
  });

  it("records webhook inbound events and waits for them", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    await provider.probe(createContext(config));

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "slack:C1234567890",
      timeoutMs: 500,
    });

    const endpoint = (await provider.probe(createContext(config))).details.find((detail) =>
      detail.startsWith("webhook endpoint "),
    );
    expect(endpoint).toBeDefined();

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        kind: "subscribed",
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "slack:C1234567890",
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

  it("streams webhook-backed watch events", async () => {
    const runtime = createFakeSlackRuntime();
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const watchStream = provider.watch({
      ...createContext(config),
      since: new Date(Date.now() - 1000).toISOString(),
    });
    const iterator = watchStream[Symbol.asyncIterator]();

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        kind: "message",
        message: {
          authorIsBot: false,
          id: "evt-2",
          text: "user message",
          threadId: "slack:C1234567890",
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

  it("maps Slack auth failures to auth errors", async () => {
    const runtime = createFakeSlackRuntime();
    runtime.adapter.fetchChannelInfo.mockRejectedValueOnce(new Error("invalid_auth"));
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack-native", config, "crabline", runtime.runtime);
    providers.push(provider);

    await expect(provider.probe(createContext(config))).rejects.toMatchObject({ kind: "auth" });
  });

  it("reuses an existing webhook listener during probe", async () => {
    const primaryRuntime = createFakeSlackRuntime();
    const config = await createSlackConfig(await resolveFreePort());
    const primary = new SlackProviderAdapter(
      "slack-primary",
      { ...config, slack: { ...config.slack!, recorder: { path: config.slack!.recorder.path } } },
      "crabline",
      primaryRuntime.runtime,
    );
    providers.push(primary);

    const secondaryRuntime = createFakeSlackRuntime();
    const secondary = new SlackProviderAdapter(
      "slack-secondary",
      {
        ...config,
        slack: {
          ...config.slack!,
          recorder: {
            path: config.slack!.recorder.path?.replace("slack.jsonl", "slack-secondary.jsonl"),
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
        slack: {
          ...config.slack!,
          recorder: {
            path: config.slack!.recorder.path?.replace("slack.jsonl", "slack-secondary.jsonl"),
          },
        },
      }),
    );

    expect(primaryProbe.healthy).toBe(true);
    expect(secondaryProbe.healthy).toBe(true);
  });
});
