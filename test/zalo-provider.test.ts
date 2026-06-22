import { ZaloProviderAdapter } from "../src/providers/builtin/zalo.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

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
