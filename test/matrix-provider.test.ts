import { describe, expect, it } from "vitest";
import {
  MatrixProviderAdapter,
  matchesMatrixThread,
  normalizeMatrixWebhookPayload,
} from "../src/providers/builtin/matrix.js";
import {
  createLocalMockConfig,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

describe("Matrix webhook normalizer", () => {
  it("accepts Matrix v12 domainless room ids through the shared target codec", async () => {
    const config = await createLocalMockConfig("matrix", "/matrix/webhook");
    const provider = new MatrixProviderAdapter("matrix", config, "crabline");
    const roomId = `!${Buffer.alloc(32, 0xab).toString("base64url")}`;

    expect(provider.normalizeTarget({ id: roomId, metadata: {} })).toMatchObject({
      channelId: roomId,
    });
    await provider.cleanup();
  });

  it("rejects externally reachable webhooks without native authentication", async () => {
    const config = await createLocalMockConfig("matrix", "/matrix/webhook");
    config.matrix!.webhook.host = "0.0.0.0";
    expect(() => new MatrixProviderAdapter("matrix", config, "crabline")).toThrow(
      /provider-native authenticated ingress mode/u,
    );
  });

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

  it("requires native event identity, type, and thread roots", () => {
    expect(() =>
      normalizeMatrixWebhookPayload({
        content: { body: "missing id", msgtype: "m.text" },
        room_id: "!abc123:matrix.org",
        type: "m.room.message",
      }),
    ).toThrow(/event_id/u);
    expect(() =>
      normalizeMatrixWebhookPayload({
        content: { body: "wrong type", msgtype: "m.text" },
        event_id: "$event123:matrix.org",
        room_id: "!abc123:matrix.org",
        type: "m.reaction",
      }),
    ).toThrow(/type=m\.room\.message/u);
    expect(() =>
      normalizeMatrixWebhookPayload({
        content: {
          body: "missing root",
          "m.relates_to": { rel_type: "m.thread" },
          msgtype: "m.text",
        },
        event_id: "$event123:matrix.org",
        room_id: "!abc123:matrix.org",
        type: "m.room.message",
      }),
    ).toThrow(/m\.thread relation requires event_id/u);
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
