import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenClawCrablineAgentDelivery,
  createOpenClawCrablineChannelReportNotes,
  createOpenClawCrablineFakeProviderBinding,
  createOpenClawCrablineInbound,
  createOpenClawCrablineOutboundFromRecorderEvent,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  resolveOpenClawCrablineChannelDriverSelection,
  runOpenClawCrablineChannelDriverSmoke,
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
  it("resolves channel-driver metadata through Crabline", () => {
    expect(resolveOpenClawCrablineChannelDriverSelection({})).toEqual({
      capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
    });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " TELEGRAM " })).toMatchObject({
      channel: "telegram",
    });
    expect(() => resolveOpenClawCrablineChannelDriverSelection({ channel: "slack" })).toThrow(
      '--channel must be one of telegram for --channel-driver crabline, got "slack"',
    );
  });

  it("maps a Telegram fake provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineFakeProviderBinding(manifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "telegram",
      requiredPluginIds: ["telegram"],
    });
    expect(
      binding.createGatewayConfig({
        channels: {
          telegram: {
            enabled: false,
          },
          slack: {
            enabled: true,
            webhookUrl: "https://example.test/slack",
          },
        },
        messages: {
          groupChat: {
            customSetting: "preserved",
          },
          dm: {
            customSetting: "also-preserved",
          },
        },
      }),
    ).toMatchObject({
      channels: {
        telegram: {
          apiRoot: "http://127.0.0.1:1234",
          botToken: "424242:crabline-telegram-token",
          enabled: true,
        },
        slack: {
          enabled: true,
          webhookUrl: "https://example.test/slack",
        },
      },
      messages: {
        groupChat: {
          customSetting: "preserved",
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
        dm: {
          customSetting: "also-preserved",
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

  it("runs OpenClaw channel-driver smoke and writes fake-provider artifacts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-smoke-"));
    try {
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      const result = await runOpenClawCrablineChannelDriverSmoke({
        outputDir,
        selection,
      });

      expect(result.capabilityReport).toMatchObject({
        result: {
          driver: "crabline",
          selectedChannel: "telegram",
          supportedChannels: ["telegram"],
        },
      });
      expect(result.smoke).toMatchObject({
        manifestPath: OPENCLAW_CRABLINE_MANIFEST_PATH,
        result: {
          ok: true,
          provider: "telegram",
          probe: {
            ok: true,
            result: {
              is_bot: true,
              username: "crabline_bot",
            },
          },
        },
      });
      const writtenManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
      ) as { provider?: string };
      expect(writtenManifest.provider).toBe("telegram");
      expect(createOpenClawCrablineChannelReportNotes(selection)).toEqual([
        "Channel driver: crabline fake provider for telegram.",
        "Channel capability report: crabline-fake-provider-capabilities.json.",
        "Channel driver smoke: crabline-fake-provider-smoke.json.",
        "Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.",
      ]);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
