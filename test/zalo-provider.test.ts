import { describe, expect, it } from "vitest";
import { normalizeZaloWebhookPayload, ZaloProviderAdapter } from "../src/providers/builtin/zalo.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

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
