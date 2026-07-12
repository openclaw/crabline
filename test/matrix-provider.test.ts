import { describe, expect, it } from "vitest";
import {
  MatrixProviderAdapter,
  normalizeMatrixWebhookPayload,
} from "../src/providers/builtin/matrix.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

describe("Matrix webhook normalizer", () => {
  it("uses the room for main-timeline events", () => {
    const payload = {
      content: { body: "hello", msgtype: "m.text" },
      event_id: "$event123:matrix.org",
      room_id: "!abc123:matrix.org",
      type: "m.room.message",
    };

    expect(normalizeMatrixWebhookPayload(payload)).toMatchObject({
      id: "$event123:matrix.org",
      threadId: "!abc123:matrix.org",
    });
  });

  it("uses the m.thread root event for threaded events", () => {
    const payload = {
      content: {
        body: "thread reply",
        "m.relates_to": {
          event_id: "$root123:matrix.org",
          rel_type: "m.thread",
        },
        msgtype: "m.text",
      },
      event_id: "$reply123:matrix.org",
      room_id: "!abc123:matrix.org",
      type: "m.room.message",
    };

    expect(normalizeMatrixWebhookPayload(payload)).toMatchObject({
      id: "$reply123:matrix.org",
      threadId: "$root123:matrix.org",
    });
  });
});

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
  webhookThreadId: "!abc123:matrix.org",
});
