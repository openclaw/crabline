import { describe, expect, it } from "vitest";
import {
  MattermostProviderAdapter,
  matchesMattermostThread,
  normalizeMattermostWebhookPayload,
} from "../src/providers/builtin/mattermost.js";
import { optionalStringish } from "../src/providers/builtin/native-local-mock.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

describe("Mattermost webhook normalizer", () => {
  it("preserves the channel when normalizing thread replies", () => {
    expect(
      normalizeMattermostWebhookPayload({
        channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        root_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
        text: "thread reply",
      }),
    ).toMatchObject({
      threadId: "aaaaaaaaaaaaaaaaaaaaaaaaaa:thread:bbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  it("matches local thread replies before native channel scoping", () => {
    expect(
      matchesMattermostThread("bbbbbbbbbbbbbbbbbbbbbbbbbb", "bbbbbbbbbbbbbbbbbbbbbbbbbb", {
        channelId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toBe(true);
  });

  it("rejects malformed native post ids", () => {
    expect(() =>
      normalizeMattermostWebhookPayload({
        channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        post_id: "invalid",
        text: "malformed post",
      }),
    ).toThrow(/Mattermost post_id/u);
  });
});

describe("native numeric ids", () => {
  it("rejects noninteger and unsafe numbers without altering exact values", () => {
    expect(optionalStringish({ id: 42 }, "id")).toBe("42");
    expect(optionalStringish({ id: 123456789012345678n }, "id")).toBe("123456789012345678");
    expect(optionalStringish({ id: "123456789012345678" }, "id")).toBe("123456789012345678");

    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(optionalStringish({ id }, "id")).toBeUndefined();
    }
  });
});

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
  webhookThreadId: "aaaaaaaaaaaaaaaaaaaaaaaaaa:thread:bbbbbbbbbbbbbbbbbbbbbbbbbb",
});
