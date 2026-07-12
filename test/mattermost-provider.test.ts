import { describe, expect, it } from "vitest";
import {
  MattermostProviderAdapter,
  matchesMattermostThread,
  normalizeMattermostWebhookPayload,
} from "../src/providers/builtin/mattermost.js";
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
