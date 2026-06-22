import { IMessageProviderAdapter } from "../src/providers/builtin/imessage.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: IMessageProviderAdapter,
  endpointPath: "/imessage/webhook",
  expectedChannelId: "+15551234567",
  expectedThreadId: "iMessage;-;chat-guid-1",
  platform: "imessage",
  target: { id: "+15551234567", metadata: {} },
  threadTarget: {
    channelId: "+15551234567",
    id: "+15551234567",
    metadata: {},
    threadId: "iMessage;-;chat-guid-1",
  },
  webhookExpected: { author: "user", id: "imsg-guid-1", text: "reply nonce-2" },
  webhookPayload: {
    chatGuid: "iMessage;-;chat-guid-1",
    guid: "imsg-guid-1",
    isFromMe: false,
    text: "reply nonce-2",
  },
  webhookThreadId: "iMessage;-;chat-guid-1",
});
