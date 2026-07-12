import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManifestDefinition, ProviderConfig } from "../src/config/schema.js";
import { runFixtureCommand } from "../src/core/run.js";
import { genericMockPayloadWithNativeThread } from "../src/providers/builtin/native-local-mock.js";
import { SlackProviderAdapter } from "../src/providers/builtin/slack.js";
import { LoopbackProviderAdapter } from "../src/providers/builtin/loopback.js";
import { OPENCLAW_SUPPORT_CATALOG } from "../src/providers/catalog.js";
import {
  createGenericLocalMockTargetCodec,
  LocalMockProviderAdapter,
} from "../src/providers/local-mock.js";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import type { Registry } from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const webhookMocks = vi.hoisted(() => ({
  startWebhookServer: vi.fn(),
}));

vi.mock("../src/providers/webhook-server.js", () => ({
  startWebhookServer: webhookMocks.startWebhookServer,
}));

const directories: string[] = [];
const providers: ProviderAdapter[] = [];

beforeEach(() => {
  webhookMocks.startWebhookServer.mockReset();
  webhookMocks.startWebhookServer.mockResolvedValue({
    async close() {},
    endpointUrl: "http://127.0.0.1:0/slack/events",
  });
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup?.()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createConfig(): ProviderConfig {
  return {
    adapter: "slack",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "slack",
    slack: {
      recorder: {},
      webhook: {
        host: "127.0.0.1",
        path: "/slack/events",
        port: 0,
      },
    },
    status: "active",
  };
}

function createContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "slack-probe",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "probe",
      provider: "provider-a",
      retries: 0,
      tags: [],
      target: { id: "C1234567890", metadata: {} },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "provider-a",
    userName: "crabline",
  };
}

