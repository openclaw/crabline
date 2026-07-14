import { once } from "node:events";
import { connect } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("confines generated recorder paths for provider IDs", async () => {
    const config = await createTelegramConfig(0);
    config.telegram!.recorder = {};

    expect(() => new TelegramProviderAdapter("../escape", config, "crabline")).toThrow(
      /Provider ID cannot contain absolute or parent-directory paths/u,
    );
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
    expect(() => provider.normalizeTarget({ id: String(1n << 52n), metadata: {} })).toThrow(
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

  it("rejects outbound-only usernames in native inbound chat identities", () => {
    expect(() =>
      normalizeTelegramWebhookPayload({
        message: {
          chat: { id: "@channelusername" },
          message_id: 1,
          text: "invalid inbound username",
        },
        update_id: 1,
      }),
    ).toThrow(/Telegram inbound chat id/u);
  });

  it("round-trips canonical topic ids through generic ingress", () => {
    const topLevel = {
      authorIsBot: true,
      channelId: "-100123",
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
        channelId: "-100123",
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

    const topLevelFallback = {
      message: {
        authorIsBot: true,
        channelId: "-100123",
        id: "generic-3",
        text: "top-level topic fallback",
      },
      threadId: "-100123:43",
    };
    expect(normalizeTelegramWebhookPayload(topLevelFallback)).toMatchObject({
      raw: topLevelFallback,
      threadId: "-100123:43",
      message: {
        id: "generic-3",
        text: "top-level topic fallback",
        threadId: "-100123:43",
      },
    });

    const nestedWins = {
      message: {
        channelId: "-100123",
        text: "nested topic wins",
        threadId: "-100123:44",
      },
      threadId: "-100123:45",
    };
    expect(normalizeTelegramWebhookPayload(nestedWins)).toMatchObject({
      threadId: "-100123:44",
      message: { threadId: "-100123:44" },
    });

    const bareTopLevel = {
      channelId: "-100123",
      text: "bare top-level topic",
      threadId: "46",
    };
    expect(normalizeTelegramWebhookPayload(bareTopLevel)).toMatchObject({
      raw: bareTopLevel,
      text: "bare top-level topic",
      threadId: "-100123:46",
    });

    const bareNested = {
      message: {
        channelId: "-100124",
        text: "bare nested topic",
        threadId: "46",
      },
    };
    expect(normalizeTelegramWebhookPayload(bareNested)).toMatchObject({
      raw: bareNested,
      threadId: "-100124:46",
      message: {
        text: "bare nested topic",
        threadId: "-100124:46",
      },
    });

    expect(() =>
      normalizeTelegramWebhookPayload({
        text: "ambiguous bare topic",
        threadId: "46",
      }),
    ).toThrow(/bare topic IDs require an inbound channelId/u);

    expect(() =>
      normalizeTelegramWebhookPayload({
        channelId: "-100999",
        message: {
          text: "wrong top-level channel",
          threadId: "-100123:42",
        },
      }),
    ).toThrow(/must match the inbound channelId/u);
    expect(() =>
      normalizeTelegramWebhookPayload({
        message: {
          channelId: "-100999",
          text: "wrong nested channel",
          threadId: "-100123:42",
        },
      }),
    ).toThrow(/must match the inbound channelId/u);
    expect(() =>
      normalizeTelegramWebhookPayload({
        channelId: "-100998",
        message: {
          channelId: "-100999",
          text: "conflicting channels",
          threadId: "42",
        },
      }),
    ).toThrow(/channelId values must match/u);
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

  it("canonicalizes equal generic chat and topic ids", () => {
    const payload = {
      authorIsBot: true,
      channelId: "42",
      id: "generic-equal-topic",
      text: "equal topic",
      threadId: "42",
    };

    expect(normalizeTelegramWebhookPayload(payload)).toMatchObject({
      id: "generic-equal-topic",
      raw: payload,
      text: "equal topic",
      threadId: "42:42",
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

    const since = new Date(Date.now() - 1000).toISOString();
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
        since,
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
    const config = await createTelegramConfig(0, "test-token-placeholder");
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
        "x-telegram-bot-api-secret-token": "test-token-placeholder",
      },
      method: "POST",
    });
    expect(accepted.status).toBe(200);
  });

  it("rejects unauthenticated webhook headers before reading the request body", async () => {
    const config = await createTelegramConfig(0, "test-token-placeholder");
    const provider = new TelegramProviderAdapter("telegram", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = new URL(
      probe.details
        .find((detail) => detail.startsWith("webhook endpoint "))!
        .replace("webhook endpoint ", ""),
    );
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk;
    });
    await once(socket, "connect");
    socket.write(
      [
        `POST ${endpoint.pathname} HTTP/1.1`,
        `Host: ${endpoint.host}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "",
        "{",
      ].join("\r\n"),
    );

    await vi.waitFor(() => expect(response).toContain("401 Unauthorized"));
    socket.destroy();
  });

  it("rejects header-unsafe webhook secrets from the environment", async () => {
    const config = await createTelegramConfig(0);
    for (const secretToken of ["", "unsafe\n", ["unsafe", "\r\n", "value"].join("")]) {
      expect(
        () =>
          new TelegramProviderAdapter("telegram", config, "crabline", {
            env: { TELEGRAM_WEBHOOK_SECRET_TOKEN: secretToken },
          }),
      ).toThrow(/Telegram secretToken/u);
    }
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
