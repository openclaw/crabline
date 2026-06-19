import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTelegramAdapterConfig,
  TelegramProviderAdapter,
} from "../src/providers/builtin/telegram.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const providers: TelegramProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createTelegramConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "telegram",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "telegram",
    status: "active",
    telegram: {
      mode: "webhook",
      recorder: { path: path.join(directory, "telegram.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/telegram/webhook",
        port,
      },
    },
  };
}

function createContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "telegram-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "telegram",
      retries: 0,
      tags: [],
      target: {
        id: "123456789",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "telegram",
    userName: "crabline",
  };
}

describe("telegram provider", () => {
  it("resolves local mock config from provider settings and env", () => {
    expect(
      resolveTelegramAdapterConfig(
        {
          adapter: "telegram",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "telegram",
          status: "active",
          telegram: {
            mode: "polling",
            recorder: {},
            webhook: { host: "127.0.0.1", path: "/telegram/webhook", port: 8790 },
          },
        },
        {
          TELEGRAM_API_BASE_URL: "http://127.0.0.1:19090",
          TELEGRAM_BOT_USERNAME: "crabline_bot",
          TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
        },
      ),
    ).toMatchObject({
      apiUrl: "http://127.0.0.1:19090",
      mode: "polling",
      secretToken: "secret",
      userName: "crabline_bot",
    });
  });

  it("normalizes chat and topic targets", async () => {
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "-100123", metadata: {} })).toMatchObject({
      channelId: "telegram:-100123",
    });
    expect(
      provider.normalizeTarget({
        channelId: "telegram:-100123",
        id: "topic",
        metadata: {},
        threadId: "42",
      }),
    ).toMatchObject({
      channelId: "telegram:-100123",
      threadId: "telegram:-100123:42",
    });
  });

  it("probes and sends through the local mock service", async () => {
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("telegram local mock ready");
    expect(probe.details.join("\n")).toContain("webhook endpoint http://127.0.0.1:");
    expect(probe.details.join("\n")).toContain("channel reachable telegram:123456789");

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello nonce-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("telegram:123456789");

    await expect(
      provider.waitForInbound({
        ...createContext(config),
        nonce: "nonce-1",
        since: new Date(Date.now() - 1000).toISOString(),
        threadId: result.threadId,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      author: "assistant",
      text: expect.stringContaining("nonce-1"),
    });
  });

  it("records webhook inbound events", async () => {
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "telegram:123456789",
      timeoutMs: 500,
    });

    const response = await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "telegram:123456789",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-1",
      text: "ACK nonce-2",
    });
  });

  it("returns channel-like webhook errors for malformed inbound events", async () => {
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const response = await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({ message: { id: "evt-bad", text: "missing thread" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("threadId");
  });
});
