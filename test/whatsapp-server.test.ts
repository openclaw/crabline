import fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import {
  initAuthCreds,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startWhatsAppServer, type StartedWhatsAppServer } from "../src/index.js";
import { ADMIN_TOKEN_HEADER } from "../src/servers/http.js";
import { MAX_WHATSAPP_WEBSOCKET_FRAGMENTS } from "../src/servers/whatsapp-baileys-websocket.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

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

function createBaileysTestSocket(server: StartedWhatsAppServer) {
  const creds: AuthenticationCreds = {
    ...initAuthCreds(),
    me: {
      id: "15550000001:0@s.whatsapp.net",
      name: "Crabline Test Bot",
    },
  };
  return makeWASocket({
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

async function resolveFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to resolve free port.");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("whatsapp local provider server", () => {
  it("validates inbound queue limits before binding the HTTP port", async () => {
    await expect(startWhatsAppServer({ accessToken: "" })).rejects.toThrow(
      "accessToken must not be empty",
    );
    await expect(startWhatsAppServer({ adminToken: " \n\t" })).rejects.toThrow(
      "adminToken must not be empty",
    );
    await expect(startWhatsAppServer({ selfJid: "not-a-whatsapp-jid" })).rejects.toThrow(
      "selfJid must be a WhatsApp user JID",
    );
    const port = await resolveFreePort();
    await expect(startWhatsAppServer({ maxPendingInboundMessages: 0, port })).rejects.toThrow(
      "must be a positive safe integer",
    );

    const server = await startWhatsAppServer({ port });
    servers.push(server);
    expect(new URL(server.manifest.baseUrl).port).toBe(String(port));
  });

  it("serves Cloud API sends and injected inbound webhook payloads", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      adminToken: "fake-whatsapp-admin-token",
      accessToken: "fake-whatsapp-token",
      recorderPath: path.join(directory, "whatsapp.jsonl"),
      selfJid: "15550000000@C.US",
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
    expect(server.manifest.selfJid).toBe("15550000000@s.whatsapp.net");
    const phoneNumber = await fetch(server.manifest.endpoints.phoneNumberUrl, {
      headers: { authorization: "bearer fake-whatsapp-token" },
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

    const missingType = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        text: { body: "missing type" },
        to: "15551234567",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(missingType.status).toBe(400);
    await expect(missingType.json()).resolves.toMatchObject({
      error: {
        message: "(#100) Missing required parameter: type",
      },
    });

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalidBody = await fetch(server.manifest.endpoints.messagesUrl, {
        body: scalarBody,
        headers: {
          authorization: "Bearer fake-whatsapp-token",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(invalidBody.status).toBe(400);
      await expect(invalidBody.json()).resolves.toEqual({
        error: {
          code: 100,
          error_data: {
            details: "The request body must be a JSON object.",
            messaging_product: "whatsapp",
          },
          fbtrace_id: "A1B2C3D4E5F",
          message: "(#100) Invalid parameter: request body",
          type: "OAuthException",
        },
      });
    }

    const malformedBody = await fetch(server.manifest.endpoints.messagesUrl, {
      body: "{",
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(malformedBody.status).toBe(400);
    await expect(malformedBody.json()).resolves.toEqual({
      error: {
        code: 100,
        error_data: {
          details: "The request body must be valid JSON.",
          messaging_product: "whatsapp",
        },
        fbtrace_id: "A1B2C3D4E5F",
        message: "(#100) Invalid parameter: request body",
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
    const events = recorder
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { accepted?: boolean; path: string });
    expect(
      events.find(
        (event) => event.path === new URL(server.manifest.endpoints.messagesUrl).pathname,
      ),
    ).toMatchObject({ accepted: true });
    expect(
      events.find(
        (event) =>
          event.accepted === false &&
          (
            event as {
              body?: { messaging_product?: string };
            }
          ).body?.messaging_product === "messenger",
      ),
    ).toBeDefined();
  });

  it("enforces sender and chat JID roles for admin inbound messages", async () => {
    const server = await startWhatsAppServer({ adminToken: "admin" });
    servers.push(server);
    const sendInbound = (body: Record<string, unknown>) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ text: "identity check", ...body }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: "admin",
        },
        method: "POST",
      });

    const groupSender = await sendInbound({
      chatJid: "120363001234567890@g.us",
      senderJid: "120363009876543210@g.us",
    });
    expect(groupSender.status).toBe(400);
    await expect(groupSender.json()).resolves.toMatchObject({
      error: { message: "(#100) Invalid parameter: senderJid" },
    });

    const mismatchedDirectSender = await sendInbound({
      chatJid: "15551234567@s.whatsapp.net",
      senderJid: "15557654321@s.whatsapp.net",
    });
    expect(mismatchedDirectSender.status).toBe(400);
    await expect(mismatchedDirectSender.json()).resolves.toMatchObject({
      error: { message: "(#100) Invalid parameter: senderJid" },
    });

    const mismatchedLidSender = await sendInbound({
      chatJid: "15551234567@lid",
      senderJid: "15551234567@s.whatsapp.net",
    });
    expect(mismatchedLidSender.status).toBe(400);

    const direct = await sendInbound({
      chatJid: "15551234567@c.us",
      senderJid: "15551234567:2@s.whatsapp.net",
    });
    expect(direct.status).toBe(200);
    const directBody = (await direct.json()) as {
      message: { key: Record<string, unknown> };
    };
    expect(directBody).toMatchObject({
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
        },
      },
      webhook: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ from: "15551234567" }],
                },
              },
            ],
          },
        ],
      },
    });
    expect(directBody.message.key).not.toHaveProperty("participant");
  });

  it("authenticates Graph requests before reading or recording their bodies", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const observed: unknown[] = [];
    const server = await startWhatsAppServer({
      accessToken: "fake",
      onEvent: (event) => {
        observed.push(event);
      },
      recorderPath: path.join(directory, "whatsapp-auth.jsonl"),
    });
    servers.push(server);

    const unauthenticated = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        text: { body: "untrusted whatsapp body" },
        to: "15551234567",
        type: "text",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    const unauthorizedOversized = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        authorization: "Bearer wrong-token",
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: server.manifest.endpoints.messagesUrl,
    });
    expect(unauthorizedOversized.status).toBe(401);

    const oversized = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        authorization: "Bearer fake",
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: server.manifest.endpoints.messagesUrl,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toMatchObject({
      error: {
        code: 100,
        error_data: {
          details: "The request body exceeds the supported size limit.",
          messaging_product: "whatsapp",
        },
        message: "(#100) Request body is too large.",
        type: "OAuthException",
      },
    });

    const phoneNumber = await fetch(server.manifest.endpoints.phoneNumberUrl, {
      headers: { authorization: "Bearer fake" },
    });
    expect(phoneNumber.status).toBe(200);

    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).not.toContain("untrusted whatsapp body");
    expect(observed).toEqual([
      expect.objectContaining({
        method: "GET",
        path: new URL(server.manifest.endpoints.phoneNumberUrl).pathname,
        type: "api",
      }),
    ]);
  });

  it("commits accepted sends before publishing their evidence", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    let failAcceptedEvent = true;
    const server = await startWhatsAppServer({
      accessToken: "fake",
      onEvent: (event) => {
        if (
          failAcceptedEvent &&
          event.path === new URL(server.manifest.endpoints.messagesUrl).pathname
        ) {
          failAcceptedEvent = false;
          throw new Error("simulated recorder observer failure");
        }
      },
      recorderPath: path.join(directory, "whatsapp-send-order.jsonl"),
    });
    servers.push(server);
    const send = () =>
      fetch(server.manifest.endpoints.messagesUrl, {
        body: JSON.stringify({
          messaging_product: "whatsapp",
          text: { body: "send once" },
          to: "15551234567",
          type: "text",
        }),
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });

    expect((await send()).status).toBe(500);
    const retried = await send();
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      messages: [{ id: "wamid.FAKE00000002" }],
    });
  });

  it("does not mark successful status requests as accepted sends", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const observed: Array<{ accepted?: boolean; body?: unknown }> = [];
    const server = await startWhatsAppServer({
      accessToken: "fake",
      onEvent: (event) => {
        observed.push(event);
      },
      recorderPath: path.join(directory, "whatsapp-status-evidence.jsonl"),
    });
    servers.push(server);

    const response = await fetch(server.manifest.endpoints.messagesUrl, {
      body: JSON.stringify({
        message_id: "wamid.status",
        messaging_product: "whatsapp",
        status: "read",
        text: { body: "not a send" },
        to: "15551234567",
      }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(observed).toContainEqual(
      expect.objectContaining({
        accepted: false,
        body: expect.objectContaining({ message_id: "wamid.status", status: "read" }),
      }),
    );
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

  it("accepts legacy group JIDs and rejects inbound before recording when the queue is full", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      adminToken: "admin",
      maxPendingInboundMessages: 1,
      recorderPath: path.join(directory, "whatsapp.jsonl"),
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          chatJid: "15551234567-1234567890@g.us",
          senderJid: "15551234567@s.whatsapp.net",
          text,
        }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
        },
        method: "POST",
      });

    const accepted = await sendInbound("accepted legacy group message");
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ delivery: "queued", ok: true });

    const rejected = await sendInbound("rejected overflow message");
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 4 } });
    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).toContain("accepted legacy group message");
    expect(recorder).not.toContain("rejected overflow message");
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

  it("closes Baileys sockets that exceed the WebSocket fragment limit", async () => {
    const server = await startWhatsAppServer();
    servers.push(server);
    const socket = new WebSocket(server.manifest.endpoints.baileysWebSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Expected fragmented WebSocket message to be rejected."));
      }, 2_000);
      socket.once("error", () => undefined);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    for (let index = 0; index <= MAX_WHATSAPP_WEBSOCKET_FRAGMENTS; index += 1) {
      socket.send(Buffer.from([index & 0xff]), { binary: true, fin: false });
    }

    await expect(closed).resolves.toBeUndefined();
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
    const socket = createBaileysTestSocket(server);
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
      const liveInbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          chatJid: "120363001234567890@g.us",
          pushName: "Fake Sender",
          senderJid: "15551234567@s.whatsapp.net",
          text: "hello after reconnect",
        }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
        },
        method: "POST",
      });
      await expect(liveInbound.json()).resolves.toMatchObject({
        delivery: "delivered",
        ok: true,
      });
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
            .filter(
              (message) =>
                message.key?.remoteJid === "120363001234567890@g.us" &&
                message.key.participant === "15551234567@s.whatsapp.net",
            ).length >= 2,
        "queued and live Baileys inbound messages.upsert",
      );
      const inboundMessages = messageUpserts
        .flatMap((event) => event.messages)
        .filter(
          (message) =>
            message.key?.remoteJid === "120363001234567890@g.us" &&
            message.key.participant === "15551234567@s.whatsapp.net",
        );
      expect(inboundMessages.map((message) => message.message?.conversation)).toEqual([
        "hello from queued admin inbound",
        "hello after reconnect",
      ]);
      expect(inboundMessages[0]).toMatchObject({
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

  it("fans admin inbound messages out to every open Baileys session", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      recorderPath: path.join(directory, "whatsapp-multi-session.jsonl"),
      selfJid: "15550000001:0@s.whatsapp.net",
    });
    servers.push(server);
    const sockets = [createBaileysTestSocket(server), createBaileysTestSocket(server)];
    const connectionUpdates: unknown[][] = sockets.map(() => []);
    const messageUpserts: BaileysMessagesUpsertEvent[][] = sockets.map(() => []);
    sockets.forEach((socket, index) => {
      socket.ev.on("connection.update", (update) => {
        connectionUpdates[index]?.push(update);
      });
      socket.ev.on("messages.upsert", (event) => {
        messageUpserts[index]?.push(event);
      });
    });

    try {
      await Promise.all(
        connectionUpdates.map((updates, index) =>
          waitForCondition(
            () =>
              updates.some(
                (update) =>
                  !!update &&
                  typeof update === "object" &&
                  (update as { connection?: unknown }).connection === "open",
              ),
            `Baileys connection ${index + 1} open`,
          ),
        ),
      );

      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          chatJid: "120363001234567890@g.us",
          pushName: "Fake Sender",
          senderJid: "15551234567@s.whatsapp.net",
          text: "hello to every Baileys session",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": server.manifest.adminToken,
        },
        method: "POST",
      });
      await expect(inbound.json()).resolves.toMatchObject({
        delivery: "delivered",
        ok: true,
      });

      await Promise.all(
        messageUpserts.map((upserts, index) =>
          waitForCondition(
            () =>
              upserts
                .flatMap((event) => event.messages)
                .some(
                  (message) =>
                    message.key?.remoteJid === "120363001234567890@g.us" &&
                    message.message?.conversation === "hello to every Baileys session",
                ),
            `Baileys session ${index + 1} inbound messages.upsert`,
          ),
        ),
      );
      for (const upserts of messageUpserts) {
        expect(
          upserts
            .flatMap((event) => event.messages)
            .filter(
              (message) =>
                message.key?.remoteJid === "120363001234567890@g.us" &&
                message.message?.conversation === "hello to every Baileys session",
            ),
        ).toHaveLength(1);
      }
    } finally {
      for (const socket of sockets) {
        socket.end(undefined);
      }
    }
  });

  it("queues inbound when a live Baileys delivery throws", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startWhatsAppServer({
      maxPendingInboundMessages: 1,
      recorderPath: path.join(directory, "whatsapp-delivery-failure.jsonl"),
      selfJid: "15550000001:0@s.whatsapp.net",
    });
    servers.push(server);
    const socket = createBaileysTestSocket(server);
    const connectionUpdates: unknown[] = [];
    socket.ev.on("connection.update", (update) => {
      connectionUpdates.push(update);
    });
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          chatJid: "120363001234567890@g.us",
          senderJid: "15551234567@s.whatsapp.net",
          text,
        }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
        },
        method: "POST",
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
      const send = vi.spyOn(WebSocket.prototype, "send").mockImplementationOnce(() => {
        throw new Error("injected WebSocket send failure");
      });

      const failed = await sendInbound("failed live delivery");
      expect(failed.status).toBe(200);
      await expect(failed.json()).resolves.toMatchObject({ delivery: "queued", ok: true });
      send.mockRestore();
      socket.end(undefined);
      await waitForCondition(
        () =>
          connectionUpdates.some(
            (update) =>
              !!update &&
              typeof update === "object" &&
              (update as { connection?: unknown }).connection === "close",
          ),
        "Baileys connection close",
      );

      const rejected = await sendInbound("rejected after failure");
      expect(rejected.status).toBe(503);
    } finally {
      socket.end(undefined);
    }
  });
});
