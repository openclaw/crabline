import { MattermostProviderAdapter } from "../src/providers/builtin/mattermost.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: MattermostProviderAdapter,
  endpointPath: "/mattermost/webhook",
  expectedChannelId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
  expectedThreadId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
  platform: "mattermost",
  target: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaa", metadata: {} },
  threadTarget: {
    channelId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
    metadata: {},
    threadId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  webhookExpected: { author: "user", id: "cccccccccccccccccccccccccc", text: "reply nonce-2" },
  webhookPayload: {
    channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
    post_id: "cccccccccccccccccccccccccc",
    root_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
    text: "reply nonce-2",
  },
  webhookThreadId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
});
