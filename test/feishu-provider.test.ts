import { describe, expect, it } from "vitest";
import {
  FeishuProviderAdapter,
  handleFeishuWebhookPayload,
  normalizeFeishuWebhookPayload,
} from "../src/providers/builtin/feishu.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

describe("Feishu webhook normalizer", () => {
  it("answers URL verification challenges", async () => {
    const response = handleFeishuWebhookPayload({
      challenge: "challenge-token",
      type: "url_verification",
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ challenge: "challenge-token" });
  });

  it("uses the chat for ordinary messages and preserves message_id as the event id", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "hello" }),
          message_id: "om_message123",
          message_type: "text",
        },
      },
    };

    expect(normalizeFeishuWebhookPayload(payload)).toMatchObject({
      id: "om_message123",
      threadId: "oc_abc123",
    });
  });

  it("uses root_id for topic replies", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "topic reply" }),
          message_id: "om_reply123",
          message_type: "text",
          root_id: "om_root123",
        },
      },
    };

    expect(normalizeFeishuWebhookPayload(payload)).toMatchObject({
      id: "om_reply123",
      threadId: "om_root123",
    });
  });

  it("rejects non-text native messages", () => {
    expect(() =>
      normalizeFeishuWebhookPayload({
        event: {
          message: {
            chat_id: "oc_abc123",
            content: JSON.stringify({ text: "not really text" }),
            message_id: "om_message123",
            message_type: "image",
          },
        },
      }),
    ).toThrow(/message_type=text/u);
  });
});

runLocalMockProviderContract({
  Adapter: FeishuProviderAdapter,
  endpointPath: "/feishu/webhook",
  expectedChannelId: "oc_abc123",
  expectedThreadId: "om_abc123",
  platform: "feishu",
  target: { id: "oc_abc123", metadata: {} },
  threadTarget: {
    channelId: "oc_abc123",
    id: "oc_abc123",
    metadata: {},
    threadId: "om_abc123",
  },
  webhookExpected: { author: "user", id: "om_abc123", text: "reply nonce-2" },
  webhookPayload: {
    event: {
      message: {
        chat_id: "oc_abc123",
        content: JSON.stringify({ text: "reply nonce-2" }),
        message_id: "om_abc123",
        message_type: "text",
      },
    },
  },
  webhookThreadId: "oc_abc123",
});
