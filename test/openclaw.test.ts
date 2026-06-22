import { describe, expect, it } from "vitest";
import {
  createOpenClawCrablineAgentDelivery,
  createOpenClawCrablineFakeProviderBinding,
  createOpenClawCrablineInbound,
  createOpenClawCrablineOutboundFromRecorderEvent,
  startOpenClawCrablineAdapter,
  type CrablineFakeProviderManifest,
} from "../src/index.js";

const manifest: CrablineFakeProviderManifest = {
  baseUrl: "http://127.0.0.1:1234",
  botToken: "424242:crabline-telegram-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:1234/crabline/telegram/inbound",
    apiRoot: "http://127.0.0.1:1234",
  },
  env: {
    TELEGRAM_BOT_TOKEN: "424242:crabline-telegram-token",
  },
  provider: "telegram",
  recorderPath: "/tmp/crabline/telegram.jsonl",
  version: 1,
};

describe("OpenClaw fake provider bridge", () => {
  it("maps a Telegram fake provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineFakeProviderBinding(manifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "telegram",
      requiredPluginIds: ["telegram"],
    });
    expect(binding.createGatewayConfig()).toMatchObject({
      channels: {
        telegram: {
          apiRoot: "http://127.0.0.1:1234",
          botToken: "424242:crabline-telegram-token",
          enabled: true,
        },
      },
    });
    expect(binding.createChannelDriverSmokeEnv({})).toMatchObject({
      TELEGRAM_BOT_TOKEN: "424242:crabline-telegram-token",
    });
  });

  it("starts a bound OpenClaw adapter from channel and config", async () => {
    const adapter = await startOpenClawCrablineAdapter({
      channel: "telegram",
      openclawConfig: {
        channels: {
          telegram: {
            enabled: false,
          },
        },
      },
    });
    try {
      expect(adapter.channel).toBe("telegram");
      expect(adapter.requiredPluginIds).toEqual(["telegram"]);
      expect(adapter.createGatewayConfig()).toMatchObject({
        channels: {
          telegram: {
            enabled: true,
            apiRoot: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
          },
        },
      });
      expect(adapter.createAgentDelivery({ target: "dm:alice" })).toMatchObject({
        channel: "telegram",
        to: "100001",
      });
    } finally {
      await adapter.close();
    }
  });

  it("maps QA targets, inbound messages, and recorder events", () => {
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "dm:alice" })).toEqual({
      channel: "telegram",
      to: "100001",
      replyChannel: "telegram",
      replyTo: "100001",
    });

    const inbound = createOpenClawCrablineInbound({
      manifest,
      input: {
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "hello",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        chatId: "100001",
        fromId: 100001,
        fromName: "Alice",
        text: "hello",
      },
      providerTargetKey: "100001",
      qaTarget: "dm:alice",
      stateConversation: {
        id: "100001",
        kind: "direct",
      },
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest,
        targetByProviderTarget: new Map([["100001", "dm:alice"]]),
        event: {
          type: "api",
          path: "/botTOKEN/sendMessage",
          body: {
            chat_id: "100001",
            text: "agent reply",
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "agent reply",
      to: "dm:alice",
    });
  });
});
