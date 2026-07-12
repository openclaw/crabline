import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../src/config/schema.js";
import { WhatsAppProviderAdapter } from "../src/providers/builtin/whatsapp.js";
import { LocalMockProviderAdapter } from "../src/providers/local-mock.js";
import { readRecordedInbound } from "../src/providers/recorder.js";
import type { ProviderContext, SendContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type AppendRecordedInbound = typeof import("../src/providers/recorder.js").appendRecordedInbound;
type AppendRecordedInboundBatch =
  typeof import("../src/providers/recorder.js").appendRecordedInboundBatch;
type WebhookHandler = Parameters<
  typeof import("../src/providers/webhook-server.js").startWebhookServer
>[0]["handle"];

const webhookMocks = vi.hoisted(() => ({
  startWebhookServer: vi.fn(),
}));
const recorderMocks = vi.hoisted(() => ({
  actualAppendRecordedInbound: undefined as AppendRecordedInbound | undefined,
  actualAppendRecordedInboundBatch: undefined as AppendRecordedInboundBatch | undefined,
  appendRecordedInbound: vi.fn<AppendRecordedInbound>(),
  appendRecordedInboundBatch: vi.fn<AppendRecordedInboundBatch>(),
}));

vi.mock("../src/providers/webhook-server.js", () => ({
  startWebhookServer: webhookMocks.startWebhookServer,
}));
vi.mock("../src/providers/recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/recorder.js")>();
  recorderMocks.actualAppendRecordedInbound = actual.appendRecordedInbound;
  recorderMocks.actualAppendRecordedInboundBatch = actual.appendRecordedInboundBatch;
  recorderMocks.appendRecordedInbound.mockImplementation(actual.appendRecordedInbound);
  recorderMocks.appendRecordedInboundBatch.mockImplementation(actual.appendRecordedInboundBatch);
  return {
    ...actual,
    appendRecordedInbound: recorderMocks.appendRecordedInbound,
    appendRecordedInboundBatch: recorderMocks.appendRecordedInboundBatch,
  };
});

