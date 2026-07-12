import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeTelegramWebhookPayload,
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

async function createTelegramConfig(port: number, secretToken?: string): Promise<ProviderConfig> {
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
      ...(secretToken ? { secretToken } : {}),
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
      channelId: "-100123",
    });
    expect(
      provider.normalizeTarget({
        channelId: "-100123",
        id: "topic",
        metadata: {},
        threadId: "42",
      }),
    ).toMatchObject({
      channelId: "-100123",
      threadId: "-100123:42",
    });
    expect(() =>
      provider.normalizeTarget({
        channelId: "-100999",
        id: "topic",
        metadata: {},
        threadId: "-100123:42",
      }),
    ).toThrow("Telegram canonical topic chat_id must match the target chat_id.");
    expect(() =>
      provider.normalizeTarget({
        id: "-100999",
        metadata: {},
        threadId: "-100123:42",
      }),
    ).toThrow("Telegram canonical topic chat_id must match the target chat_id.");
    expect(
      provider.normalizeTarget({
        channelId: "-100123",
        id: "topic",
        metadata: {},
        threadId: "-100123:42",
      }),
    ).toMatchObject({
      channelId: "-100123",
      threadId: "-100123:42",
    });
    expect(() => provider.normalizeTarget({ id: "telegram:-100123", metadata: {} })).toThrow(
      /Telegram chat_id/u,
    );
  });

  it("isolates identical topic ids across Telegram chats", () => {
    const first = normalizeTelegramWebhookPayload({
      message: {
        chat: { id: "-1001" },
        message_thread_id: 42,
        text: "chat one",
      },
    });
    const second = normalizeTelegramWebhookPayload({
      message: {
        chat: { id: "-1002" },
        message_thread_id: 42,
        text: "chat two",
      },
    });

    const firstThreadId = (first as { threadId?: string }).threadId;
    const secondThreadId = (second as { threadId?: string }).threadId;
    expect(firstThreadId).toBe("-1001:42");
    expect(secondThreadId).toBe("-1002:42");
    expect(firstThreadId).not.toBe(secondThreadId);
  });

  it("round-trips canonical topic ids through generic ingress", () => {
    const topLevel = {
      authorIsBot: true,
      id: "generic-1",
      text: "generic topic reply",
      threadId: "-100123:42",
    };
    expect(normalizeTelegramWebhookPayload(topLevel)).toMatchObject({
      id: "generic-1",
      raw: topLevel,
      text: "generic topic reply",
      threadId: "-100123:42",
    });

    const nested = {
      message: {
        authorIsBot: true,
        id: "generic-2",
        text: "nested topic reply",
        threadId: "-100123:42",
      },
    };
    expect(normalizeTelegramWebhookPayload(nested)).toMatchObject({
      raw: nested,
      threadId: "-100123:42",
      message: {
        id: "generic-2",
        text: "nested topic reply",
        threadId: "-100123:42",
      },
    });
  });

  it("normalizes edited channel posts", () => {
    const payload = {
      edited_channel_post: {
        caption: "edited caption",
        chat: { id: -1001234567890 },
        message_id: 42,
      },
      update_id: 99,
    };

    expect(normalizeTelegramWebhookPayload(payload)).toEqual({
      author: "user",
      id: "42",
      raw: payload,
      text: "edited caption",
      threadId: "-1001234567890",
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
    expect(probe.details.join("\n")).toContain("channel reachable 123456789");

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello nonce-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("123456789");

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
      threadId: "123456789",
      timeoutMs: 500,
    });

    const response = await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          from: { is_bot: true },
          message_id: 1,
          text: "ACK nonce-2",
        },
        update_id: 2,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waitPromise).resolves.toMatchObject({
      id: "1",
      text: "ACK nonce-2",
    });
  });

  it("authenticates webhook requests before parsing", async () => {
    const config = await createTelegramConfig(0, "telegram-webhook-secret");
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();
    const url = endpoint!.replace("webhook endpoint ", "");

    const rejected = await fetch(url, {
      body: "{malformed",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(url, {
      body: JSON.stringify({
        message: { chat: { id: 123456789 }, message_id: 3, text: "authenticated" },
      }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      method: "POST",
    });
    expect(accepted.status).toBe(200);
  });

  it("returns channel-like webhook errors for malformed inbound events", async () => {
    const config = await createTelegramConfig(0);
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const response = await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({ message: { message_id: 1, text: "missing thread" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("message.chat.id");
  });
});
