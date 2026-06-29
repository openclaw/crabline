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
  adminToken: "crabline-admin-token",
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

const whatsappManifest: CrablineFakeProviderManifest = {
  accessToken: "crabline-whatsapp-access-token",
  adminToken: "crabline-whatsapp-admin-token",
  baseUrl: "http://127.0.0.1:5678",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:5678/crabline/whatsapp/inbound",
    apiRoot: "http://127.0.0.1:5678/crabline/whatsapp",
    baileysWebSocketUrl:
      "ws://127.0.0.1:5678/crabline/whatsapp/ws/chat?access_token=crabline-whatsapp-access-token",
    messagesUrl: "http://127.0.0.1:5678/crabline/whatsapp/messages",
    presenceUrl: "http://127.0.0.1:5678/crabline/whatsapp/presence",
  },
  env: {
    CRABLINE_WHATSAPP_ADMIN_TOKEN: "crabline-whatsapp-admin-token",
    CRABLINE_WHATSAPP_ACCESS_TOKEN: "crabline-whatsapp-access-token",
    CRABLINE_WHATSAPP_API_ROOT: "http://127.0.0.1:5678/crabline/whatsapp",
    CRABLINE_WHATSAPP_BAILEYS_WEB_SOCKET_URL:
      "ws://127.0.0.1:5678/crabline/whatsapp/ws/chat?access_token=crabline-whatsapp-access-token",
    CRABLINE_WHATSAPP_RECORDER_PATH: "/tmp/crabline/whatsapp.jsonl",
    CRABLINE_WHATSAPP_SELF_JID: "15550000000@s.whatsapp.net",
  },
  provider: "whatsapp",
  recorderPath: "/tmp/crabline/whatsapp.jsonl",
  selfJid: "15550000000@s.whatsapp.net",
  version: 1,
};

