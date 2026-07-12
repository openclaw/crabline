import {
  IMessageProviderAdapter,
  matchesIMessageThread,
} from "../src/providers/builtin/imessage.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";
import { describe, expect, it } from "vitest";

describe("iMessage thread matching", () => {
  it("matches GUID targets when payloads also provide a public recipient", () => {
    expect(
      matchesIMessageThread("+15551234567", "iMessage;-;chat-guid-1", {
        id: "+15551234567",
      }),
    ).toBe(true);
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
  webhookThreadId: "+15551234567",
});
