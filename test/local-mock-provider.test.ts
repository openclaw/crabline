import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../src/config/schema.js";
import { SlackProviderAdapter } from "../src/providers/builtin/slack.js";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const webhookMocks = vi.hoisted(() => ({
  startWebhookServer: vi.fn(),
}));

vi.mock("../src/providers/webhook-server.js", () => ({
  startWebhookServer: webhookMocks.startWebhookServer,
}));

const directories: string[] = [];
const providers: SlackProviderAdapter[] = [];

beforeEach(() => {
  webhookMocks.startWebhookServer.mockReset();
  webhookMocks.startWebhookServer.mockResolvedValue({
    async close() {},
    endpointUrl: "http://127.0.0.1:0/slack/events",
  });
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
});
