import { MsTeamsProviderAdapter } from "../src/providers/builtin/msteams.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

const conversationId = "a:opaque-conversation-id";

runLocalMockProviderContract({
  Adapter: MsTeamsProviderAdapter,
  endpointPath: "/msteams/webhook",
  expectedChannelId: conversationId,
  invalidTargets: [{ id: "", metadata: {} }],
  platform: "msteams",
  target: { id: conversationId, metadata: {} },
  webhookExpected: { author: "user", id: "teams-activity-1", text: "reply nonce-2" },
  webhookPayload: {
    conversation: { id: conversationId },
    from: { role: "user" },
    id: "teams-activity-1",
    text: "reply nonce-2",
  },
  webhookThreadId: conversationId,
});
