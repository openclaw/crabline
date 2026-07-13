import { describe, expect, it } from "vitest";
import {
  MattermostProviderAdapter,
  matchesMattermostThread,
  normalizeMattermostWebhookPayload,
  resolveMattermostAdapterConfig,
} from "../src/providers/builtin/mattermost.js";
import { optionalStringish } from "../src/providers/builtin/native-local-mock.js";
import {
  createLocalMockConfig,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

describe("Mattermost webhook normalizer", () => {
  it("prefers MATTERMOST_URL while retaining the legacy base URL fallback", async () => {
    const config = await createLocalMockConfig("mattermost", "/mattermost/webhook");

    expect(
      resolveMattermostAdapterConfig(config, {
        MATTERMOST_BASE_URL: "https://legacy.example.test",
        MATTERMOST_URL: "https://current.example.test",
      }),
    ).toMatchObject({ baseUrl: "https://current.example.test" });
    expect(
      resolveMattermostAdapterConfig(config, {
        MATTERMOST_BASE_URL: "https://legacy.example.test",
      }),
    ).toMatchObject({ baseUrl: "https://legacy.example.test" });
  });

  it("rejects externally reachable webhooks without provider-native authentication", async () => {
    const config = await createLocalMockConfig("mattermost", "/mattermost/webhook");
    config.mattermost!.webhook.host = "0.0.0.0";
    expect(() => new MattermostProviderAdapter("mattermost", config, "crabline")).toThrow(
      /provider-native authenticated ingress mode/u,
    );

    config.mattermost!.webhook.host = "127.0.0.1";
    config.mattermost!.webhook.publicUrl = "https://mattermost.example.test/webhook";
    expect(() => new MattermostProviderAdapter("mattermost", config, "crabline")).toThrow(
      /provider-native authenticated ingress mode/u,
    );
  });

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
