import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV,
  CRABLINE_WHATSAPP_API_ROOT_ENV,
  CRABLINE_WHATSAPP_RECORDER_PATH_ENV,
  CRABLINE_WHATSAPP_SELF_JID_ENV,
  createWhatsAppSocket,
  startWhatsAppFakeServer,
  WhatsAppBaileysMockRegistry,
  type StartedWhatsAppFakeServer,
} from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedWhatsAppFakeServer[] = [];
const directories: string[] = [];
const WHATSAPP_FACTORY_ENV_KEYS = [
  CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV,
  CRABLINE_WHATSAPP_API_ROOT_ENV,
  CRABLINE_WHATSAPP_RECORDER_PATH_ENV,
  CRABLINE_WHATSAPP_SELF_JID_ENV,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function captureEnv() {
  return Object.fromEntries(WHATSAPP_FACTORY_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const key of WHATSAPP_FACTORY_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("whatsapp fake provider server", () => {
  it("serves WhatsApp Web listener-style sends and injected inbound messages", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppFakeServer({
      adminToken: "fake-whatsapp-admin-token",
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);
    const inboundEvents: unknown[] = [];
    const socket = server.createBaileysMockSocket();
    socket.ev.on("messages.upsert", (payload) => {
      inboundEvents.push(payload);
    });

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

    const unauthenticatedInbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatJid: "120363001234567890@g.us",
        senderJid: "15551234567@s.whatsapp.net",
        text: "forged user nonce",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthenticatedInbound.status).toBe(401);
    await expect(unauthenticatedInbound.text()).resolves.toBe("unauthorized");

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatJid: "120363001234567890@g.us",
        pushName: "Fake Sender",
        senderJid: "15551234567@s.whatsapp.net",
        text: "user nonce-1",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "fake-whatsapp-admin-token",
      },
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
        pushName: "Fake Sender",
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
    expect(inboundEvents).toEqual([
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            key: expect.objectContaining({
              fromMe: false,
              participant: "15551234567@s.whatsapp.net",
              remoteJid: "120363001234567890@g.us",
            }),
            message: {
              conversation: "user nonce-1",
            },
            pushName: "Fake Sender",
          }),
        ],
        type: "notify",
      }),
    ]);
    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).not.toContain("forged user nonce");
    expect(recorder).toContain('"path":"/crabline/whatsapp/inbound"');
  });

  it("exposes a Baileys-shaped mock socket over the fake provider server", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppFakeServer({
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);
    const socket = server.createBaileysMockSocket();
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

  it("exposes an env-driven Baileys runtime socket factory backed by the recorder", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppFakeServer({
      accessToken: "fake-whatsapp-token",
      adminToken: "fake-whatsapp-admin-token",
      baileysRegistry: new WhatsAppBaileysMockRegistry(),
      recorderPath: path.join(directory, "whatsapp.jsonl"),
      selfJid: "15550000001@s.whatsapp.net",
    });
    servers.push(server);
    const previousEnv = captureEnv();
    process.env[CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV] = server.manifest.accessToken;
    process.env[CRABLINE_WHATSAPP_API_ROOT_ENV] = server.manifest.endpoints.apiRoot;
    process.env[CRABLINE_WHATSAPP_RECORDER_PATH_ENV] = server.manifest.recorderPath;
    process.env[CRABLINE_WHATSAPP_SELF_JID_ENV] = server.manifest.selfJid;

    const socket = await createWhatsAppSocket(false, false);
    try {
      const connectionUpdates: unknown[] = [];
      const inboundEvents: unknown[] = [];
      socket.ev.on("connection.update", (payload) => {
        connectionUpdates.push(payload);
      });
      socket.ev.on("messages.upsert", (payload) => {
        const firstMessage = isRecord(payload)
          ? (payload.messages as Array<Record<string, unknown>> | undefined)?.[0]
          : undefined;
        const key = isRecord(firstMessage) ? firstMessage.key : undefined;
        if (isRecord(key) && key.fromMe === false) {
          inboundEvents.push(payload);
        }
      });

      await waitForCondition(
        () => connectionUpdates.some((update) => isRecord(update) && update.connection === "open"),
        "WhatsApp runtime socket connection open",
      );
      const sentMessage = await socket.sendMessage("15551234567@s.whatsapp.net", {
        text: "hello through env socket",
      });
      await socket.sendPresenceUpdate("composing", "15551234567@s.whatsapp.net");
      await socket.readMessages([{ id: "wamid.READ", remoteJid: "15551234567@s.whatsapp.net" }]);

      expect(sentMessage).toMatchObject({
        key: {
          fromMe: true,
          remoteJid: "15551234567@s.whatsapp.net",
        },
        message: {
          conversation: "hello through env socket",
        },
      });
      await expect(socket.groupFetchAllParticipating()).resolves.toEqual({});
      await expect(socket.groupMetadata("120363001234567890@g.us")).resolves.toEqual({
        id: "120363001234567890@g.us",
        participants: [],
        subject: "Test Group",
      });

      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          chatJid: "120363001234567890@g.us",
          pushName: "Fake Sender",
          senderJid: "15551234567@s.whatsapp.net",
          text: "user nonce from recorder",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "fake-whatsapp-admin-token",
        },
        method: "POST",
      });
      expect(inbound.status).toBe(200);
      await waitForCondition(() => inboundEvents.length === 1, "WhatsApp recorder inbound event");
      expect(inboundEvents).toEqual([
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              key: expect.objectContaining({
                fromMe: false,
                participant: "15551234567@s.whatsapp.net",
                remoteJid: "120363001234567890@g.us",
              }),
              message: {
                conversation: "user nonce from recorder",
              },
              pushName: "Fake Sender",
            }),
          ],
          type: "notify",
        }),
      ]);

      socket.end();
      expect(connectionUpdates).toContainEqual(
        expect.objectContaining({
          connection: "close",
        }),
      );
    } finally {
      socket.end();
      restoreEnv(previousEnv);
    }
  });

  it("fans out recorder inbound lines to runtime sockets sharing a recorder path", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppFakeServer({
      accessToken: "fake-whatsapp-token",
      adminToken: "fake-whatsapp-admin-token",
      baileysRegistry: new WhatsAppBaileysMockRegistry(),
      recorderPath: path.join(directory, "whatsapp.jsonl"),
      selfJid: "15550000001@s.whatsapp.net",
    });
    servers.push(server);
    const previousEnv = captureEnv();
    process.env[CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV] = server.manifest.accessToken;
    process.env[CRABLINE_WHATSAPP_API_ROOT_ENV] = server.manifest.endpoints.apiRoot;
    process.env[CRABLINE_WHATSAPP_RECORDER_PATH_ENV] = server.manifest.recorderPath;
    process.env[CRABLINE_WHATSAPP_SELF_JID_ENV] = server.manifest.selfJid;

    const firstSocket = await createWhatsAppSocket(false, false);
    const secondSocket = await createWhatsAppSocket(false, false);
    try {
      const firstInboundEvents: unknown[] = [];
      const secondInboundEvents: unknown[] = [];
      firstSocket.ev.on("messages.upsert", (payload) => {
        firstInboundEvents.push(payload);
      });
      secondSocket.ev.on("messages.upsert", (payload) => {
        secondInboundEvents.push(payload);
      });

      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          chatJid: "120363001234567890@g.us",
          pushName: "Fake Sender",
          senderJid: "15551234567@s.whatsapp.net",
          text: "fanout nonce",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "fake-whatsapp-admin-token",
        },
        method: "POST",
      });
      expect(inbound.status).toBe(200);

      await waitForCondition(
        () => firstInboundEvents.length === 1 && secondInboundEvents.length === 1,
        "WhatsApp recorder fan-out",
      );
      const expectedPayload = expect.objectContaining({
        messages: [
          expect.objectContaining({
            key: expect.objectContaining({
              fromMe: false,
              participant: "15551234567@s.whatsapp.net",
              remoteJid: "120363001234567890@g.us",
            }),
            message: {
              conversation: "fanout nonce",
            },
            pushName: "Fake Sender",
          }),
        ],
        type: "notify",
      });
      expect(firstInboundEvents).toEqual([expectedPayload]);
      expect(secondInboundEvents).toEqual([expectedPayload]);
    } finally {
      firstSocket.end();
      secondSocket.end();
      restoreEnv(previousEnv);
    }
  });
});
