import { appendFile, open, readFile, writeFile, type FileHandle } from "node:fs/promises";
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
import { createTempDir, disposeTempDir, settleCleanup } from "./test-helpers.js";

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
  const failures: unknown[] = [];
  try {
    await settleCleanup(providers.splice(0).map(async (provider) => provider.cleanup?.()));
  } catch (error) {
    failures.push(error);
  }
  try {
    await settleCleanup(directories.splice(0).map(disposeTempDir));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Provider and recorder cleanup failed.");
  }
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
    (provider as ProviderAdapter).beginCleanup?.();
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

  it.each([
    {
      body: undefined,
      contentType: undefined,
      expectedPayload: "",
      method: "GET",
    },
    {
      body: "provider challenge",
      contentType: "text/plain",
      expectedPayload: "provider challenge",
      method: "POST",
    },
  ])("lets provider hooks intercept $method non-JSON requests", async (requestCase) => {
    let handleRequest: ((request: Request) => Promise<Response>) | undefined;
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handleRequest = params.handle;
      return {
        async close() {},
        endpointUrl: "http://127.0.0.1:43210/slack/events",
      };
    });
    const authenticate = vi.fn(() => undefined);
    const handlePayload = vi.fn(
      (payload: unknown, request: Request, rawBody: string) =>
        new Response(
          JSON.stringify({
            method: request.method,
            payload,
            rawBody,
          }),
          { status: 202 },
        ),
    );
    const config = createConfig();
    const provider = new LocalMockProviderAdapter({
      codec: createGenericLocalMockTargetCodec("slack"),
      config,
      id: "provider-a",
      options: {
        authenticateWebhookRequest: authenticate,
        defaultWebhook: { host: "127.0.0.1", path: "/slack/events", port: 0 },
        endpointLabel: "events endpoint",
        handleWebhookPayload: handlePayload,
        platform: "slack",
      },
    });
    providers.push(provider);
    await provider.probe(createContext(config));

    const response = await handleRequest!(
      new Request("http://127.0.0.1:43210/slack/events?challenge=1", {
        ...(requestCase.body === undefined ? {} : { body: requestCase.body }),
        ...(requestCase.contentType
          ? { headers: { "content-type": requestCase.contentType } }
          : {}),
        method: requestCase.method,
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      method: requestCase.method,
      payload: requestCase.expectedPayload,
      rawBody: requestCase.expectedPayload,
    });
    expect(authenticate).toHaveBeenCalledWith(expect.any(Request), requestCase.expectedPayload);
    expect(handlePayload).toHaveBeenCalledWith(
      requestCase.expectedPayload,
      expect.any(Request),
      requestCase.expectedPayload,
    );
  });

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

  it("records empty webhook text instead of treating it as missing", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "empty-text.jsonl");
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
    await provider.probe(createContext(config));

    const response = await handleRequest!(
      new Request("http://127.0.0.1:43210/slack/events", {
        body: JSON.stringify({ text: "", threadId: "C1234567890" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse((await readFile(recorderPath, "utf8")).trim())).toMatchObject({
      text: "",
      threadId: "C1234567890",
    });
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

  it("drains webhook handlers admitted before cleanup", async () => {
    let handleRequest: ((request: Request) => Promise<Response>) | undefined;
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let reportAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => {
      reportAdmission = resolve;
    });
    const close = vi.fn(async () => undefined);
    webhookMocks.startWebhookServer.mockImplementationOnce(async (params) => {
      handleRequest = params.handle;
      return {
        close,
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
        async handleWebhookPayload() {
          reportAdmission();
          await handlerReleased;
          return new Response("accepted", { status: 202 });
        },
        platform: "slack",
      },
    });
    providers.push(provider);
    await provider.probe(createContext(config));

    const handling = handleRequest!(
      new Request("http://127.0.0.1:43210/slack/events", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    await admitted;
    let cleanupResolved = false;
    const cleanup = provider.cleanup().then(() => {
      cleanupResolved = true;
    });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(cleanupResolved).toBe(false);
    await expect(
      handleRequest!(
        new Request("http://127.0.0.1:43210/slack/events", {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      ),
    ).resolves.toMatchObject({ status: 503 });

    releaseHandler();
    await expect(handling).resolves.toMatchObject({ status: 202 });
    await expect(cleanup).resolves.toBeUndefined();
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

  it("keeps inbound and outbound records with the same provider id distinct", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "same-id-directions.jsonl");
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
    context.fixture.inboundMatch.author = "any";
    const sentAt = new Date().toISOString();
    for (const recordedDirection of ["outbound", "inbound"] as const) {
      await appendRecordedInbound(recorderPath, {
        author: recordedDirection === "outbound" ? "user" : "assistant",
        id: "shared-id",
        provider: "provider-a",
        recordedDirection,
        sentAt,
        text: recordedDirection,
        threadId: "slack:C1234567890",
      });
    }

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "direction",
        since: new Date(0).toISOString(),
        threadId: "slack:C1234567890",
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      id: "shared-id",
      recordedDirection: "inbound",
      text: "inbound",
    });
  });

  it("excludes inbound ids already consumed by the fixture runner", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "excluded-ids.jsonl");
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
    context.fixture.inboundMatch.author = "any";
    for (const id of ["original", "edit"]) {
      await appendRecordedInbound(recorderPath, {
        author: "user",
        id,
        provider: "provider-a",
        sentAt: new Date().toISOString(),
        text: id,
        threadId: "slack:C1234567890",
      });
    }

    await expect(
      provider.waitForInbound({
        ...context,
        excludeIds: ["original"],
        nonce: "edit",
        since: new Date(0).toISOString(),
        threadId: "slack:C1234567890",
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ id: "edit" });
  });

  it("persists incremental cursor progress after a timeout", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "timeout-progress.jsonl");
    const now = new Date().toISOString();
    await writeFile(
      recorderPath,
      Array.from(
        { length: 10_000 },
        (_, index) =>
          `${JSON.stringify({
            author: "user",
            id: `history-${index}`,
            provider: "provider-a",
            recordedAt: now,
            sentAt: now,
            text: "history",
            threadId: "slack:C1234567890",
          })}\n`,
      ).join(""),
      "utf8",
    );
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
    const context = {
      ...createContext(config),
      nonce: "timeout-progress",
      since: new Date(0).toISOString(),
      threadId: "slack:C1234567890",
      timeoutMs: 5,
    };

    const probeHandle = await open(recorderPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let phase = 0;
    const positions: number[][] = [[], []];
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      positions[phase]!.push(position ?? -1);
      const result = await originalRead.call(this, buffer, offset, length, position);
      await sleep(2);
      return result;
    };

    try {
      await expect(provider.waitForInbound(context)).resolves.toBeNull();
      phase = 1;
      await expect(provider.waitForInbound(context)).resolves.toBeNull();
      expect(positions[0]?.[0]).toBe(0);
      expect(positions[1]?.[0]).toBeGreaterThan(0);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });

  it("rejects canonical generic threads whose parent differs from the target channel", () => {
    const codec = createGenericLocalMockTargetCodec("loopback");

    expect(() =>
      codec.normalize({
        channelId: "room-a",
        id: "room-a",
        metadata: {},
        threadId: "loopback:room-b:topic",
      }),
    ).toThrow(/thread parent must match the target channel/u);
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

  it("prunes an overflow wait cursor as soon as it becomes inactive", async () => {
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
    const controllers = contexts.map(() => new AbortController());
    const waits = contexts.map((context, index) =>
      provider.waitForInbound({ ...context, signal: controllers[index]!.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "first-0",
      provider: "provider-a",
      sentAt: new Date().toISOString(),
      text: "first 0",
      threadId: contexts[0]!.threadId,
    });
    await expect(waits[0]).resolves.toMatchObject({ id: "first-0" });

    await expect(provider.waitForInbound(contexts[0]!)).resolves.toMatchObject({
      id: "first-0",
    });

    for (const controller of controllers.slice(1)) {
      controller.abort();
    }
    await expect(Promise.all(waits.slice(1))).resolves.toEqual(
      Array.from({ length: 64 }, () => null),
    );
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
