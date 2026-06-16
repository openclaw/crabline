import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMessageProviderAdapter } from "../src/providers/builtin/imessage.js";
import type { ProviderConfig } from "../src/config/schema.js";
import { readRecordedInbound } from "../src/providers/recorder.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type FakeIMessageMessage = {
  author: { isBot: boolean };
  id: string;
  metadata: { dateSent: Date };
  raw?: unknown;
  text: string;
  threadId: string;
};

const directories: string[] = [];
const providers: IMessageProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createIMessageConfig(): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "imessage",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    imessage: {
      gatewayDurationMs: 60_000,
      local: true,
      recorder: { path: path.join(directory, "imessage.jsonl") },
    },
    platform: "imessage",
    status: "active",
  };
}

function createIMessageContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "imessage-fixture",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "imessage",
      retries: 0,
      tags: [],
      target: { id: "chat-guid", metadata: {} },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "imessage",
    userName: "crabline",
  };
}

function createIMessageRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeIMessageMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];

  let gatewayTask: Promise<unknown> | null = null;

  const adapter = {
    fetchThread: vi.fn(async (_threadId: string) => ({ ok: true })),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "imessage-sent",
      threadId,
    })),
    startGatewayListener: vi.fn(
      async (
        options: { waitUntil(task: Promise<unknown>): void },
        _durationMs?: number,
        abortSignal?: AbortSignal,
      ) => {
        gatewayTask = new Promise<void>((resolve) => {
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
        subscribe: vi.fn(async (_threadId: string) => {}),
      };
    },
    initialize: vi.fn(async () => {}),
    onDirectMessage(
      handler: (thread: { id: string }, message: FakeIMessageMessage) => Promise<void> | void,
    ) {
      directHandlers.push(handler);
    },
    onNewMention(
      handler: (thread: { id: string }, message: FakeIMessageMessage) => Promise<void> | void,
    ) {
      mentionHandlers.push(handler);
    },
    onNewMessage(
      _pattern: RegExp,
      handler: (thread: { id: string }, message: FakeIMessageMessage) => Promise<void> | void,
    ) {
      messageHandlers.push(handler);
    },
    onSubscribedMessage(
      handler: (thread: { id: string }, message: FakeIMessageMessage) => Promise<void> | void,
    ) {
      subscribedHandlers.push(handler);
    },
  };

  const emit = async (message: FakeIMessageMessage) => {
    const thread = { id: message.threadId };
    for (const handler of subscribedHandlers) {
      await handler(thread, message);
    }
  };

  return {
    adapter,
    emit,
    runtime: {
      createAdapter: () => adapter,
      createChat: () => chat,
    },
  };
}

describe("imessage provider", () => {
  it("normalizes targets and probes threads", async () => {
    const config = await createIMessageConfig();
    const runtime = createIMessageRuntime();
    const provider = new IMessageProviderAdapter("imessage", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "chat-guid", metadata: {} })).toMatchObject({
      threadId: "imessage:chat-guid",
    });
    await expect(provider.probe(createIMessageContext(config))).resolves.toMatchObject({
      healthy: true,
    });
  });

  it("sends and waits through the gateway-backed recorder flow", async () => {
    const config = await createIMessageConfig();
    const runtime = createIMessageRuntime();
    const provider = new IMessageProviderAdapter("imessage", config, "crabline", runtime.runtime);
    providers.push(provider);
    const context = createIMessageContext(config);

    await expect(
      provider.send({
        ...context,
        mode: "agent",
        nonce: "nonce-1",
        text: "hello",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      threadId: "imessage:chat-guid",
    });

    const waitPromise = provider.waitForInbound({
      ...context,
      nonce: "nonce-1",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "imessage:chat-guid",
      timeoutMs: 500,
    });

    await runtime.emit({
      author: { isBot: true },
      id: "imessage-inbound",
      metadata: { dateSent: new Date() },
      text: "ACK nonce-1",
      threadId: "imessage:chat-guid",
    });

    await expect(waitPromise).resolves.toMatchObject({ id: "imessage-inbound" });
    expect(runtime.adapter.startGatewayListener).toHaveBeenCalledTimes(1);
  });

  it("classifies auth failures during probe", async () => {
    const config = await createIMessageConfig();
    const runtime = createIMessageRuntime();
    runtime.adapter.fetchThread.mockRejectedValueOnce(new Error("401 api key rejected"));
    const provider = new IMessageProviderAdapter("imessage", config, "crabline", runtime.runtime);
    providers.push(provider);

    await expect(provider.probe(createIMessageContext(config))).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("surfaces gateway listener failures", async () => {
    const config = await createIMessageConfig();
    const runtime = createIMessageRuntime();
    runtime.adapter.startGatewayListener.mockResolvedValueOnce(
      new Response("backend offline", { status: 503 }),
    );
    const provider = new IMessageProviderAdapter("imessage", config, "crabline", runtime.runtime);
    providers.push(provider);
    const context = createIMessageContext(config);

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce-1",
        since: new Date(Date.now() - 1000).toISOString(),
        threadId: "imessage:chat-guid",
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ kind: "connectivity" });
  });

  it("records inbound once and exposes it through watch", async () => {
    const config = await createIMessageConfig();
    const runtime = createIMessageRuntime();
    const provider = new IMessageProviderAdapter("imessage", config, "crabline", runtime.runtime);
    providers.push(provider);
    const context = createIMessageContext(config);
    const stream = provider.watch({
      ...context,
      since: new Date(Date.now() - 1000).toISOString(),
    });
    const iterator = stream[Symbol.asyncIterator]();

    const firstEvent = iterator.next();
    await runtime.emit({
      author: { isBot: true },
      id: "imessage-watch",
      metadata: { dateSent: new Date() },
      text: "watch me",
      threadId: "imessage:chat-guid",
    });
    await runtime.emit({
      author: { isBot: true },
      id: "imessage-watch",
      metadata: { dateSent: new Date() },
      text: "watch me",
      threadId: "imessage:chat-guid",
    });

    await expect(firstEvent).resolves.toMatchObject({
      done: false,
      value: expect.objectContaining({ id: "imessage-watch" }),
    });

    const recorderPath = config.imessage?.recorder.path;
    expect(recorderPath).toBeDefined();
    const recorded = await readRecordedInbound(recorderPath!);
    expect(recorded.filter((event) => event.id === "imessage-watch")).toHaveLength(1);

    await iterator.return?.();
  });
});
