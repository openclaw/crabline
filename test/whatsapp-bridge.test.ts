import { describe, expect, it } from "vitest";
import { startOpenClawCrablineAdapter } from "../src/index.js";
import { WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "../src/openclaw/bridges/whatsapp.js";

describe("WhatsApp OpenClaw bridge", () => {
  it("canonicalizes direct device JIDs across inbound and outbound mapping", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "whatsapp" });
    try {
      expect(
        adapter.createAgentDelivery({ target: "dm:15551234567:2@s.whatsapp.net" }),
      ).toMatchObject({
        replyTo: "15551234567@s.whatsapp.net",
        to: "15551234567@s.whatsapp.net",
      });

      const inbound = adapter.createInbound({
        input: {
          conversation: { id: "15551234567:2@s.whatsapp.net", kind: "direct" },
          senderId: "15551234567:7@s.whatsapp.net",
          text: "device round trip",
        },
      });
      expect(inbound).toMatchObject({
        providerBody: {
          chatJid: "15551234567:2@s.whatsapp.net",
          senderJid: "15551234567:7@s.whatsapp.net",
        },
        providerTargetKey: "15551234567@s.whatsapp.net",
        qaTarget: "dm:15551234567@s.whatsapp.net",
        stateConversation: {
          id: "15551234567:2@s.whatsapp.net",
          kind: "direct",
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("normalizes only accepted exact-shape sends as outbound evidence", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "whatsapp" });
    try {
      if (adapter.manifest.provider !== "whatsapp") {
        throw new Error("Expected WhatsApp manifest.");
      }
      const path = new URL(adapter.manifest.endpoints.messagesUrl).pathname;
      const targetByProviderTarget = new Map([["15551234567@s.whatsapp.net", "dm:alice"]]);
      const base = {
        accepted: true,
        path,
        type: "api",
      };
      const body = {
        messaging_product: "whatsapp",
        text: { body: "hello" },
        to: "15551234567",
        type: "text",
      };

      expect(
        adapter.createOutboundFromRecorderEvent({
          event: {
            ...base,
            body: { text: body.text, to: body.to },
            method: "POST",
          },
          targetByProviderTarget,
        }),
      ).toMatchObject({ text: "hello", to: "dm:alice" });
      for (const event of [
        {
          ...base,
          body: { ...body, message_id: "wamid.status", status: "read" },
          method: "POST",
        },
        {
          ...base,
          body: { ...body, messaging_product: null, type: 1 },
          method: "POST",
        },
        { ...base, body, method: "GET" },
        { ...base, body: { ...body, type: "image" }, method: "POST" },
      ]) {
        expect(
          adapter.createOutboundFromRecorderEvent({ event, targetByProviderTarget }),
        ).toBeNull();
      }
    } finally {
      await adapter.close();
    }
  });

  it("preserves mapped Baileys group replies from recorder events", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "whatsapp" });
    try {
      if (adapter.manifest.provider !== "whatsapp") {
        throw new Error("Expected WhatsApp manifest.");
      }
      const bridgeAdapter = WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE.createAdapterFromManifest(
        adapter.manifest,
      );
      const inbound = adapter.createInbound({
        input: {
          conversation: { id: "120363001234567890@g.us", kind: "group" },
          senderId: "15551234567@s.whatsapp.net",
          text: "group prompt",
        },
      });
      expect(inbound.providerTargetKey).toBe("120363001234567890@g.us");

      expect(
        bridgeAdapter.createOutboundFromRecorderEvent({
          event: {
            accepted: true,
            body: {
              key: { remoteJid: "120363001234567890@g.us" },
              message: { conversation: "group reply" },
            },
            method: "WEBSOCKET",
            path: new URL(adapter.manifest.endpoints.baileysWebSocketUrl).pathname,
            type: "api",
          },
          targetByProviderTarget: new Map([[inbound.providerTargetKey, "group:openclaw-testers"]]),
        }),
      ).toEqual({
        accountId: "default",
        senderId: "openclaw",
        senderName: "OpenClaw QA",
        text: "group reply",
        to: "group:openclaw-testers",
      });
    } finally {
      await adapter.close();
    }
  });
});
