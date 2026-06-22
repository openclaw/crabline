import { MatrixProviderAdapter } from "../src/providers/builtin/matrix.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: MatrixProviderAdapter,
  endpointPath: "/matrix/webhook",
  expectedChannelId: "!abc123:matrix.org",
  expectedThreadId: "$event123:matrix.org",
  platform: "matrix",
  target: { id: "!abc123:matrix.org", metadata: {} },
  threadTarget: {
    channelId: "!abc123:matrix.org",
    id: "!abc123:matrix.org",
    metadata: {},
    threadId: "$event123:matrix.org",
  },
  webhookExpected: { author: "user", id: "$event123:matrix.org", text: "reply nonce-2" },
  webhookPayload: {
    content: { body: "reply nonce-2", msgtype: "m.text" },
    event_id: "$event123:matrix.org",
    room_id: "!abc123:matrix.org",
    sender: "@user:matrix.org",
    type: "m.room.message",
  },
  webhookThreadId: "$event123:matrix.org",
});
