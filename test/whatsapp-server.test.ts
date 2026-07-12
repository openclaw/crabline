import fs from "node:fs/promises";
import path from "node:path";
import {
  initAuthCreds,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startWhatsAppServer, type StartedWhatsAppServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedWhatsAppServer[] = [];
const directories: string[] = [];
const silentLogger = createSilentLogger();

type BaileysUpsertMessage = {
  key?: {
    fromMe?: boolean | null | undefined;
    participant?: string | null | undefined;
    remoteJid?: string | null | undefined;
  };
  message?: {
    conversation?: string | null | undefined;
  } | null;
  pushName?: string | null | undefined;
};

type BaileysMessagesUpsertEvent = {
  messages: BaileysUpsertMessage[];
};

type MemorySignalStore = {
  get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }>;
  set(data: SignalDataSet): Promise<void>;
};

function createSilentLogger() {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    level: "silent",
    trace: () => undefined,
    warn: () => undefined,
  };
  return logger;
}

function createMemorySignalStore(): MemorySignalStore {
  const store = new Map<string, unknown>();
  return {
    async get(type, ids) {
      const result: Record<string, unknown> = {};
      for (const id of ids) {
        const value = store.get(`${type}.${id}`);
        if (value !== undefined) {
          result[id] = value;
        }
      }
      return result as { [id: string]: SignalDataTypeMap[typeof type] };
    },
    async set(data) {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries ?? {})) {
          const key = `${type}.${id}`;
          if (value === null) {
            store.delete(key);
          } else {
            store.set(key, value);
          }
        }
      }
    },
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function expectWebSocketUpgradeRejected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Expected WebSocket upgrade to fail.")));
      socket.terminate();
    }, 1_000);
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      complete();
    };
    socket.once("open", () => {
      finish(() => {
        socket.terminate();
        reject(new Error("Expected WebSocket upgrade to be rejected before open."));
      });
    });
    socket.once("error", () => finish(resolve));
    socket.once("close", () => finish(resolve));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("whatsapp local provider server", () => {
  it("serves Cloud API sends and injected inbound webhook payloads", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      adminToken: "fake-whatsapp-admin-token",
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);

    const baileysWebSocketUrl = new URL(server.manifest.endpoints.baileysWebSocketUrl);
    expect(baileysWebSocketUrl).toMatchObject({
      hostname: "127.0.0.1",
      pathname: "/ws/chat",
      protocol: "ws:",
    });
    expect(baileysWebSocketUrl.searchParams.get("access_token")).toBe("fake-whatsapp-token");
    expect(server.manifest.endpoints.messagesUrl).toMatch(/\/v25\.0\/100000000000000\/messages$/u);
    const phoneNumber = await fetch(server.manifest.endpoints.phoneNumberUrl, {
      headers: { authorization: "Bearer fake-whatsapp-token" },
    });
    await expect(phoneNumber.json()).resolves.toMatchObject({
      display_phone_number: "15550000000",
      id: "100000000000000",
      quality_rating: "GREEN",
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
    });

    const sent = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        text: { body: "hello fake whatsapp" },
        to: "15551234567",
        type: "text",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    await expect(sent.json()).resolves.toMatchObject({
      contacts: [{ input: "15551234567", wa_id: "15551234567" }],
      messages: [{ id: expect.stringMatching(/^wamid\.FAKE/u) }],
      messaging_product: "whatsapp",
    });

    const invalidProduct = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        messaging_product: "messenger",
        text: { body: "hello fake whatsapp" },
        to: "15551234567",
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
    });

    const status = await fetch(server.manifest.endpoints.statusUrl, {
      body: JSON.stringify({
        message_id: "wamid.FAKE00000001",
        messaging_product: "whatsapp",
        status: "read",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    await expect(status.json()).resolves.toEqual({ success: true });

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
    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).not.toContain("forged user nonce");
    expect(recorder).toContain('"path":"/_crabline/admin/whatsapp/inbound"');
  });

  it("does not accept admin inbound messages when recorder append fails", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      adminToken: "fake-whatsapp-admin-token",
      accessToken: "fake-whatsapp-token",
      recorderPath: directory,
    });
    servers.push(server);

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatJid: "120363001234567890@g.us",
        pushName: "Fake Sender",
        senderJid: "15551234567@s.whatsapp.net",
        text: "unrecordable inbound nonce",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "fake-whatsapp-admin-token",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(500);
    await expect(inbound.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects Baileys WebSocket upgrades without the local provider access token", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);

    const unauthenticatedUrl = new URL(server.manifest.endpoints.baileysWebSocketUrl);
    unauthenticatedUrl.search = "";
    await expect(
      expectWebSocketUpgradeRejected(unauthenticatedUrl.toString()),
    ).resolves.toBeUndefined();

    const wrongTokenUrl = new URL(server.manifest.endpoints.baileysWebSocketUrl);
    wrongTokenUrl.searchParams.set("access_token", "wrong-token");
    await expect(expectWebSocketUpgradeRejected(wrongTokenUrl.toString())).resolves.toBeUndefined();
  });

  it("accepts a real Baileys socket over waWebSocketUrl and records outbound stanzas", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      recorderPath: path.join(directory, "whatsapp.jsonl"),
      selfJid: "15550000001:0@s.whatsapp.net",
    });
    servers.push(server);
    const queuedInbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatJid: "120363001234567890@g.us",
        pushName: "Fake Sender",
        senderJid: "15551234567@s.whatsapp.net",
        text: "hello from queued admin inbound",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    await expect(queuedInbound.json()).resolves.toMatchObject({
      delivery: "queued",
      message: {
        message: {
          conversation: "hello from queued admin inbound",
        },
      },
      ok: true,
    });
    const creds: AuthenticationCreds = {
      ...initAuthCreds(),
      me: {
        id: "15550000001:0@s.whatsapp.net",
        name: "Crabline Test Bot",
      },
    };
    const socket = makeWASocket({
      auth: {
        creds,
        keys: makeCacheableSignalKeyStore(createMemorySignalStore(), silentLogger),
      },
      browser: ["crabline", "test", "1.0"],
      connectTimeoutMs: 2_000,
      defaultQueryTimeoutMs: 750,
      fireInitQueries: false,
      keepAliveIntervalMs: 10_000,
      logger: silentLogger,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      syncFullHistory: false,
      waWebSocketUrl: server.manifest.endpoints.baileysWebSocketUrl,
      version: [2, 3000, 1035194821],
    });
    const connectionUpdates: unknown[] = [];
    socket.ev.on("connection.update", (update) => {
      connectionUpdates.push(update);
    });
    const messageUpserts: BaileysMessagesUpsertEvent[] = [];
    socket.ev.on("messages.upsert", (event) => {
      messageUpserts.push(event);
    });

    try {
      await waitForCondition(
        () =>
          connectionUpdates.some(
            (update) =>
              !!update &&
              typeof update === "object" &&
              (update as { connection?: unknown }).connection === "open",
          ),
        "Baileys connection open",
      );
      await socket.sendMessage("15551234567@s.whatsapp.net", {
        text: "hello through real baileys",
      });
      await waitForCondition(
        () =>
          fs.readFile(server.manifest.recorderPath, "utf8").then(
            (recorder) => recorder.includes('"tag":"message"'),
            () => false,
          ),
        "WhatsApp message recorder event",
      );
      const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
      expect(recorder).toContain('"method":"WEBSOCKET"');
      expect(recorder).toContain('"tag":"message"');
      expect(recorder).toContain('"to":"15551234567@s.whatsapp.net"');

      await waitForCondition(
        () =>
          messageUpserts
            .flatMap((event) => event.messages)
            .some(
              (message) =>
                message.key?.remoteJid === "120363001234567890@g.us" &&
                message.key.participant === "15551234567@s.whatsapp.net" &&
                message.message?.conversation === "hello from queued admin inbound",
            ),
        "queued Baileys inbound messages.upsert",
      );
      const queuedMessages = messageUpserts
        .flatMap((event) => event.messages)
        .filter(
          (message) =>
            message.key?.remoteJid === "120363001234567890@g.us" &&
            message.message?.conversation === "hello from queued admin inbound",
        );
      expect(queuedMessages).toHaveLength(1);
      expect(queuedMessages[0]).toMatchObject({
        key: {
          fromMe: false,
          participant: "15551234567@s.whatsapp.net",
          remoteJid: "120363001234567890@g.us",
        },
        message: {
          conversation: "hello from queued admin inbound",
        },
        pushName: "Fake Sender",
      });
    } finally {
      socket.end(undefined);
    }
  });
});
