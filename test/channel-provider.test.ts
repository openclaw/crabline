import { describe, expect, it } from "vitest";
import { runFixtureCommand } from "../src/core/run.js";
import { createRegistry } from "../src/providers/registry.js";
import type { ManifestDefinition } from "../src/config/schema.js";
import {
  LOCAL_CHANNEL_DRIVER_MATRIX,
  TelegramLocalChannelDriver,
  WhatsAppLocalChannelDriver,
} from "../src/channels/index.js";

const manifest: ManifestDefinition = {
  configVersion: 1,
  fixtures: [
    {
      env: [],
      id: "telegram-dm",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "telegram-local",
      retries: 0,
      tags: [],
      target: {
        id: "user-123",
        metadata: {
          chatType: "dm",
          userName: "qa-user",
        },
      },
      timeoutMs: 1000,
    },
    {
      env: [],
      id: "telegram-group-topic-action",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "telegram-local",
      retries: 0,
      tags: [],
      target: {
        channelId: "telegram:group:-100123",
        id: "-100123",
        metadata: {
          actionId: "approve-1",
          actionPayload: "approve:tool",
          actionType: "button",
          chatType: "group",
          mediaKind: "image",
          mention: "true",
          topicId: "42",
        },
        threadId: "42",
      },
      timeoutMs: 1000,
    },
    {
      env: [],
      id: "whatsapp-dm",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "whatsapp-local",
      retries: 0,
      tags: [],
      target: {
        id: "15551230001",
        metadata: {
          chatType: "dm",
          deliveryReceipt: "true",
          pushName: "qa-user",
          userJid: "15551230001@s.whatsapp.net",
        },
      },
      timeoutMs: 1000,
    },
  ],
  providers: {
    "telegram-local": {
      adapter: "channel",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      channel: {
        botUserName: "crabline_bot",
        qaResponse: { mode: "ack" },
      },
      env: [],
      platform: "telegram",
      status: "active",
    },
    "whatsapp-local": {
      adapter: "channel",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      channel: {
        botUserName: "crabline_whatsapp_bot",
        qaResponse: { mode: "ack" },
      },
      env: [],
      platform: "whatsapp",
      status: "active",
    },
  },
  userName: "crabline",
};

describe("local channel provider", () => {
  it("runs a deterministic Telegram DM roundtrip with transcript metadata", async () => {
    const registry = createRegistry(manifest, "/tmp/crabline.yaml");
    const result = await runFixtureCommand({
      fixtureId: "telegram-dm",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry,
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("accepted message telegram:event:1"),
        expect.stringContaining("matched inbound telegram:event:2"),
      ]),
    );
  });

  it("models Telegram group topic, media, and native action semantics", () => {
    const driver = new TelegramLocalChannelDriver();
    const target = {
      channelId: "telegram:group:-100123",
      id: "-100123",
      metadata: {
        actionId: "approve-1",
        actionPayload: "approve:tool",
        actionType: "button",
        chatType: "group",
        fileId: "file-123",
        mediaKind: "image",
        mention: "true",
        topicId: "42",
      },
      threadId: "42",
    };
    const conversation = driver.conversationFromTarget(target);
    const action = driver.createNativeAction(target);
    const attachment = driver.createMediaAttachment(target);
    const inbound = driver.ingestEvent({
      action: action ?? undefined,
      actor: driver.createUserActor(target),
      attachments: attachment ? [attachment] : [],
      conversation,
      kind: "action",
      raw: { callback_query: { data: action?.payload } },
      text: "@crabline approve",
    });

    expect(conversation).toMatchObject({
      id: "telegram:group:-100123",
      kind: "group",
      topicId: "42",
    });
    expect(inbound.action).toMatchObject({ id: "approve-1", payload: "approve:tool" });
    expect(inbound.attachments[0]).toMatchObject({ id: "file-123", kind: "image" });
    expect(inbound.channel).toBe("telegram");
    expect(inbound.driverId).toBe("telegram");
  });

  it("runs a deterministic WhatsApp DM roundtrip with transcript metadata", async () => {
    const registry = createRegistry(manifest, "/tmp/crabline.yaml");
    const result = await runFixtureCommand({
      fixtureId: "whatsapp-dm",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry,
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("accepted message whatsapp:event:1"),
        expect.stringContaining("matched inbound whatsapp:event:2"),
      ]),
    );
  });

  it("models WhatsApp group, quote, media, and interactive action semantics", () => {
    const driver = new WhatsAppLocalChannelDriver();
    const target = {
      channelId: "whatsapp:group:120363025111@g.us",
      id: "120363025111@g.us",
      metadata: {
        actionId: "approve-1",
        actionLabel: "Approve",
        actionPayload: "approve:tool",
        actionType: "button",
        chatType: "group",
        mediaKind: "image",
        mediaMessageId: "media-123",
        pushName: "QA User",
        quotedMessageId: "quoted-42",
        senderJid: "15551230001@s.whatsapp.net",
      },
      threadId: "quoted-42",
    };
    const conversation = driver.conversationFromTarget(target);
    const action = driver.createNativeAction(target);
    const attachment = driver.createMediaAttachment(target);
    const inbound = driver.ingestEvent({
      action: action ?? undefined,
      actor: driver.createUserActor(target),
      attachments: attachment ? [attachment] : [],
      conversation,
      kind: "action",
      raw: { message: { buttonsResponseMessage: { selectedButtonId: action?.payload } } },
      text: "approve",
    });

    expect(conversation).toMatchObject({
      id: "whatsapp:group:120363025111@g.us",
      kind: "group",
      topicId: "quoted-42",
    });
    expect(inbound.action).toMatchObject({ id: "approve-1", payload: "approve:tool" });
    expect(inbound.actor).toMatchObject({
      displayName: "QA User",
      id: "15551230001@s.whatsapp.net",
    });
    expect(inbound.attachments[0]).toMatchObject({ id: "media-123", kind: "image" });
    expect(inbound.channel).toBe("whatsapp");
    expect(inbound.driverId).toBe("whatsapp");
  });

  it("keeps local capability gaps visible for future channels", () => {
    expect(LOCAL_CHANNEL_DRIVER_MATRIX).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "telegram.dm.text",
          channel: "telegram",
          status: "covered",
        }),
        expect.objectContaining({
          capabilityId: "whatsapp.dm.text",
          channel: "whatsapp",
          status: "covered",
        }),
        expect.objectContaining({
          capabilityId: "discord.dm.text",
          channel: "discord",
          status: "planned",
        }),
      ]),
    );
  });
});
