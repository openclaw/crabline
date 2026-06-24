import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWhatsAppBaileysMockSocket,
  startWhatsAppFakeServer,
  type StartedWhatsAppFakeServer,
} from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedWhatsAppFakeServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("whatsapp fake provider server", () => {
  it("serves WhatsApp Web listener-style sends and injected inbound messages", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppFakeServer({
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);

    const health = await fetch(`${server.manifest.endpoints.apiRoot}/health`);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      selfJid: "15550000000@s.whatsapp.net",
    });

    const unauthenticated = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        text: "hello fake whatsapp",
        to: "15551234567@s.whatsapp.net",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: {
        code: 190,
        message: "Invalid OAuth access token.",
        type: "OAuthException",
      },
      ok: false,
    });

    const sent = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        text: { body: "hello fake whatsapp" },
        to: "15551234567@s.whatsapp.net",
        type: "text",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    await expect(sent.json()).resolves.toMatchObject({
      contacts: [{ input: "15551234567@s.whatsapp.net", wa_id: "15551234567" }],
      key: {
        fromMe: true,
        remoteJid: "15551234567@s.whatsapp.net",
      },
      message: {
        message: {
          conversation: "hello fake whatsapp",
        },
      },
      messages: [{ id: expect.stringMatching(/^wamid\.FAKE/u) }],
      messaging_product: "whatsapp",
      ok: true,
      toJid: "15551234567@s.whatsapp.net",
    });

    const invalidProduct = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        messaging_product: "messenger",
        text: { body: "hello fake whatsapp" },
        to: "15551234567@s.whatsapp.net",
        type: "text",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(invalidProduct.status).toBe(400);
    await expect(invalidProduct.json()).resolves.toMatchObject({
      error: {
        code: 100,
        error_data: {
          messaging_product: "whatsapp",
        },
        type: "OAuthException",
      },
      ok: false,
    });

    const presence = await fetch(server.manifest.endpoints.presenceUrl, {
      body: JSON.stringify({
        presence: "paused",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    await expect(presence.json()).resolves.toMatchObject({
      ok: true,
      presence: "paused",
    });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatJid: "120363001234567890@g.us",
        senderJid: "15551234567@s.whatsapp.net",
        text: "user nonce-1",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(inbound.json()).resolves.toMatchObject({
      message: {
        key: {
          fromMe: false,
          participant: "15551234567@s.whatsapp.net",
          remoteJid: "120363001234567890@g.us",
        },
        message: {
          conversation: "user nonce-1",
        },
      },
      ok: true,
      webhook: {
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  contacts: [{ wa_id: "15551234567" }],
                  messages: [
                    {
                      from: "15551234567",
                      text: { body: "user nonce-1" },
                      type: "text",
                    },
                  ],
                  messaging_product: "whatsapp",
                },
              },
            ],
          },
        ],
        object: "whatsapp_business_account",
      },
    });
  });

  it("exposes a Baileys-shaped mock socket over the fake provider server", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppFakeServer({
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);
    const socket = createWhatsAppBaileysMockSocket({
      accessToken: server.manifest.accessToken,
      apiRoot: server.manifest.endpoints.apiRoot,
      selfJid: server.manifest.selfJid,
    });
    const emitted: unknown[] = [];
    socket.ev.on("messages.upsert", (payload) => {
      emitted.push(payload);
    });

    const message = await socket.sendMessage("15551234567@s.whatsapp.net", {
      text: "hello through baileys shape",
    });
    await socket.sendPresenceUpdate("composing", "15551234567@s.whatsapp.net");

    expect(message).toMatchObject({
      key: {
        fromMe: true,
        remoteJid: "15551234567@s.whatsapp.net",
      },
      message: {
        conversation: "hello through baileys shape",
      },
    });
    expect(emitted).toHaveLength(1);
    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).toContain('"path":"/crabline/whatsapp/messages"');
    expect(recorder).toContain('"path":"/crabline/whatsapp/presence"');
  });
});
