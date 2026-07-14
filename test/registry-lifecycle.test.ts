import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManifestDefinition, ProviderConfig } from "../src/config/schema.js";
import { createRegistry, LazyProviderAdapter } from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderContext, SendContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type AppendRecordedInbound = typeof import("../src/providers/recorder.js").appendRecordedInbound;
type StartWebhookServer = typeof import("../src/providers/webhook-server.js").startWebhookServer;
type WaitForRecordedInbound = typeof import("../src/providers/recorder.js").waitForRecordedInbound;
type WatchRecordedInbound = typeof import("../src/providers/recorder.js").watchRecordedInbound;
type WebhookHandler = Parameters<StartWebhookServer>[0]["handle"];

const recorderMocks = vi.hoisted(() => ({
  actualAppendRecordedInbound: undefined as AppendRecordedInbound | undefined,
  actualWaitForRecordedInbound: undefined as WaitForRecordedInbound | undefined,
  actualWatchRecordedInbound: undefined as WatchRecordedInbound | undefined,
  appendRecordedInbound: vi.fn<AppendRecordedInbound>(),
  waitForRecordedInbound: vi.fn<WaitForRecordedInbound>(),
  watchRecordedInbound: vi.fn<WatchRecordedInbound>(),
}));
const webhookMocks = vi.hoisted(() => ({
  actualStartWebhookServer: undefined as StartWebhookServer | undefined,
  startWebhookServer: vi.fn<StartWebhookServer>(),
}));
const telegramLifecycle = vi.hoisted(() => ({
  importBarrier: undefined as Promise<void> | undefined,
  onBeginCleanup: undefined as (() => void) | undefined,
  onProbe: undefined as (() => void) | undefined,
}));

vi.mock("../src/providers/recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/recorder.js")>();
  recorderMocks.actualAppendRecordedInbound = actual.appendRecordedInbound;
  recorderMocks.actualWaitForRecordedInbound = actual.waitForRecordedInbound;
  recorderMocks.actualWatchRecordedInbound = actual.watchRecordedInbound;
  recorderMocks.appendRecordedInbound.mockImplementation(actual.appendRecordedInbound);
  recorderMocks.waitForRecordedInbound.mockImplementation(actual.waitForRecordedInbound);
  recorderMocks.watchRecordedInbound.mockImplementation(actual.watchRecordedInbound);
  return {
    ...actual,
    appendRecordedInbound: recorderMocks.appendRecordedInbound,
    waitForRecordedInbound: recorderMocks.waitForRecordedInbound,
    watchRecordedInbound: recorderMocks.watchRecordedInbound,
  };
});
vi.mock("../src/providers/webhook-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/webhook-server.js")>();
  webhookMocks.actualStartWebhookServer = actual.startWebhookServer;
  webhookMocks.startWebhookServer.mockImplementation(actual.startWebhookServer);
  return {
    ...actual,
    startWebhookServer: webhookMocks.startWebhookServer,
  };
});
vi.mock("../src/providers/builtin/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/builtin/telegram.js")>();
  await telegramLifecycle.importBarrier;
  return {
    ...actual,
    TelegramProviderAdapter: class extends actual.TelegramProviderAdapter {
      override async probe(context: ProviderContext) {
        if (telegramLifecycle.onProbe) {
          telegramLifecycle.onProbe();
          return { details: [], healthy: true };
        }
        return await super.probe(context);
      }

      beginCleanup(): void {
        telegramLifecycle.onBeginCleanup?.();
      }
    },
  };
});

beforeEach(() => {
  recorderMocks.appendRecordedInbound.mockReset();
  recorderMocks.appendRecordedInbound.mockImplementation(
    recorderMocks.actualAppendRecordedInbound!,
  );
  recorderMocks.waitForRecordedInbound.mockReset();
  recorderMocks.waitForRecordedInbound.mockImplementation(
    recorderMocks.actualWaitForRecordedInbound!,
  );
  recorderMocks.watchRecordedInbound.mockReset();
  recorderMocks.watchRecordedInbound.mockImplementation(recorderMocks.actualWatchRecordedInbound!);
  webhookMocks.startWebhookServer.mockReset();
  webhookMocks.startWebhookServer.mockImplementation(webhookMocks.actualStartWebhookServer!);
  telegramLifecycle.importBarrier = undefined;
  telegramLifecycle.onBeginCleanup = undefined;
  telegramLifecycle.onProbe = undefined;
});

