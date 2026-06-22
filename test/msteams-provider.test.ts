import { MsTeamsProviderAdapter } from "../src/providers/builtin/msteams.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: MsTeamsProviderAdapter,
  endpointPath: "/msteams/webhook",
  expectedChannelId: "19:meeting_abc123@thread.v2",
  platform: "msteams",
  target: { id: "19:meeting_abc123@thread.v2", metadata: {} },
  webhookExpected: { author: "user", id: "teams-activity-1", text: "reply nonce-2" },
  webhookPayload: {
    conversation: { id: "19:meeting_abc123@thread.v2" },
    from: { role: "user" },
    id: "teams-activity-1",
    text: "reply nonce-2",
  },
  webhookThreadId: "19:meeting_abc123@thread.v2",
});
