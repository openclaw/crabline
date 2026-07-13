import { describe, expect, it } from "vitest";
import { normalizeZaloWebhookPayload, ZaloProviderAdapter } from "../src/providers/builtin/zalo.js";
import {
  normalizeBuiltinTarget,
  ZALO_UNSUPPORTED_THREAD_TARGET_ERROR,
} from "../src/providers/target-normalizers.js";
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

  it("normalizes direct native webhook updates with chat identity", () => {
    const payload = {
      event_name: "message.text.received",
      message: {
        chat: { chat_type: "GROUP", id: "987654321012" },
        from: { display_name: "Alice", id: "123456789012", is_bot: false },
        message_id: "zalo-msg-native",
        text: "hello group",
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
    ["captioned", "image caption", "image caption"],
    ["missing-caption", undefined, "https://cdn.example.test/zalo/photo-1.jpg"],
    ["empty-caption", "", "https://cdn.example.test/zalo/photo-1.jpg"],
  ])("normalizes %s native image callbacks", (_label, caption, expectedText) => {
    const payload = {
      event_name: "message.image.received",
      message: {
        ...(caption === undefined ? {} : { caption }),
        chat: { chat_type: "PRIVATE", id: "987654321012" },
        from: { display_name: "Alice", id: "123456789012", is_bot: false },
        message_id: "zalo-image-native",
        photo_url: "https://cdn.example.test/zalo/photo-1.jpg",
      },
    };

    expect(normalizeZaloWebhookPayload(payload)).toMatchObject({
      author: "user",
      id: "zalo-image-native",
      raw: payload,
      text: expectedText,
      threadId: "987654321012",
    });
  });

  it.each([
    ["not-an-object", "Zalo webhook payload must be an object"],
    [{ sender: { id: "123456789012" }, message: {} }, "requires"],
    [{ message: { text: "hello" }, sender: { id: "" } }, "requires"],
    [
      {
        event_name: "message.image.received",
        message: {
          caption: "missing image",
          chat: { id: "987654321012" },
          from: { id: "123456789012" },
        },
      },
      "requires",
    ],
  ])("rejects malformed or invalid payloads: %s", (payload, message) => {
    expect(() => normalizeZaloWebhookPayload(payload)).toThrow(message);
  });

  it("accepts provider-native opaque string targets", async () => {
    const config = await createLocalMockConfig("zalo", "/zalo/webhook");
    const provider = new ZaloProviderAdapter("zalo", config, "crabline");
    try {
      expect(provider.normalizeTarget({ id: "user-1", metadata: {} })).toMatchObject({
        channelId: "user-1",
      });
    } finally {
      await provider.cleanup();
    }
  });

  it("rejects unsupported thread targets during normalization", () => {
    expect(() =>
      normalizeBuiltinTarget("zalo", {
        id: "user-1",
        metadata: {},
        threadId: "message-1",
      }),
    ).toThrow(ZALO_UNSUPPORTED_THREAD_TARGET_ERROR);
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

  it("normalizes the documented top-level generic payload", () => {
    const payload = {
      author: "user",
      id: "zalo-generic-1",
      text: "top-level fallback",
      threadId: "123456789012",
    };

    expect(normalizeZaloWebhookPayload(payload)).toEqual({
      author: "user",
      id: "zalo-generic-1",
      raw: payload,
      text: "top-level fallback",
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
          event_name: "message.image.received",
          message: {
            chat: { chat_type: "PRIVATE", id: "123456789012" },
            from: { id: "123456789012", is_bot: false },
            message_id: "zalo-auth-1",
            photo_url: "https://cdn.example.test/zalo/authenticated.jpg",
          },
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

  it("uses the constructor runtime environment for webhook authentication", async () => {
    const config = await createLocalMockConfig("zalo", "/zalo/webhook");
    const provider = new ZaloProviderAdapter("zalo", config, "crabline", {
      env: { ZALO_WEBHOOK_SECRET: "test-token-placeholder" },
    });
    try {
      const probe = await provider.probe(
        createProviderContext("zalo", config, { id: "123456789012", metadata: {} }),
      );
      const endpoint = probe.details
        .find((detail) => detail.includes("http://"))
        ?.replace(/^.*?(https?:\/\/\S+)$/u, "$1");
      expect(endpoint).toBeDefined();

      const payload = {
        message: { msg_id: "zalo-runtime-1", text: "authenticated" },
        sender: { id: "123456789012" },
      };
      const rejected = await fetch(endpoint!, {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(endpoint!, {
        body: JSON.stringify(payload),
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
  expectedChannelId: "user-1",
  invalidTargets: [
    { id: "", metadata: {} },
    { id: "   ", metadata: {} },
  ],
  platform: "zalo",
  target: { id: "user-1", metadata: {} },
  webhookExpected: { author: "user", id: "zalo-msg-1", text: "reply nonce-2" },
  webhookPayload: {
    message: { msg_id: "zalo-msg-1", text: "reply nonce-2" },
    sender: { id: "user-1" },
  },
  webhookThreadId: "user-1",
  userWebhookPayload: (nonce) => ({
    message: { msg_id: "zalo-user-inbound", text: `user ${nonce}` },
    sender: { id: "user-1" },
  }),
});
