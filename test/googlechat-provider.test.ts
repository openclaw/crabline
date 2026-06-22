import { GoogleChatProviderAdapter } from "../src/providers/builtin/googlechat.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: GoogleChatProviderAdapter,
  endpointPath: "/googlechat/webhook",
  expectedChannelId: "spaces/AAAABbbbCCC",
  expectedThreadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
  platform: "googlechat",
  target: { id: "spaces/AAAABbbbCCC", metadata: {} },
  threadTarget: {
    channelId: "spaces/AAAABbbbCCC",
    id: "spaces/AAAABbbbCCC",
    metadata: {},
    threadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
  },
  webhookExpected: {
    author: "user",
    id: "spaces/AAAABbbbCCC/messages/msg-1",
    text: "reply nonce-2",
  },
  webhookPayload: {
    message: {
      name: "spaces/AAAABbbbCCC/messages/msg-1",
      sender: { type: "HUMAN" },
      space: { name: "spaces/AAAABbbbCCC" },
      text: "reply nonce-2",
      thread: { name: "spaces/AAAABbbbCCC/threads/BBBBccccDDD" },
    },
  },
  webhookThreadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
});