describe("local mock provider", () => {
  it("keeps nested thread precedence with a top-level fallback", () => {
    const threadRule = {
      example: "thread-1",
      name: "test thread",
      pattern: /^thread-[a-z0-9]+$/u,
    };

    expect(
      genericMockPayloadWithNativeThread({
        payload: {
          message: { text: "fallback" },
          threadId: "thread-top",
        },
        threadRule,
      }),
    ).toMatchObject({
      message: { text: "fallback", threadId: "thread-top" },
      threadId: "thread-top",
    });
    expect(
      genericMockPayloadWithNativeThread({
        payload: {
          message: { text: "nested", threadId: "thread-nested" },
          threadId: "thread-top",
        },
        threadRule,
      }),
    ).toMatchObject({
      message: { text: "nested", threadId: "thread-nested" },
      threadId: "thread-nested",
    });
  });

  it("does not treat an occupied webhook port as a healthy server", async () => {
    const addressInUse = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
      code: "EADDRINUSE",
    });
    webhookMocks.startWebhookServer.mockRejectedValueOnce(addressInUse);
    const config: ProviderConfig = {
      adapter: "slack",
      capabilities: ["probe"],
      env: [],
      platform: "slack",
      slack: {
        recorder: {},
        webhook: {
          host: "127.0.0.1",
          path: "/slack/events",
          port: 8787,
        },
      },
      status: "active",
    };
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);

    await expect(
      provider.probe({
        config,
        fixture: {
          env: [],
          id: "slack-probe",
          inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
          mode: "probe",
          provider: "provider-a",
          retries: 0,
          tags: [],
          target: { id: "C1234567890", metadata: {} },
          timeoutMs: 500,
        },
        manifestPath: "/tmp/crabline.yaml",
        providerId: "provider-a",
        userName: "crabline",
      }),
    ).rejects.toThrow(/EADDRINUSE/u);
  });

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
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);
    const context = createContext(config);

    const firstProbe = provider.probe(context);
    const secondProbe = provider.probe(context);
    await vi.waitFor(() => expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1));

    resolveStart?.({
      close,
      endpointUrl: "http://127.0.0.1:43210/slack/events",
    });

    await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual([
      expect.objectContaining({ healthy: true }),
      expect.objectContaining({ healthy: true }),
    ]);
    expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1);

    await Promise.all([provider.cleanup(), provider.cleanup()]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes a listener that finishes starting after cleanup begins", async () => {
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
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);
    const probe = provider.probe(createContext(config));
    await vi.waitFor(() => expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1));
    const cleanup = provider.cleanup();

    resolveStart?.({
      close,
      endpointUrl: "http://127.0.0.1:43210/slack/events",
    });

    await expect(probe).rejects.toThrow('Provider "provider-a" has been cleaned up.');
    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(provider.probe(createContext(config))).rejects.toThrow(/cleaned up/u);
    expect(webhookMocks.startWebhookServer).toHaveBeenCalledTimes(1);
  });

  it("falls back to the webhook public URL and gives the top-level option precedence", async () => {
    const config = createConfig();
    const context = createContext(config);
    const createProvider = (publicUrl?: string) =>
      new LocalMockProviderAdapter({
        codec: createGenericLocalMockTargetCodec("slack"),
        config,
        id: "provider-a",
        options: {
          defaultWebhook: {
            host: "127.0.0.1",
            path: "/slack/events",
            port: 0,
          },
          endpointLabel: "webhook endpoint",
          platform: "slack",
          publicUrl,
          webhook: {
            host: "127.0.0.1",
            path: "/slack/events",
            port: 0,
            publicUrl: "https://webhook.example.test/slack/events",
          },
        },
      });

    const fallbackProvider = createProvider();
    providers.push(fallbackProvider);
    await expect(fallbackProvider.probe(context)).resolves.toMatchObject({
      details: expect.arrayContaining(["public webhook https://webhook.example.test/slack/events"]),
    });

    const preferredProvider = createProvider("https://top-level.example.test/slack/events");
    providers.push(preferredProvider);
    const preferredProbe = await preferredProvider.probe(context);
    expect(preferredProbe.details).toContain(
      "public webhook https://top-level.example.test/slack/events",
    );
    expect(preferredProbe.details).not.toContain(
      "public webhook https://webhook.example.test/slack/events",
    );
  });

  it.each(["authenticateWebhookRequest", "handleWebhookPayload"] as const)(
    "does not expose arbitrary %s failures as public 400 responses",
    async (hook) => {
      let handleRequest: ((request: Request) => Promise<Response>) | undefined;
      webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
        handleRequest = params.handle;
        return {
          async close() {},
          endpointUrl: "http://127.0.0.1:43210/slack/events",
        };
      });
      const config = createConfig();
      const provider = new LocalMockProviderAdapter({
        codec: createGenericLocalMockTargetCodec("slack"),
        config,
        id: "provider-a",
        options: {
          ...(hook === "authenticateWebhookRequest"
            ? {
                authenticateWebhookRequest() {
                  throw new Error("sensitive auth failure");
                },
              }
            : {
                handleWebhookPayload() {
                  throw new Error("sensitive hook failure");
                },
              }),
          defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
          endpointLabel: "events endpoint",
          platform: "slack",
        },
      });
      providers.push(provider);
      await provider.probe(createContext(config));

      await expect(
        handleRequest!(
          new Request("http://127.0.0.1:43210/slack/events", {
            body: "{}",
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        ),
      ).rejects.toThrow(/sensitive/u);
    },
  );

  it("rejects malformed normalized webhook envelopes", async () => {
    let handleRequest: ((request: Request) => Promise<Response>) | undefined;
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handleRequest = params.handle;
      return {
        async close() {},
        endpointUrl: "http://127.0.0.1:43210/slack/events",
      };
    });
    const config = createConfig();
    const provider = new LocalMockProviderAdapter({
      codec: createGenericLocalMockTargetCodec("slack"),
      config,
      id: "provider-a",
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
        endpointLabel: "events endpoint",
        normalizeWebhookPayload: () => ({
          message: { text: 42, threadId: "slack:C1234567890" },
        }),
        platform: "slack",
      },
    });
    providers.push(provider);
    await provider.probe(createContext(config));

    const response = await handleRequest!(
      new Request("http://127.0.0.1:43210/slack/events", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("payload.message.text");
  });

  it("does not let client raw.direction hide inbound events", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "client-direction.jsonl");
    let handleRequest: ((request: Request) => Promise<Response>) | undefined;
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handleRequest = params.handle;
      return {
        async close() {},
        endpointUrl: "http://127.0.0.1:43210/slack/events",
      };
    });
    const config = createConfig();
    const provider = new LocalMockProviderAdapter({
      codec: createGenericLocalMockTargetCodec("slack"),
      config,
      id: "provider-a",
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
        endpointLabel: "events endpoint",
        platform: "slack",
        recorderPath,
      },
    });
    providers.push(provider);
    const context = createContext(config);
    context.fixture.inboundMatch.author = "user";
    await provider.probe(context);
    const since = new Date(Date.now() - 1000).toISOString();
    await appendFile(
      recorderPath,
      `${JSON.stringify({
        author: "user",
        id: "legacy-outbound",
        provider: "provider-a",
        raw: { direction: "outbound" },
        recordedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        text: "legacy outbound",
        threadId: "slack:C1234567890",
      })}\n`,
      "utf8",
    );

    const response = await handleRequest!(
      new Request("http://127.0.0.1:43210/slack/events", {
        body: JSON.stringify({
          author: "user",
          raw: { direction: "outbound" },
          text: "client-controlled direction",
          threadId: "slack:C1234567890",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "client-direction",
        since,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      raw: { direction: "outbound" },
      text: "client-controlled direction",
    });
  });

  it("aborts active reads and drains an admitted send behind the cleanup fence", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "cleanup.jsonl");
    const config = createConfig();
    config.loopback = { delayMs: 50 };
    const provider = new LocalMockProviderAdapter({
      codec: createGenericLocalMockTargetCodec("slack"),
      config,
      id: "provider-a",
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
        endpointLabel: "events endpoint",
        platform: "slack",
        recorderPath,
      },
    });
    providers.push(provider);
    const context = createContext(config);
    context.fixture.mode = "roundtrip";
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "cleanup",
      since: new Date().toISOString(),
      timeoutMs: 10_000,
    });
    const watch = provider.watch({
      ...context,
      since: new Date().toISOString(),
    });
    const iterator = watch[Symbol.asyncIterator]();
    const watching = iterator.next();
    const sending = provider.send({
      ...context,
      mode: "roundtrip",
      nonce: "cleanup",
      text: "cleanup",
    });
    await vi.waitFor(async () => {
      expect((await readFile(recorderPath, "utf8")).trim().split("\n")).toHaveLength(1);
    });

    const cleanup = provider.cleanup();

    await expect(waiting).resolves.toBeNull();
    await expect(watching).resolves.toEqual({ done: true, value: undefined });
    await expect(
      provider.send({ ...context, mode: "send", nonce: "later", text: "later" }),
    ).rejects.toThrow(/cleaned up/u);
    await expect(sending).resolves.toMatchObject({ accepted: true });
    await expect(cleanup).resolves.toBeUndefined();
    expect((await readFile(recorderPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("does not watch events from another provider sharing its recorder", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "shared.jsonl");
    const config: ProviderConfig = {
      adapter: "slack",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      platform: "slack",
      slack: {
        recorder: { path: recorderPath },
        webhook: {
          host: "127.0.0.1",
          path: "/slack/events",
          port: 0,
        },
      },
      status: "active",
    };
    const providerA = new SlackProviderAdapter("provider-a", config, "crabline");
    const providerB = new SlackProviderAdapter("provider-b", config, "crabline");
    providers.push(providerA, providerB);

    const context: ProviderContext = {
      config,
      fixture: {
        env: [],
        id: "slack-agent",
        inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
        mode: "agent",
        provider: "slack",
        retries: 0,
        tags: [],
        target: { id: "C1234567890", metadata: {} },
        timeoutMs: 500,
      },
      manifestPath: "/tmp/crabline.yaml",
      providerId: "provider-a",
      userName: "crabline",
    };
    const watch = providerA.watch({
      ...context,
      since: new Date(Date.now() - 1000).toISOString(),
    });
    const iterator = watch[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "provider-b-event",
      provider: "provider-b",
      sentAt: new Date().toISOString(),
      text: "wrong provider",
      threadId: "C1234567890",
    });

    await expect(
      Promise.race([nextPromise.then(() => "yielded"), sleep(350).then(() => "timed-out")]),
    ).resolves.toBe("timed-out");

    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "provider-a-event",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "right provider",
      threadId: "C1234567890",
    });

    await expect(nextPromise).resolves.toMatchObject({
      done: false,
      value: {
        id: "provider-a-event",
        provider: "provider-a",
      },
    });
    await iterator.return?.();
  });

  it("runs past an earlier unrelated recorder event to the matching reply", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "slack.jsonl");
    const config = createConfig();
    config.slack!.recorder.path = recorderPath;
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);
    const fixture: ManifestDefinition["fixtures"][number] = {
      env: [],
      id: "slack-roundtrip",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "provider-a",
      retries: 0,
      tags: [],
      target: { behavior: "echo", id: "C1234567890", metadata: {} },
      timeoutMs: 100,
    };
    const manifest: ManifestDefinition = {
      configVersion: 1,
      fixtures: [fixture],
      providers: { "provider-a": config },
      userName: "crabline",
    };
    const registry: Registry = {
      catalog: OPENCLAW_SUPPORT_CATALOG,
      resolve() {
        return provider;
      },
    };

    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "unrelated",
      provider: "provider-a",
      sentAt: new Date(Date.now() + 60_000).toISOString(),
      text: "unrelated canonical-free message",
      threadId: "C1234567890",
    });

    await expect(
      runFixtureCommand({
        fixtureId: fixture.id,
        manifest,
        manifestPath: "/tmp/crabline.yaml",
        registry,
      }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it("never returns outbound sends through inbound wait or watch", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "directions.jsonl");
    const config = createConfig();
    config.slack!.recorder.path = recorderPath;
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);
    const context = createContext(config);
    context.fixture.mode = "roundtrip";
    context.fixture.inboundMatch.author = "any";
    const since = new Date(Date.now() - 1000).toISOString();

    await provider.send({
      ...context,
      mode: "roundtrip",
      nonce: "direction-nonce",
      text: "hello direction-nonce",
    });

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "direction-nonce",
        since,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      author: "assistant",
      raw: { direction: "mock-reply" },
    });

    context.fixture.inboundMatch.author = "user";
    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "direction-nonce",
        since,
        timeoutMs: 20,
      }),
    ).resolves.toBeNull();

    const watch = provider.watch({
      ...context,
      since,
    });
    const iterator = watch[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        author: "assistant",
        raw: { direction: "mock-reply" },
      },
    });
    await iterator.return?.();
  });

  it("bounds successful wait cursors while retaining recent progress", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "bounded-waits.jsonl");
    const config = createConfig();
    const provider = new LocalMockProviderAdapter({
      codec: createGenericLocalMockTargetCodec("slack"),
      config,
      id: "provider-a",
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
        endpointLabel: "events endpoint",
        platform: "slack",
        recorderPath,
      },
    });
    providers.push(provider);
    const contexts = Array.from({ length: 65 }, (_, index) => {
      const context = createContext(config);
      context.fixture.target = { id: `channel-${index}`, metadata: {} };
      return {
        ...context,
        nonce: `nonce-${index}`,
        since: new Date(0).toISOString(),
        threadId: `channel-${index}`,
        timeoutMs: 20,
      };
    });

    for (const [index, context] of contexts.entries()) {
      await appendRecordedInbound(recorderPath, {
        author: "assistant",
        id: `event-${index}`,
        provider: "provider-a",
        sentAt: new Date().toISOString(),
        text: `event ${index}`,
        threadId: context.threadId,
      });
      await expect(provider.waitForInbound(context)).resolves.toMatchObject({
        id: `event-${index}`,
      });
    }

    await expect(provider.waitForInbound(contexts[0]!)).resolves.toMatchObject({
      id: "event-0",
    });
    await expect(provider.waitForInbound(contexts.at(-1)!)).resolves.toBeNull();
  });

  it("does not evict active wait cursors when concurrency exceeds the retained limit", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "active-waits.jsonl");
    const config = createConfig();
    const provider = new LocalMockProviderAdapter({
      codec: createGenericLocalMockTargetCodec("slack"),
      config,
      id: "provider-a",
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
        endpointLabel: "events endpoint",
        platform: "slack",
        recorderPath,
      },
    });
    providers.push(provider);
    const contexts = Array.from({ length: 65 }, (_, index) => {
      const context = createContext(config);
      context.fixture.target = { id: `channel-${index}`, metadata: {} };
      return {
        ...context,
        nonce: `active-${index}`,
        since: new Date(0).toISOString(),
        threadId: `channel-${index}`,
        timeoutMs: 1_000,
      };
    });
    const waits = contexts.map((context) => provider.waitForInbound(context));
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [index, context] of contexts.entries()) {
      await appendRecordedInbound(recorderPath, {
        author: "assistant",
        id: `first-${index}`,
        provider: "provider-a",
        sentAt: new Date().toISOString(),
        text: `first ${index}`,
        threadId: context.threadId,
      });
    }
    await expect(Promise.all(waits)).resolves.toHaveLength(65);

    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "second-0",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "second 0",
      threadId: contexts[0]!.threadId,
    });
    await expect(provider.waitForInbound(contexts[0]!)).resolves.toMatchObject({
      id: "second-0",
    });
  });

  it("keeps concurrent same-key waits on independent cursors", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "concurrent-waits.jsonl");
    const config = createConfig();
    config.slack!.recorder.path = recorderPath;
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);
    const context = {
      ...createContext(config),
      nonce: "same-key",
      since: new Date(0).toISOString(),
      threadId: "C1234567890",
      timeoutMs: 500,
    };
    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "initial",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "initial",
      threadId: "C1234567890",
    });
    await expect(provider.waitForInbound(context)).resolves.toMatchObject({ id: "initial" });

    const firstWait = provider.waitForInbound(context);
    const secondWait = provider.waitForInbound(context);
    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "first",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "C1234567890",
    });
    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "second",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "C1234567890",
    });

    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual([
      expect.objectContaining({ id: "first" }),
      expect.objectContaining({ id: "first" }),
    ]);
    await expect(provider.waitForInbound(context)).resolves.toMatchObject({ id: "second" });
  });

  it("keeps progress when a newer same-key wait is aborted", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "aborted-concurrent-wait.jsonl");
    const config = createConfig();
    config.slack!.recorder.path = recorderPath;
    const provider = new SlackProviderAdapter("provider-a", config, "crabline");
    providers.push(provider);
    const context = {
      ...createContext(config),
      nonce: "same-key",
      since: new Date(0).toISOString(),
      threadId: "C1234567890",
      timeoutMs: 500,
    };
    const olderWait = provider.waitForInbound(context);
    const abortController = new AbortController();
    const newerWait = provider.waitForInbound({
      ...context,
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(newerWait).resolves.toBeNull();

    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "after-abort",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "after abort",
      threadId: "C1234567890",
    });
    await expect(olderWait).resolves.toMatchObject({ id: "after-abort" });
    await expect(provider.waitForInbound({ ...context, timeoutMs: 30 })).resolves.toBeNull();
  });

  it("isolates same-id loopback provider listeners and recorders", async () => {
    const config: ProviderConfig = {
      adapter: "loopback",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      loopback: { delayMs: 0 },
      platform: "loopback",
      status: "active",
    };
    const first = new LoopbackProviderAdapter("loopback", config, "crabline");
    const second = new LoopbackProviderAdapter("loopback", config, "crabline");
    providers.push(first, second);
    const context: ProviderContext = {
      config,
      fixture: {
        env: [],
        id: "loopback-agent",
        inboundMatch: { author: "assistant", nonce: "ignore", strategy: "contains" },
        mode: "agent",
        provider: "loopback",
        retries: 0,
        tags: [],
        target: { id: "recipient", metadata: {} },
        timeoutMs: 50,
      },
      manifestPath: "/tmp/crabline.yaml",
      providerId: "loopback",
      userName: "crabline",
    };

    const [firstProbe, secondProbe] = await Promise.all([
      first.probe(context),
      second.probe(context),
    ]);
    expect(webhookMocks.startWebhookServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ port: 0 }),
    );
    expect(webhookMocks.startWebhookServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ port: 0 }),
    );
    const firstRecorder = firstProbe.details.find((detail) => detail.startsWith("recorder path "));
    const secondRecorder = secondProbe.details.find((detail) =>
      detail.startsWith("recorder path "),
    );
    expect(firstRecorder).toBeDefined();
    expect(secondRecorder).toBeDefined();
    expect(firstRecorder).not.toBe(secondRecorder);
  });
});
