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
});
