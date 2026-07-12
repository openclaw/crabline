import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManifestDefinition, ProviderConfig } from "../src/config/schema.js";
import { runFixtureCommand } from "../src/core/run.js";
import { SlackProviderAdapter } from "../src/providers/builtin/slack.js";
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
});
