import { describe, expect, it } from "vitest";
import { normalizeZaloWebhookPayload, ZaloProviderAdapter } from "../src/providers/builtin/zalo.js";
import {
  createLocalMockConfig,
  createProviderContext,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

describe("Zalo webhook normalizer", () => {
  it("normalizes text messages with the provider message id", () => {
    const payload = {
      message: { msg_id: "zalo-msg-1", text: "hello" },
      sender: { id: "123456789012" },
    };

    expect(normalizeZaloWebhookPayload(payload)).toEqual({
      author: "user",
      id: "zalo-msg-1",
      raw: payload,
      text: "hello",
      threadId: "123456789012",
    });
  });

  it("normalizes wrapped native updates with chat identity", () => {
    const payload = {
      ok: true,
      result: {
        event_name: "message.text.received",
        message: {
          chat: { chat_type: "GROUP", id: "987654321012" },
          from: { display_name: "Alice", id: "123456789012", is_bot: false },
          message_id: "zalo-msg-native",
          text: "hello group",
        },
      },
    };

    expect(normalizeZaloWebhookPayload(payload)).toMatchObject({
      author: "user",
      id: "zalo-msg-native",
      text: "hello group",
      threadId: "987654321012",
    });
  });

  it.each([
    ["not-an-object", "Zalo webhook payload must be an object"],
    [{ sender: { id: "123456789012" }, message: {} }, "requires"],
    [{ message: { text: "hello" }, sender: { id: "invalid-id" } }, "native Zalo user or OA id"],
  ])("rejects malformed or invalid payloads: %s", (payload, message) => {
    expect(() => normalizeZaloWebhookPayload(payload)).toThrow(message);
  });

  it("preserves generic fallback thread payloads", () => {
    const payload = {
      authorIsBot: false,
      message: {
        raw: { source: "fallback" },
        text: "fallback text",
        threadId: "123456789012",
      },
    };

    expect(normalizeZaloWebhookPayload(payload)).toEqual({
      authorIsBot: false,
      message: {
        raw: { source: "fallback" },
        text: "fallback text",
        threadId: "123456789012",
      },
      raw: payload,
      threadId: "123456789012",
    });
  });

  it("requires the configured webhook secret before parsing", async () => {
    const config = await createLocalMockConfig("zalo", "/zalo/webhook");
    config.zalo!.webhookSecret = "test-token-placeholder";
    const provider = new ZaloProviderAdapter("zalo", config, "crabline");
    try {
      const probe = await provider.probe(
        createProviderContext("zalo", config, { id: "123456789012", metadata: {} }),
      );
      const endpoint = probe.details
        .find((detail) => detail.includes("http://"))
        ?.replace(/^.*?(https?:\/\/\S+)$/u, "$1");
      expect(endpoint).toBeDefined();

      const rejected = await fetch(endpoint!, {
        body: "{malformed",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(endpoint!, {
        body: JSON.stringify({
          message: { msg_id: "zalo-auth-1", text: "authenticated" },
          sender: { id: "123456789012" },
        }),
        headers: {
          "content-type": "application/json",
          "x-bot-api-secret-token": "test-token-placeholder",
        },
        method: "POST",
      });
      expect(accepted.status).toBe(200);
    } finally {
      await provider.cleanup();
    }
  });
});

runLocalMockProviderContract({
  Adapter: ZaloProviderAdapter,
  endpointPath: "/zalo/webhook",
  expectedChannelId: "123456789012",
  platform: "zalo",
  target: { id: "123456789012", metadata: {} },
  webhookExpected: { author: "user", id: "zalo-msg-1", text: "reply nonce-2" },
  webhookPayload: {
    message: { msg_id: "zalo-msg-1", text: "reply nonce-2" },
    sender: { id: "123456789012" },
  },
  webhookThreadId: "123456789012",
});
