import { FeishuProviderAdapter } from "../src/providers/builtin/feishu.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

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
  webhookThreadId: "om_abc123",
});