function createTelegramManifest(recorderPath: string): {
  config: ProviderConfig;
  context: ProviderContext;
  manifest: ManifestDefinition;
} {
  const config: ProviderConfig = {
    adapter: "telegram",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "telegram",
    status: "active",
    telegram: {
      mode: "auto",
      recorder: { path: recorderPath },
      webhook: {
        host: "127.0.0.1",
        path: "/telegram/webhook",
        port: 0,
      },
    },
  };
  const fixture = {
    env: [],
    id: "telegram-roundtrip",
    inboundMatch: {
      author: "assistant" as const,
      nonce: "contains" as const,
      strategy: "contains" as const,
    },
    mode: "roundtrip" as const,
    provider: "telegram",
    retries: 0,
    tags: [],
    target: { id: "123456789", metadata: {} },
    timeoutMs: 500,
  };
  const manifest: ManifestDefinition = {
    configVersion: 1,
    fixtures: [fixture],
    providers: { telegram: config },
    userName: "crabline",
  };
  return {
    config,
    context: {
      config,
      fixture,
      manifestPath: "/tmp/crabline.yaml",
      providerId: "telegram",
      userName: "crabline",
    },
    manifest,
  };
}

describe("lazy provider lifecycle", () => {
  it("does not dispatch an operation aborted during provider initialization", async () => {
    let releaseFactory: (() => void) | undefined;
    const factoryBlocked = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const waitForInbound = vi.fn<ProviderAdapter["waitForInbound"]>(async () => null);
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["roundtrip"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound,
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => {
        await factoryBlocked;
        return concrete;
      },
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["roundtrip"],
    });
    const controller = new AbortController();
    const abortReason = new Error("deadline reached during initialization");
    const waiting = provider.waitForInbound({
      config: {
        adapter: "loopback",
        capabilities: ["roundtrip"],
        env: [],
        platform: "loopback",
        status: "active",
      },
      fixture: {
        env: [],
        id: "fixture",
        inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
        mode: "roundtrip",
        provider: "test",
        retries: 0,
        tags: [],
        target: { id: "target", metadata: {} },
        timeoutMs: 10,
      },
      manifestPath: "/tmp/crabline.yaml",
      nonce: "nonce",
      providerId: "test",
      signal: controller.signal,
      since: new Date().toISOString(),
      timeoutMs: 10,
      userName: "crabline",
    });

    controller.abort(abortReason);
    releaseFactory?.();

    await expect(waiting).rejects.toBe(abortReason);
    expect(waitForInbound).not.toHaveBeenCalled();
    await provider.cleanup();
  });

  it("starts concrete cleanup before waiting for a stuck operation", async () => {
    let releaseWait: (() => void) | undefined;
    let markCleanupStarted: (() => void) | undefined;
    let markWaitStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["roundtrip"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        markWaitStarted?.();
        return await new Promise<null>((resolve) => {
          releaseWait = () => resolve(null);
        });
      },
      async cleanup() {
        markCleanupStarted?.();
        releaseWait?.();
      },
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => concrete,
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["roundtrip"],
    });
    const controller = new AbortController();
    const waiting = provider.waitForInbound({
      config: {
        adapter: "loopback",
        capabilities: ["roundtrip"],
        env: [],
        platform: "loopback",
        status: "active",
      },
      fixture: {
        env: [],
        id: "fixture",
        inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
        mode: "roundtrip",
        provider: "test",
        retries: 0,
        tags: [],
        target: { id: "target", metadata: {} },
        timeoutMs: 10,
      },
      manifestPath: "/tmp/crabline.yaml",
      nonce: "nonce",
      providerId: "test",
      signal: controller.signal,
      since: new Date().toISOString(),
      timeoutMs: 10,
      userName: "crabline",
    });
    await waitStarted;
    controller.abort();

    const cleanup = provider.cleanup();

    await expect(cleanupStarted).resolves.toBeUndefined();
    await expect(waiting).resolves.toBeNull();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("starts concrete WhatsApp cleanup before draining admitted registry work", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "whatsapp.jsonl");
    let cleanup: Promise<void> | undefined;
    let handle: WebhookHandler | undefined;
    let markWaitStarted: (() => void) | undefined;
    let waiting: Promise<unknown> | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    const close = vi.fn(async () => undefined);
    recorderMocks.waitForRecordedInbound.mockImplementationOnce(async (params) => {
      markWaitStarted?.();
      return await recorderMocks.actualWaitForRecordedInbound!(params);
    });
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handle = params.handle;
      return {
        close,
        endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
      };
    });

    try {
      const config: ProviderConfig = {
        adapter: "whatsapp",
        capabilities: ["probe", "send", "roundtrip", "agent"],
        env: [],
        platform: "whatsapp",
        status: "active",
        whatsapp: {
          appSecret: "test-token-placeholder",
          recorder: { path: recorderPath },
          verifyToken: "test-token-placeholder",
          webhook: {
            host: "127.0.0.1",
            path: "/whatsapp/webhook",
            port: 0,
          },
        },
      };
      const fixture = {
        env: [],
        id: "whatsapp-roundtrip",
        inboundMatch: {
          author: "assistant" as const,
          nonce: "contains" as const,
          strategy: "contains" as const,
        },
        mode: "roundtrip" as const,
        provider: "whatsapp",
        retries: 0,
        tags: [],
        target: { id: "15551234567", metadata: {} },
        timeoutMs: 500,
      };
      const manifest: ManifestDefinition = {
        configVersion: 1,
        fixtures: [fixture],
        providers: { whatsapp: config },
        userName: "crabline",
      };
      const context: ProviderContext = {
        config,
        fixture,
        manifestPath: "/tmp/crabline.yaml",
        providerId: "whatsapp",
        userName: "crabline",
      };
      const provider = createRegistry(manifest, context.manifestPath).resolve(
        "whatsapp",
        fixture.id,
      );
      await provider.probe(context);
      let waitResolved = false;
      waiting = provider
        .waitForInbound({
          ...context,
          nonce: "registry-cleanup-race",
          since: new Date().toISOString(),
          timeoutMs: 200,
        })
        .then((result) => {
          waitResolved = true;
          return result;
        });
      await waitStarted;

      let cleanupResolved = false;
      cleanup = provider.cleanup?.().then(() => {
        cleanupResolved = true;
      });

      expect(close).toHaveBeenCalledTimes(1);
      expect(waitResolved).toBe(false);
      expect(cleanupResolved).toBe(false);
      await expect(
        handle!(
          new Request("http://127.0.0.1:43210/whatsapp/webhook", {
            body: JSON.stringify({
              id: "wa-rejected-after-registry-cleanup",
              text: "must not be recorded",
              threadId: "15551234567",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        ),
      ).resolves.toMatchObject({ status: 503 });
      expect(recorderMocks.appendRecordedInbound).not.toHaveBeenCalled();

      await expect(waiting).resolves.toBeNull();
      await cleanup;
      await expect(readFile(recorderPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await waiting?.catch(() => undefined);
      await cleanup?.catch(() => undefined);
      await disposeTempDir(directory);
    }
  });

  it("dispatches admitted work before beginning concrete cleanup", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let releaseImport: (() => void) | undefined;
    const events: string[] = [];
    telegramLifecycle.importBarrier = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    telegramLifecycle.onProbe = () => events.push("probe");
    telegramLifecycle.onBeginCleanup = () => events.push("beginCleanup");

    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, context.manifestPath).resolve(
        "telegram",
        context.fixture.id,
      );
      const probing = provider.probe(context);
      provider.beginCleanup?.();
      const cleanup = provider.cleanup?.();

      await Promise.resolve();
      expect(events).toEqual([]);
      await expect(provider.probe(context)).rejects.toThrow(/has been cleaned up/u);

      releaseImport?.();
      await expect(probing).resolves.toEqual({ details: [], healthy: true });
      await cleanup;
      expect(events).toEqual(["probe", "beginCleanup"]);
    } finally {
      releaseImport?.();
      telegramLifecycle.importBarrier = undefined;
      telegramLifecycle.onBeginCleanup = undefined;
      telegramLifecycle.onProbe = undefined;
      await disposeTempDir(directory);
    }
  });

  it("forwards the synchronous cleanup fence to a materialized provider once", async () => {
    const beginCleanup = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["probe"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        return null;
      },
      beginCleanup,
      cleanup,
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => concrete,
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["probe"],
    });
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    await provider.probe(context);

    provider.beginCleanup();
    expect(beginCleanup).toHaveBeenCalledOnce();

    await Promise.all([provider.cleanup(), provider.cleanup()]);

    expect(beginCleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("drains an operation admitted before provider materialization", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let cleanup: Promise<void> | undefined;
    let sending: Promise<unknown> | undefined;
    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, "/tmp/crabline.yaml").resolve(
        "telegram",
        context.fixture.id,
      );
      sending = provider.send({
        ...context,
        mode: "roundtrip",
        nonce: "lazy-materialization-race",
        text: "admitted before cleanup",
      });

      cleanup = provider.cleanup?.();

      await expect(sending).resolves.toMatchObject({ accepted: true });
      await cleanup;
      expect((await readFile(recorderPath, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      await sending?.catch(() => undefined);
      await cleanup?.catch(() => undefined);
      await disposeTempDir(directory);
    }
  });

  it("waits for an admitted non-WhatsApp send before cleanup resolves", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let cleanup: Promise<void> | undefined;
    let releaseReply: (() => void) | undefined;
    let sending: Promise<unknown> | undefined;
    const replyBlocked = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    let appendCount = 0;
    recorderMocks.appendRecordedInbound.mockImplementation(async (...args) => {
      appendCount += 1;
      if (appendCount === 2) {
        await replyBlocked;
      }
      return await recorderMocks.actualAppendRecordedInbound!(...args);
    });

    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, "/tmp/crabline.yaml").resolve(
        "telegram",
        context.fixture.id,
      );
      const sendContext: SendContext = {
        ...context,
        mode: "roundtrip",
        nonce: "lazy-cleanup-race",
        text: "finish before cleanup",
      };

      sending = provider.send(sendContext);
      await vi.waitFor(() => expect(recorderMocks.appendRecordedInbound).toHaveBeenCalledTimes(2));

      let cleanupResolved = false;
      cleanup = provider.cleanup?.().then(() => {
        cleanupResolved = true;
      });
      await Promise.resolve();
      expect(cleanupResolved).toBe(false);

      releaseReply?.();
      await cleanup;
      await sending;
      const contentsAfterCleanup = await readFile(recorderPath, "utf8");
      expect(contentsAfterCleanup.trim().split("\n")).toHaveLength(2);
      await Promise.resolve();
      expect(await readFile(recorderPath, "utf8")).toBe(contentsAfterCleanup);
    } finally {
      releaseReply?.();
      await sending?.catch(() => undefined);
      await cleanup?.catch(() => undefined);
      await disposeTempDir(directory);
    }
  });

  it("tracks an aborted lazy inbound wait until provider work settles", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let markWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    let releaseWait: (() => void) | undefined;
    const waitBlocked = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    recorderMocks.waitForRecordedInbound.mockImplementationOnce(async () => {
      markWaitStarted?.();
      await waitBlocked;
      return null;
    });

    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, context.manifestPath).resolve(
        "telegram",
        context.fixture.id,
      );
      const controller = new AbortController();
      const waiting = provider.waitForInbound({
        ...context,
        nonce: "aborted-lazy-wait",
        signal: controller.signal,
        since: new Date().toISOString(),
        timeoutMs: 100,
      });
      await waitStarted;
      const abortReason = new Error("inbound deadline reached");

      controller.abort(abortReason);

      let waitingSettled = false;
      void waiting.finally(() => {
        waitingSettled = true;
      });
      let cleanupResolved = false;
      const cleanup = provider.cleanup?.().then(() => {
        cleanupResolved = true;
      });
      await Promise.resolve();
      expect(waitingSettled).toBe(false);
      expect(cleanupResolved).toBe(false);

      releaseWait?.();
      await expect(waiting).resolves.toBeNull();
      await expect(cleanup).resolves.toBeUndefined();
    } finally {
      releaseWait?.();
      await disposeTempDir(directory);
    }
  });

  it("does not invoke a lazy provider for a pre-aborted wait", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, context.manifestPath).resolve(
        "telegram",
        context.fixture.id,
      );
      const controller = new AbortController();
      const abortReason = new Error("already aborted");
      controller.abort(abortReason);

      await expect(
        provider.waitForInbound({
          ...context,
          nonce: "pre-aborted",
          signal: controller.signal,
          since: new Date().toISOString(),
          timeoutMs: 100,
        }),
      ).rejects.toBe(abortReason);

      expect(recorderMocks.waitForRecordedInbound).not.toHaveBeenCalled();
      await provider.cleanup?.();
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("does not materialize a lazy provider for a pre-aborted watch", async () => {
    const factory = vi.fn<() => Promise<ProviderAdapter>>();
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory,
      id: "test",
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
    });
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    const watch = provider.watch({ ...context, signal: controller.signal });
    await expect(watch[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(factory).not.toHaveBeenCalled();
    await provider.cleanup();
    expect(factory).not.toHaveBeenCalled();
  });

  it("cancels and drains an admitted watch before cleanup resolves", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let markWatchStarted: (() => void) | undefined;
    const watchStarted = new Promise<void>((resolve) => {
      markWatchStarted = resolve;
    });
    let watchStopped = false;
    recorderMocks.watchRecordedInbound.mockImplementationOnce(async function* (params) {
      markWatchStarted?.();
      if (!params.signal?.aborted) {
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      watchStopped = true;
      yield* [];
    });

    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, "/tmp/crabline.yaml").resolve(
        "telegram",
        context.fixture.id,
      );
      const iterator = provider.watch!(context)[Symbol.asyncIterator]();
      const pending = iterator.next();
      await watchStarted;

      await provider.cleanup?.();

      expect(watchStopped).toBe(true);
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("aborts a pending watch before forwarding iterator throws", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let markWatchStarted: (() => void) | undefined;
    const watchStarted = new Promise<void>((resolve) => {
      markWatchStarted = resolve;
    });
    let watchStopped = false;
    recorderMocks.watchRecordedInbound.mockImplementationOnce(async function* (params) {
      markWatchStarted?.();
      if (!params.signal?.aborted) {
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      watchStopped = true;
      yield* [];
    });

    try {
      const { context, manifest } = createTelegramManifest(recorderPath);
      const provider = createRegistry(manifest, "/tmp/crabline.yaml").resolve(
        "telegram",
        context.fixture.id,
      );
      const iterator = provider.watch!(context)[Symbol.asyncIterator]();
      const pending = iterator.next();
      await watchStarted;
      const thrownError = new Error("stop watching");

      const thrown = iterator.throw!(thrownError);

      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      await expect(thrown).rejects.toBe(thrownError);
      expect(watchStopped).toBe(true);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("keeps nonterminal iterator throws tracked until cleanup closes the watch", async () => {
    const first = {
      author: "assistant" as const,
      id: "first",
      provider: "test",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "thread",
    };
    const recovered = { ...first, id: "recovered", text: "recovered" };
    let watchClosed = false;
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        return null;
      },
      async *watch() {
        try {
          try {
            yield first;
          } catch {
            yield recovered;
            yield first;
          }
        } finally {
          watchClosed = true;
        }
      },
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => concrete,
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
    });
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    const iterator = provider.watch(context)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: first });
    await expect(iterator.throw!(new Error("recover"))).resolves.toEqual({
      done: false,
      value: recovered,
    });
    expect(watchClosed).toBe(false);

    await provider.cleanup();

    expect(watchClosed).toBe(true);
  });

  it("cancels an admitted watch before cleaning up a materializing provider", async () => {
    let releaseFactory: (() => void) | undefined;
    const factoryBlocked = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const events: string[] = [];
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        return null;
      },
      async *watch() {
        events.push("watch");
        yield* [];
      },
      beginCleanup() {
        events.push("beginCleanup");
      },
      async cleanup() {
        events.push("cleanup");
      },
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => {
        await factoryBlocked;
        return concrete;
      },
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
    });
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    const iterator = provider.watch(context)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const cleanup = provider.cleanup();

    await Promise.resolve();
    expect(events).toEqual([]);

    releaseFactory?.();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(cleanup).resolves.toBeUndefined();
    expect(events).toEqual(["beginCleanup", "cleanup"]);
  });

  it("attempts every teardown and reports watch and provider cleanup failures", async () => {
    const watchCloseError = new Error("watch close failed");
    const beginCleanupError = new Error("begin cleanup failed");
    let markWatchStarted: (() => void) | undefined;
    const watchStarted = new Promise<void>((resolve) => {
      markWatchStarted = resolve;
    });
    const cleanup = vi.fn(async () => undefined);
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        return null;
      },
      watch(_context) {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                markWatchStarted?.();
                return {
                  done: false as const,
                  value: {
                    author: "assistant" as const,
                    id: "watch-event",
                    provider: "test",
                    sentAt: new Date().toISOString(),
                    text: "watch event",
                    threadId: "thread",
                  },
                };
              },
              async return() {
                throw watchCloseError;
              },
            };
          },
        };
      },
      beginCleanup() {
        throw beginCleanupError;
      },
      cleanup,
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => concrete,
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
    });
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    const iterator = provider.watch(context)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await watchStarted;
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { id: "watch-event" },
    });

    const cleanupResult = provider.cleanup();

    await expect(cleanupResult).rejects.toMatchObject({
      errors: expect.arrayContaining([beginCleanupError, watchCloseError]),
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("drains lazy watch cleanup yields when a for-await loop breaks", async () => {
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    const event = (id: string) => ({
      author: "assistant" as const,
      id,
      provider: "test",
      sentAt: new Date().toISOString(),
      text: id,
      threadId: "thread",
    });
    const cleanupSteps: string[] = [];
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        return null;
      },
      async *watch() {
        try {
          yield event("watch-event");
        } finally {
          cleanupSteps.push("before-yield");
          yield event("cleanup-yield");
          cleanupSteps.push("after-yield");
        }
      },
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => concrete,
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
    });
    for await (const value of provider.watch(context)) {
      expect(value.id).toBe("watch-event");
      break;
    }

    expect(cleanupSteps).toEqual(["before-yield", "after-yield"]);
    await provider.cleanup();
  });

  it("preserves lazy watch errors after cleanup yields on for-await break", async () => {
    const { context } = createTelegramManifest("/tmp/unused.jsonl");
    const cleanupError = new Error("watch cleanup failed");
    const event = {
      author: "assistant" as const,
      id: "watch-event",
      provider: "test",
      sentAt: new Date().toISOString(),
      text: "watch event",
      threadId: "thread",
    };
    const cleanupSteps: string[] = [];
    const concrete: ProviderAdapter = {
      id: "test",
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      async waitForInbound() {
        return null;
      },
      async *watch() {
        try {
          yield event;
        } finally {
          cleanupSteps.push("before-yield");
          yield { ...event, id: "cleanup-yield" };
          cleanupSteps.push("after-yield");
          // oxlint-disable-next-line no-unsafe-finally -- This intentionally models a failing generator cleanup.
          throw cleanupError;
        }
      },
    };
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => concrete,
      id: "test",
      normalizeTarget: concrete.normalizeTarget.bind(concrete),
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
    });

    await expect(
      (async () => {
        for await (const value of provider.watch(context)) {
          expect(value.id).toBe("watch-event");
          break;
        }
      })(),
    ).rejects.toBe(cleanupError);
    expect(cleanupSteps).toEqual(["before-yield", "after-yield"]);
    await provider.cleanup();
  });

  it("preserves lazy factory errors", async () => {
    const factoryError = new Error("constructor rejected provider configuration");
    const provider = new LazyProviderAdapter({
      adapterName: "test",
      factory: async () => {
        throw factoryError;
      },
      id: "test",
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      platform: "loopback",
      status: "ready",
      supports: ["probe"],
    });
    const { context } = createTelegramManifest("/tmp/unused.jsonl");

    await expect(provider.probe(context)).rejects.toBe(factoryError);
    await provider.cleanup();
  });
});
