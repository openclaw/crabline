import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixProviderAdapter } from "../src/providers/builtin/matrix.js";
import type { ProviderConfig } from "../src/config/schema.js";
import { readRecordedInbound } from "../src/providers/recorder.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type FakeMatrixMessage = {
  author: { isBot: boolean };
  id: string;
  metadata: { dateSent: Date };
  raw?: unknown;
  text: string;
  threadId: string;
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createMatrixConfig(): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "matrix",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    matrix: {
      auth: {
        accessToken: "token",
        type: "accessToken",
      },
      baseURL: "https://matrix.example.com",
      recorder: { path: path.join(directory, "matrix.jsonl") },
    },
    platform: "matrix",
    status: "active",
  };
}

function createMatrixContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "matrix-fixture",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "matrix",
      retries: 0,
      tags: [],
      target: { id: "!room:example.com", metadata: {} },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "matrix",
    userName: "crabline",
  };
}

function createMatrixRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMatrixMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];

  const adapter = {
    fetchChannelInfo: vi.fn(async (_channelId: string) => ({ ok: true })),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "matrix-sent",
      threadId,
    })),
  };

  const chat = {
    getState() {
      return {
        subscribe: vi.fn(async (_threadId: string) => {}),
      };
    },
    initialize: vi.fn(async () => {}),
    onDirectMessage(
      handler: (thread: { id: string }, message: FakeMatrixMessage) => Promise<void> | void,
    ) {
      directHandlers.push(handler);
    },
    onNewMention(
      handler: (thread: { id: string }, message: FakeMatrixMessage) => Promise<void> | void,
    ) {
      mentionHandlers.push(handler);
    },
    onNewMessage(
      _pattern: RegExp,
      handler: (thread: { id: string }, message: FakeMatrixMessage) => Promise<void> | void,
    ) {
      messageHandlers.push(handler);
    },
    onSubscribedMessage(
      handler: (thread: { id: string }, message: FakeMatrixMessage) => Promise<void> | void,
    ) {
      subscribedHandlers.push(handler);
    },
  };

  const emit = async (message: FakeMatrixMessage, kind: "message" | "subscribed" = "message") => {
    const thread = { id: message.threadId };
    const handlers = kind === "message" ? messageHandlers : subscribedHandlers;
    for (const handler of handlers) {
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

describe("matrix provider", () => {
  it("normalizes room and thread targets", async () => {
    const config = await createMatrixConfig();
    const runtime = createMatrixRuntime();
    const provider = new MatrixProviderAdapter("matrix", config, "crabline", runtime.runtime);

    expect(provider.normalizeTarget({ id: "!room:example.com", metadata: {} })).toMatchObject({
      channelId: "matrix:!room%3Aexample.com",
    });
    expect(
      provider.normalizeTarget({
        channelId: "!room:example.com",
        id: "thread-target",
        metadata: {},
        threadId: "$event",
      }),
    ).toMatchObject({
      threadId: "matrix:!room%3Aexample.com:%24event",
    });
  });

  it("probes, sends, and waits for recorder-backed inbound", async () => {
    const config = await createMatrixConfig();
    const runtime = createMatrixRuntime();
    const provider = new MatrixProviderAdapter("matrix", config, "crabline", runtime.runtime);
    const context = createMatrixContext(config);

    await expect(provider.probe(context)).resolves.toMatchObject({ healthy: true });
    await expect(
      provider.send({
        ...context,
        mode: "roundtrip",
        nonce: "nonce-1",
        text: "hello",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      threadId: "matrix:!room%3Aexample.com",
    });

    const waitPromise = provider.waitForInbound({
      ...context,
      nonce: "nonce-1",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "matrix:!room%3Aexample.com",
      timeoutMs: 500,
    });

    await runtime.emit({
      author: { isBot: true },
      id: "matrix-inbound",
      metadata: { dateSent: new Date() },
      text: "ACK nonce-1",
      threadId: "matrix:!room%3Aexample.com",
    });

    await expect(waitPromise).resolves.toMatchObject({ id: "matrix-inbound" });
  });

  it("rejects thread sends without a room id", async () => {
    const config = await createMatrixConfig();
    const runtime = createMatrixRuntime();
    const provider = new MatrixProviderAdapter("matrix", config, "crabline", runtime.runtime);

    expect(() =>
      provider.normalizeTarget({
        id: "thread-target",
        metadata: {},
        threadId: "$event",
      }),
    ).toThrow(/requires channelId/u);
  });

  it("classifies auth failures during probe", async () => {
    const config = await createMatrixConfig();
    const runtime = createMatrixRuntime();
    runtime.adapter.fetchChannelInfo.mockRejectedValueOnce(new Error("401 unauthorized"));
    const provider = new MatrixProviderAdapter("matrix", config, "crabline", runtime.runtime);

    await expect(provider.probe(createMatrixContext(config))).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("records inbound once and exposes it through watch", async () => {
    const config = await createMatrixConfig();
    const runtime = createMatrixRuntime();
    const provider = new MatrixProviderAdapter("matrix", config, "crabline", runtime.runtime);
    const context = createMatrixContext(config);
    const stream = provider.watch({
      ...context,
      since: new Date(Date.now() - 1000).toISOString(),
    });
    const iterator = stream[Symbol.asyncIterator]();

    const firstEvent = iterator.next();
    await runtime.emit({
      author: { isBot: true },
      id: "matrix-watch",
      metadata: { dateSent: new Date() },
      text: "watch me",
      threadId: "matrix:!room%3Aexample.com",
    });
    await runtime.emit({
      author: { isBot: true },
      id: "matrix-watch",
      metadata: { dateSent: new Date() },
      text: "watch me",
      threadId: "matrix:!room%3Aexample.com",
    });

    await expect(firstEvent).resolves.toMatchObject({
      done: false,
      value: expect.objectContaining({ id: "matrix-watch" }),
    });

    const recorderPath = config.matrix?.recorder.path;
    expect(recorderPath).toBeDefined();
    const recorded = await readRecordedInbound(recorderPath!);
    expect(recorded.filter((event) => event.id === "matrix-watch")).toHaveLength(1);

    await iterator.return?.();
  });
});
