import {
  IMessageProviderAdapter,
  matchesIMessageThread,
} from "../src/providers/builtin/imessage.js";
import {
  createLocalMockConfig,
  createProviderContext,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";
import { describe, expect, it } from "vitest";

describe("iMessage thread matching", () => {
  it("rejects externally reachable webhooks without provider-native authentication", async () => {
    const config = await createLocalMockConfig("imessage", "/imessage/webhook");
    config.imessage!.webhook.host = "0.0.0.0";
    expect(() => new IMessageProviderAdapter("imessage", config, "crabline")).toThrow(
      /provider-native authenticated ingress mode/u,
    );

    config.imessage!.webhook.host = "127.0.0.1";
    config.imessage!.webhook.publicUrl = "https://imessage.example.test/webhook";
    expect(() => new IMessageProviderAdapter("imessage", config, "crabline")).toThrow(
      /provider-native authenticated ingress mode/u,
    );
  });

  it("matches GUID targets when payloads also provide a public recipient", () => {
    expect(
      matchesIMessageThread(
        "iMessage;-;chat-guid-1",
        "+15551234567",
        {
          id: "+15551234567",
        },
        {
          chatGuid: "iMessage;-;chat-guid-1",
          chatIdentifier: "+15551234567",
        },
      ),
    ).toBe(true);
  });

  it("rejects unrelated GUIDs and recipient aliases", () => {
    expect(
      matchesIMessageThread(
        "iMessage;-;unrelated-guid",
        "+15551234567",
        {
          id: "+15551234567",
        },
        {
          chatGuid: "iMessage;-;unrelated-guid",
          chatIdentifier: "+15557654321",
        },
      ),
    ).toBe(false);
  });

  it("matches recipient targets while preserving the native chat GUID", async () => {
    const config = await createLocalMockConfig("imessage", "/imessage/webhook");
    const provider = new IMessageProviderAdapter("imessage", config, "crabline");
    const context = createProviderContext("imessage", config, {
      id: "+15551234567",
      metadata: {},
    });
    context.fixture.inboundMatch.author = "any";

    try {
      const endpoint = (await provider.probe(context)).details
        .find((detail) => detail.startsWith("webhook endpoint "))
        ?.replace("webhook endpoint ", "");
      expect(endpoint).toBeDefined();
      const since = new Date(Date.now() - 1000).toISOString();
      const response = await fetch(endpoint!, {
        body: JSON.stringify({
          chatGuid: "iMessage;-;chat-guid-1",
          chatIdentifier: "+15551234567",
          guid: "imsg-guid-alias",
          isFromMe: false,
          text: "recipient alias",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);

      await expect(
        provider.waitForInbound({
          ...context,
          nonce: "recipient-alias",
          since,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        id: "imsg-guid-alias",
        text: "recipient alias",
        threadId: "iMessage;-;chat-guid-1",
      });
    } finally {
      await provider.cleanup();
    }
  });

  it("matches aliases against a distinct normalized channel id", async () => {
    const config = await createLocalMockConfig("imessage", "/imessage/webhook");
    const provider = new IMessageProviderAdapter("imessage", config, "crabline");
    const context = createProviderContext("imessage", config, {
      channelId: "+15551234567",
      id: "fixture-contact",
      metadata: {},
      threadId: "iMessage;-;old-guid",
    });
    context.fixture.inboundMatch.author = "any";

    try {
      const endpoint = (await provider.probe(context)).details
        .find((detail) => detail.startsWith("webhook endpoint "))
        ?.replace("webhook endpoint ", "");
      expect(endpoint).toBeDefined();
      const waiting = provider.waitForInbound({
        ...context,
        nonce: "normalized-channel-alias",
        since: new Date(Date.now() - 1000).toISOString(),
        timeoutMs: 500,
      });
      const response = await fetch(endpoint!, {
        body: JSON.stringify({
          chatGuid: "iMessage;-;new-guid",
          chatIdentifier: "+15551234567",
          guid: "imsg-guid-channel-alias",
          text: "normalized channel alias",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(waiting).resolves.toMatchObject({
        id: "imsg-guid-channel-alias",
        threadId: "iMessage;-;new-guid",
      });
    } finally {
      await provider.cleanup();
    }
  });

  it("reports both accepted thread identifier fields for malformed payloads", async () => {
    const config = await createLocalMockConfig("imessage", "/imessage/webhook");
    const provider = new IMessageProviderAdapter("imessage", config, "crabline");
    const context = createProviderContext("imessage", config, {
      id: "+15551234567",
      metadata: {},
    });

    try {
      const endpoint = (await provider.probe(context)).details
        .find((detail) => detail.startsWith("webhook endpoint "))
        ?.replace("webhook endpoint ", "");
      const response = await fetch(endpoint!, {
        body: JSON.stringify({ text: "missing recipient" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toMatch(/chatGuid or chatIdentifier/u);
    } finally {
      await provider.cleanup();
    }
  });
});

runLocalMockProviderContract({
  Adapter: IMessageProviderAdapter,
  endpointPath: "/imessage/webhook",
  expectedChannelId: "+15551234567",
  expectedThreadId: "iMessage;-;chat-guid-1",
  platform: "imessage",
  target: { id: "+15551234567", metadata: {} },
  threadTarget: {
    channelId: "+15551234567",
    id: "+15551234567",
    metadata: {},
    threadId: "iMessage;-;chat-guid-1",
  },
  webhookExpected: { author: "user", id: "imsg-guid-1", text: "reply nonce-2" },
  webhookPayload: {
    chatIdentifier: "+15551234567",
    chatGuid: "iMessage;-;chat-guid-1",
    guid: "imsg-guid-1",
    isFromMe: false,
    text: "reply nonce-2",
  },
  webhookThreadId: "iMessage;-;chat-guid-1",
  userWebhookPayload: (nonce) => ({
    chatIdentifier: "+15551234567",
    chatGuid: "iMessage;-;chat-guid-1",
    guid: "imsg-user-inbound",
    isFromMe: false,
    text: `user ${nonce}`,
  }),
});