beforeEach(() => {
  webhookMocks.startWebhookServer.mockReset();
  recorderMocks.appendRecordedInbound.mockReset();
  recorderMocks.appendRecordedInbound.mockImplementation(
    recorderMocks.actualAppendRecordedInbound!,
  );
  recorderMocks.appendRecordedInboundBatch.mockReset();
  recorderMocks.appendRecordedInboundBatch.mockImplementation(
    recorderMocks.actualAppendRecordedInboundBatch!,
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
      appSecret: "test-token-placeholder",
      recorder: recorderPath ? { path: recorderPath } : {},
      verifyToken: "test-token-placeholder",
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

function signedWhatsAppRequest(body: unknown): Request {
  const rawBody = JSON.stringify(body);
  return new Request("http://127.0.0.1:43210/whatsapp/webhook", {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-token-placeholder").update(rawBody).digest("hex")}`,
    },
    method: "POST",
  });
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

  it("runs superclass cleanup when listener close fails", async () => {
    const closeError = new Error("close failed");
    webhookMocks.startWebhookServer.mockResolvedValueOnce({
      async close() {
        throw closeError;
      },
      endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
    });
    const superCleanup = vi.spyOn(LocalMockProviderAdapter.prototype, "cleanup");
    const config = createConfig();
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    try {
      await provider.probe(createContext(config));
      await expect(provider.cleanup()).rejects.toBe(closeError);
      expect(superCleanup).toHaveBeenCalledTimes(1);
    } finally {
      superCleanup.mockRestore();
    }
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

  it("aborts direct waits and watches and fences sends when cleanup begins", async () => {
    const close = vi.fn(async () => undefined);
    webhookMocks.startWebhookServer.mockResolvedValueOnce({
      close,
      endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
    });
    const config = createConfig();
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createContext(config);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "cleanup-abort",
      since: new Date(0).toISOString(),
      timeoutMs: 30_000,
    });
    const stream = provider.watch({
      ...context,
      since: new Date(0).toISOString(),
    });
    const watching = stream[Symbol.asyncIterator]();
    const next = watching.next();
    await vi.waitFor(() => expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1));

    provider.beginCleanup();

    await expect(waiting).resolves.toBeNull();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "cleanup-fenced",
        text: "must not be sent",
      }),
    ).rejects.toThrow(/has been cleaned up/u);
    await provider.cleanup();
    expect(close).toHaveBeenCalledTimes(1);
    expect(recorderMocks.appendRecordedInbound).not.toHaveBeenCalled();
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

  it("closes ingress before draining admitted webhook work", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "whatsapp.jsonl");
    let cleanup: Promise<void> | undefined;
    let handle: WebhookHandler | undefined;
    let releaseAppend: (() => void) | undefined;
    let request: Promise<Response> | undefined;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const close = vi.fn(async () => undefined);
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handle = params.handle;
      return {
        close,
        endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
      };
    });
    recorderMocks.appendRecordedInboundBatch.mockImplementationOnce(async (...args) => {
      await appendBlocked;
      return await recorderMocks.actualAppendRecordedInboundBatch!(...args);
    });

    try {
      const config = createConfig(recorderPath);
      const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
      const context = createContext(config);
      await provider.probe(context);

      request = handle!(
        signedWhatsAppRequest({
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: "local-mock-phone" },
                    messages: [
                      {
                        from: "15551234567",
                        id: "wa-cleanup-ingress-1",
                        text: { body: "finish before cleanup" },
                        type: "text",
                      },
                      {
                        from: "15551234567",
                        id: "wa-cleanup-ingress-2",
                        text: { body: "finish the admitted batch" },
                        type: "text",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      await vi.waitFor(() =>
        expect(recorderMocks.appendRecordedInboundBatch).toHaveBeenCalledTimes(1),
      );

      let cleanupResolved = false;
      cleanup = provider.cleanup().then(() => {
        cleanupResolved = true;
      });
      expect(close).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(cleanupResolved).toBe(false);

      await expect(
        handle!(
          new Request("http://127.0.0.1:43210/whatsapp/webhook", {
            body: JSON.stringify({
              id: "wa-rejected-ingress",
              text: "must not be recorded",
              threadId: "15551234567",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        ),
      ).resolves.toMatchObject({ status: 503 });
      expect(recorderMocks.appendRecordedInboundBatch).toHaveBeenCalledTimes(1);

      releaseAppend?.();
      await expect(request).resolves.toMatchObject({ status: 200 });
      await cleanup;
      const contentsAfterCleanup = await readFile(recorderPath, "utf8");
      await expect(readRecordedInbound(recorderPath)).resolves.toHaveLength(2);
      await Promise.resolve();
      expect(await readFile(recorderPath, "utf8")).toBe(contentsAfterCleanup);
    } finally {
      releaseAppend?.();
      await request?.catch(() => undefined);
      await cleanup?.catch(() => undefined);
      await disposeTempDir(directory);
    }
  });

  it("bounds oversized bodies and aborts incomplete requests during cleanup", async () => {
    let handle: WebhookHandler | undefined;
    const close = vi.fn(async () => undefined);
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handle = params.handle;
      return {
        close,
        endpointUrl: "http://127.0.0.1:43210/whatsapp/webhook",
      };
    });
    const config = createConfig();
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    await provider.probe(createContext(config));

    const oversized = await handle!(
      new Request("http://127.0.0.1:43210/whatsapp/webhook", {
        body: "x".repeat(1024 * 1024 + 1),
        method: "POST",
      }),
    );
    expect(oversized.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const incomplete = handle!(
      new Request("http://127.0.0.1:43210/whatsapp/webhook", {
        body: stream,
        duplex: "half",
        method: "POST",
      }),
    );
    await Promise.resolve();

    const cleanup = provider.cleanup();
    await expect(cleanup).resolves.toBeUndefined();
    await expect(incomplete).resolves.toMatchObject({ status: 503 });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
