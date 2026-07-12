import { describe, expect, it } from "vitest";
import {
  FeishuProviderAdapter,
  normalizeFeishuWebhookPayload,
} from "../src/providers/builtin/feishu.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

describe("Feishu webhook normalizer", () => {
  it("uses the chat for ordinary messages and preserves message_id as the event id", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "hello" }),
          message_id: "om_message123",
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
          root_id: "om_root123",
        },
      },
    };

    expect(normalizeFeishuWebhookPayload(payload)).toMatchObject({
      id: "om_reply123",
      threadId: "om_root123",
    });
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
      },
    },
  },
  webhookThreadId: "oc_abc123",
});
