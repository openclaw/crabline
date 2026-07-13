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
  createProviderContext,
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

  it("rejects bearer credentials over non-loopback cleartext transport", async () => {
    const config = await createLocalMockConfig("mattermost", "/mattermost/webhook");

    expect(() =>
      resolveMattermostAdapterConfig(config, {
        MATTERMOST_URL: "http://mattermost.example.test",
      }),
    ).toThrow(/requires HTTPS/u);
    expect(
      () =>
        new MattermostProviderAdapter(
          "mattermost",
          {
            ...config,
            mattermost: {
              ...config.mattermost!,
              baseUrl: "http://192.0.2.1",
            },
          },
          "crabline",
        ),
    ).toThrow(/requires HTTPS/u);
    expect(
      resolveMattermostAdapterConfig(config, {
        MATTERMOST_URL: "http://127.0.0.1:8065",
      }),
    ).toMatchObject({ baseUrl: "http://127.0.0.1:8065" });
  });

  it("accepts provider-native form-encoded outgoing webhooks", async () => {
    const config = await createLocalMockConfig("mattermost", "/mattermost/webhook");
    const provider = new MattermostProviderAdapter("mattermost", config, "crabline");
    const context = createProviderContext("mattermost", config, {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      metadata: {},
    });
    context.fixture.inboundMatch = {
      author: "user",
      nonce: "contains",
      strategy: "contains",
    };
    try {
      const probe = await provider.probe(context);
      const endpoint = probe.details
        .find((detail) => detail.includes("webhook endpoint"))!
        .replace(/^.*?(https?:\/\/\S+)$/u, "$1");
      const since = new Date(Date.now() - 1_000).toISOString();
      const response = await fetch(endpoint, {
        body: new URLSearchParams({
          channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          post_id: "cccccccccccccccccccccccccc",
          root_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
          text: "form webhook nonce",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect(
        provider.waitForInbound({
          ...context,
          nonce: "form webhook nonce",
          since,
          threadId: "aaaaaaaaaaaaaaaaaaaaaaaaaa:thread:bbbbbbbbbbbbbbbbbbbbbbbbbb",
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        author: "user",
        id: "cccccccccccccccccccccccccc",
        text: "form webhook nonce",
      });
    } finally {
      await provider.cleanup();
    }
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

  it("normalizes root posts to the channel target instead of their post id", () => {
    expect(
      normalizeMattermostWebhookPayload({
        channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        post_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
        root_id: "",
        text: "root post",
      }),
    ).toMatchObject({
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      threadId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
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
  userWebhookPayload: (nonce) => ({
    channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
    post_id: "dddddddddddddddddddddddddd",
    root_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
    text: `user ${nonce}`,
  }),
});
