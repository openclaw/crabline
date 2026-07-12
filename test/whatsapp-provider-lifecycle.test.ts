import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../src/config/schema.js";
import { WhatsAppProviderAdapter } from "../src/providers/builtin/whatsapp.js";
import type { ProviderContext, SendContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type AppendRecordedInbound = typeof import("../src/providers/recorder.js").appendRecordedInbound;

const webhookMocks = vi.hoisted(() => ({
  startWebhookServer: vi.fn(),
}));
const recorderMocks = vi.hoisted(() => ({
  actualAppendRecordedInbound: undefined as AppendRecordedInbound | undefined,
  appendRecordedInbound: vi.fn<AppendRecordedInbound>(),
}));

vi.mock("../src/providers/webhook-server.js", () => ({
  startWebhookServer: webhookMocks.startWebhookServer,
}));
vi.mock("../src/providers/recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/recorder.js")>();
  recorderMocks.actualAppendRecordedInbound = actual.appendRecordedInbound;
  recorderMocks.appendRecordedInbound.mockImplementation(actual.appendRecordedInbound);
  return {
    ...actual,
    appendRecordedInbound: recorderMocks.appendRecordedInbound,
  };
});

beforeEach(() => {
  webhookMocks.startWebhookServer.mockReset();
  recorderMocks.appendRecordedInbound.mockReset();
  recorderMocks.appendRecordedInbound.mockImplementation(
    recorderMocks.actualAppendRecordedInbound!,
  );
});

function createConfig(recorderPath?: string): ProviderConfig {
  return {
    adapter: "whatsapp",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "whatsapp",
    status: "active",
    whatsapp: {
      recorder: recorderPath ? { path: recorderPath } : {},
      webhook: {
        host: "127.0.0.1",
        path: "/whatsapp/webhook",
        port: 0,
      },
    },
  };
}

function createContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "whatsapp-probe",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "probe",
      provider: "whatsapp",
      retries: 0,
      tags: [],
      target: { id: "15551234567", metadata: {} },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "whatsapp",
    userName: "crabline",
  };
}

describe("WhatsApp provider lifecycle", () => {
  it("shares one listener across concurrent probes and closes it once", async () => {
    let resolveStart:
      | ((server: { close(): Promise<void>; endpointUrl: string }) => void)
      | undefined;
    const close = vi.fn(async () => undefined);
    webhookMocks.startWebhookServer.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const config = createConfig();
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createContext(config);

    const firstProbe = provider.probe(context);
    const secondProbe = provider.probe(context);
    await vi.waitFor(() => expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1));

    resolveStart?.({
      close,
      endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
    });

    await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual([
      expect.objectContaining({ healthy: true }),
      expect.objectContaining({ healthy: true }),
    ]);
    expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1);

    await Promise.all([provider.cleanup(), provider.cleanup()]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(provider.probe(context)).rejects.toThrow(/has been cleaned up/u);
    expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1);
  });

  it("closes an in-flight listener when cleanup wins the startup race", async () => {
    let resolveStart:
      | ((server: { close(): Promise<void>; endpointUrl: string }) => void)
      | undefined;
    const close = vi.fn(async () => undefined);
    webhookMocks.startWebhookServer.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const config = createConfig();
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createContext(config);

    const probe = provider.probe(context);
    await vi.waitFor(() => expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1));

    const cleanup = provider.cleanup();
    await expect(provider.probe(context)).rejects.toThrow(/has been cleaned up/u);
    resolveStart?.({
      close,
      endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
    });

    await expect(probe).rejects.toThrow(/has been cleaned up/u);
    await cleanup;
    expect(close).toHaveBeenCalledTimes(1);
    expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1);
  });

  it("rejects sends after cleanup without mutating the recorder", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "whatsapp.jsonl");
    try {
      const config = createConfig(recorderPath);
      const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
      const context = createContext(config);
      const sendContext: SendContext = {
        ...context,
        mode: "send",
        nonce: "whatsapp-cleanup-send",
        text: "must not be recorded",
      };

      await provider.cleanup();

      await expect(provider.send(sendContext)).rejects.toThrow(/has been cleaned up/u);
      await expect(readFile(recorderPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(webhookMocks.startWebhookServer).not.toHaveBeenCalled();
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("waits for an admitted send before cleanup resolves", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "whatsapp.jsonl");
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
      const config = createConfig(recorderPath);
      const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
      const context = createContext(config);
      sending = provider.send({
        ...context,
        mode: "roundtrip",
        nonce: "whatsapp-cleanup-race",
        text: "finish before cleanup",
      });
      await vi.waitFor(() => expect(recorderMocks.appendRecordedInbound).toHaveBeenCalledTimes(2));

      let cleanupResolved = false;
      cleanup = provider.cleanup().then(() => {
        cleanupResolved = true;
      });
      await Promise.resolve();
      expect(cleanupResolved).toBe(false);
      expect((await readFile(recorderPath, "utf8")).trim().split("\n")).toHaveLength(1);

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
});
