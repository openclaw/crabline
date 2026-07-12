import { describe, expect, it } from "vitest";
import {
  MatrixProviderAdapter,
  matchesMatrixThread,
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

    expect(normalizeMatrixWebhookPayload(payload, "@bot:matrix.org")).toMatchObject({
      author: "user",
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

    expect(normalizeMatrixWebhookPayload(payload, "@bot:matrix.org")).toMatchObject({
      id: "$reply123:matrix.org",
      threadId: "!abc123:matrix.org:thread:$root123:matrix.org",
    });
  });

  it("attributes events from the configured Matrix user to the assistant", () => {
    expect(
      normalizeMatrixWebhookPayload(
        {
          content: { body: "bot reply", msgtype: "m.text" },
          event_id: "$bot123:matrix.org",
          room_id: "!abc123:matrix.org",
          sender: "@bot:matrix.org",
          type: "m.room.message",
        },
        "@bot:matrix.org",
      ),
    ).toMatchObject({ author: "assistant" });
  });

  it("matches local thread replies before native room scoping", () => {
    expect(
      matchesMatrixThread("$event123:matrix.org", "$event123:matrix.org", {
        channelId: "!abc123:matrix.org",
      }),
    ).toBe(true);
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
