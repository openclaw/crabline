import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManifestDefinition, ProviderConfig } from "../src/config/schema.js";
import { createRegistry } from "../src/providers/registry.js";
import type { ProviderContext, SendContext } from "../src/providers/types.js";
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
          recorder: { path: recorderPath },
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
      const cleanup = provider.cleanup?.();

      await Promise.resolve();
      expect(events).toEqual([]);

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

  it("does not let an aborted lazy inbound wait block cleanup", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "telegram.jsonl");
    let markWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    recorderMocks.waitForRecordedInbound.mockImplementationOnce(async () => {
      markWaitStarted?.();
      return await new Promise<never>(() => undefined);
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

      await expect(waiting).rejects.toBe(abortReason);
      await expect(provider.cleanup?.()).resolves.toBeUndefined();
    } finally {
      await disposeTempDir(directory);
    }
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
});