const slackManifest: CrablineFakeProviderManifest = {
  adminToken: "crabline-slack-admin-token",
  baseUrl: "http://127.0.0.1:2468",
  botToken: "xoxb-crabline-slack-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:2468/crabline/slack/inbound",
    apiRoot: "http://127.0.0.1:2468/api/",
    eventsUrl: "http://127.0.0.1:2468/slack/events",
  },
  env: {
    SLACK_API_URL: "http://127.0.0.1:2468/api/",
    SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
    SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
  },
  provider: "slack",
  recorderPath: "/tmp/crabline/slack.jsonl",
  signingSecret: "crabline-slack-signing-secret",
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
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " WHATSAPP " })).toMatchObject({
      channel: "whatsapp",
    });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " SLACK " })).toMatchObject({
      channel: "slack",
    });
    expect(() => resolveOpenClawCrablineChannelDriverSelection({ channel: "discord" })).toThrow(
      '--channel must be one of slack, telegram, whatsapp for --channel-driver crabline, got "discord"',
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

  it("maps a WhatsApp fake provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineFakeProviderBinding(whatsappManifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "whatsapp",
      requiredPluginIds: ["whatsapp"],
    });
    expect(
      binding.createGatewayConfig({
        channels: {
          slack: {
            enabled: true,
            webhookUrl: "https://example.test/slack",
          },
          whatsapp: {
            enabled: false,
          },
        },
      }),
    ).toMatchObject({
      channels: {
        slack: {
          enabled: true,
          webhookUrl: "https://example.test/slack",
        },
        whatsapp: {
          enabled: true,
          dmPolicy: "open",
          groupPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["*"],
        },
      },
    });
    expect(binding.createChannelDriverSmokeEnv({})).toMatchObject({
      CRABLINE_WHATSAPP_ADMIN_TOKEN: "crabline-whatsapp-admin-token",
      CRABLINE_WHATSAPP_RECORDER_PATH: "/tmp/crabline/whatsapp.jsonl",
      CRABLINE_WHATSAPP_SELF_JID: "15550000000@s.whatsapp.net",
      OPENCLAW_WHATSAPP_WEB_SOCKET_URL:
        "ws://127.0.0.1:5678/crabline/whatsapp/ws/chat?access_token=crabline-whatsapp-access-token",
    });
  });

  it("maps a Slack fake provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineFakeProviderBinding(slackManifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "slack",
      requiredPluginIds: ["slack"],
    });
    expect(
      binding.createGatewayConfig({
        channels: {
          slack: {
            enabled: false,
          },
          telegram: {
            enabled: true,
          },
        },
      }),
    ).toMatchObject({
      channels: {
        slack: {
          botToken: "xoxb-crabline-slack-token",
          enabled: true,
          mode: "http",
          signingSecret: "crabline-slack-signing-secret",
          webhookPath: "/slack/events",
        },
        telegram: {
          enabled: true,
        },
      },
    });
    expect(binding.createChannelDriverSmokeEnv({})).toMatchObject({
      SLACK_API_URL: "http://127.0.0.1:2468/api/",
      SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
      SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
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
      providerHeaders: {
        "content-type": "application/json",
        "x-crabline-admin-token": "crabline-admin-token",
      },
      providerTargetKey: "100001",
      providerUrl: "http://127.0.0.1:1234/crabline/telegram/inbound",
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
            text: "  hello\n",
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "  hello\n",
      to: "dm:alice",
    });
  });

  it("maps WhatsApp QA targets, inbound messages, and recorder events", () => {
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "dm:15551234567@s.whatsapp.net",
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "15551234567@s.whatsapp.net",
      replyChannel: "whatsapp",
      replyTo: "15551234567@s.whatsapp.net",
    });

    const inbound = createOpenClawCrablineInbound({
      manifest: whatsappManifest,
      input: {
        conversation: { id: "120363001234567890@g.us", kind: "group" },
        senderId: "15551234567@s.whatsapp.net",
        senderName: "Alice",
        text: "hello",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        chatJid: "120363001234567890@g.us",
        senderJid: "15551234567@s.whatsapp.net",
        pushName: "Alice",
        text: "hello",
      },
      providerHeaders: {
        "content-type": "application/json",
        "x-crabline-admin-token": "crabline-whatsapp-admin-token",
      },
      providerTargetKey: "120363001234567890@g.us",
      providerUrl: "http://127.0.0.1:5678/crabline/whatsapp/inbound",
      qaTarget: "group:120363001234567890@g.us",
      stateConversation: {
        id: "120363001234567890@g.us",
        kind: "group",
      },
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: whatsappManifest,
        targetByProviderTarget: new Map([["15551234567@s.whatsapp.net", "dm:alice"]]),
        event: {
          type: "api",
          path: "/crabline/whatsapp/messages",
          body: {
            to: "15551234567@s.whatsapp.net",
            text: { body: "hello from openclaw" },
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "hello from openclaw",
      to: "dm:alice",
    });
  });

  it("maps Slack QA targets, inbound messages, and recorder events", () => {
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: slackManifest,
        target: "thread:C1234567890/1700000000.000100",
      }),
    ).toEqual({
      channel: "slack",
      to: "C1234567890",
      replyChannel: "slack",
      replyTo: "C1234567890:thread:1700000000.000100",
    });

    const inbound = createOpenClawCrablineInbound({
      manifest: slackManifest,
      input: {
        conversation: { id: "C1234567890", kind: "group" },
        senderId: "U1234567890",
        senderName: "Alice",
        text: "hello",
        threadId: "1700000000.000100",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        channel: "C1234567890",
        user: "U1234567890",
        username: "Alice",
        threadTs: "1700000000.000100",
        text: "hello",
      },
      providerHeaders: {
        "content-type": "application/json",
        "x-crabline-admin-token": "crabline-slack-admin-token",
      },
      providerTargetKey: "C1234567890:thread:1700000000.000100",
      providerUrl: "http://127.0.0.1:2468/crabline/slack/inbound",
      qaTarget: "thread:C1234567890/1700000000.000100",
      stateConversation: {
        id: "C1234567890",
        kind: "group",
      },
      threadId: "1700000000.000100",
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: slackManifest,
        targetByProviderTarget: new Map([
          ["C1234567890:thread:1700000000.000100", "thread:qa/parent"],
        ]),
        event: {
          type: "api",
          path: "/api/chat.postMessage",
          body: {
            channel: "C1234567890",
            text: "hello from openclaw",
            thread_ts: "1700000000.000100",
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "hello from openclaw",
      to: "thread:qa/parent",
    });
  });

  it("posts WhatsApp OpenClaw inbound with admin headers into the fake provider", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "whatsapp" });
    try {
      if (adapter.manifest.provider !== "whatsapp") {
        throw new Error("Expected WhatsApp fake provider manifest.");
      }

      const inbound = adapter.createInbound({
        input: {
          conversation: { id: "120363001234567890@g.us", kind: "group" },
          senderId: "15551234567@s.whatsapp.net",
          senderName: "Alice",
          text: "hello from qa",
        },
      });

      const rejected = await fetch(inbound.providerUrl, {
        body: JSON.stringify(inbound.providerBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(inbound.providerUrl, {
        body: JSON.stringify(inbound.providerBody),
        headers: inbound.providerHeaders,
        method: "POST",
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({ ok: true });
    } finally {
      await adapter.close();
    }
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
          supportedChannels: ["slack", "telegram", "whatsapp"],
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
