import fs from "node:fs/promises";
import { Agent } from "node:http";
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
import {
  ProtocolAddress,
  SessionBuilder,
  SessionCipher,
  SessionRecord,
  type SignalStorage,
} from "libsignal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createOpenClawCrablineOutboundFromRecorderEvent,
  startWhatsAppServer,
  type StartedWhatsAppServer,
} from "../src/index.js";
import { ADMIN_TOKEN_HEADER } from "../src/servers/http.js";
import {
  MAX_WHATSAPP_WEBSOCKET_FRAGMENTS,
  persistAcceptedBaileysMessage,
  signalBundleIdentityKey,
  WhatsAppSignalBundleStore,
} from "../src/servers/whatsapp-baileys-websocket.js";
import type { BinaryNode } from "../src/servers/whatsapp-wire/binary-node.js";
import { Curve, ensureSignalPublicKey, type KeyPair } from "../src/servers/whatsapp-wire/crypto.js";
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

function signalTestKeyPair(pair: KeyPair): { privKey: Buffer; pubKey: Buffer } {
  return {
    privKey: Buffer.from(pair.private),
    pubKey: ensureSignalPublicKey(pair.public),
  };
}

function createSignalTestStorage(identityKey: KeyPair, registrationId: number): SignalStorage {
  const sessions = new Map<string, SessionRecord>();
  return {
    getOurIdentity: () => signalTestKeyPair(identityKey),
    getOurRegistrationId: () => registrationId,
    isTrustedIdentity: () => true,
    loadPreKey: async () => undefined,
    loadSession: async (id) => sessions.get(id),
    loadSignedPreKey: () => signalTestKeyPair(identityKey),
    removePreKey: () => undefined,
    storeSession: async (id, session) => {
      sessions.set(id, session);
    },
  };
}

function signalCiphertext(body: string): Buffer {
  return Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body, "binary");
}

function signalMessageNode(params: {
  ciphertext: Buffer;
  id: string;
  recipientJid: string;
  type: number;
}): BinaryNode {
  return {
    attrs: {
      id: params.id,
      to: "15557654321@s.whatsapp.net",
    },
    content: [
      {
        attrs: { jid: params.recipientJid },
        content: [
          {
            attrs: { type: params.type === 3 ? "pkmsg" : "msg" },
            content: params.ciphertext,
            tag: "enc",
          },
        ],
        tag: "to",
      },
    ],
    tag: "message",
  };
}

function padSignalMessage(message: Buffer): Buffer {
  return Buffer.concat([message, Buffer.from([1])]);
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
    await expect(startWhatsAppServer({ accessToken: " padded" })).rejects.toThrow(
      "accessToken must not be empty or whitespace-padded",
    );
    await expect(startWhatsAppServer({ adminToken: "padded " })).rejects.toThrow(
      "adminToken must not be empty or whitespace-padded",
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
    const second = await startWhatsAppServer();
    servers.push(second);
    expect(server.manifest.accessToken).toMatch(/^EAA[A-Za-z0-9_-]+$/u);
    expect(second.manifest.accessToken).not.toBe(server.manifest.accessToken);
  });

  it("releases the HTTP listener when WebSocket attachment fails", async () => {
    const port = await resolveFreePort();
    const originalOn = WebSocketServer.prototype.on;
    let rejectedConnectionHandler = false;
    const onSpy = vi
      .spyOn(WebSocketServer.prototype, "on")
      .mockImplementation(function (this: WebSocketServer, event, listener) {
        if (!rejectedConnectionHandler && event === "connection") {
          rejectedConnectionHandler = true;
          throw new Error("injected WebSocket attachment failure");
        }
        return Reflect.apply(originalOn, this, [event, listener]);
      });

    await expect(startWhatsAppServer({ port })).rejects.toThrow(
      "injected WebSocket attachment failure",
    );
    onSpy.mockRestore();

    const replacement = await startWhatsAppServer({ port });
    servers.push(replacement);
    expect(new URL(replacement.manifest.baseUrl).port).toBe(String(port));
  });

  it("releases the HTTP listener when WebSocket shutdown fails", async () => {
    const port = await resolveFreePort();
    const server = await startWhatsAppServer({ port });
    const closeSpy = vi
      .spyOn(WebSocketServer.prototype, "close")
      .mockImplementation((callback) => callback?.(new Error("injected WebSocket close failure")));

    await expect(server.close()).rejects.toThrow("injected WebSocket close failure");
    closeSpy.mockRestore();

    const replacement = await startWhatsAppServer({ port });
    servers.push(replacement);
    expect(new URL(replacement.manifest.baseUrl).port).toBe(String(port));
  });

  it("waits for admitted Baileys recorder work before shutdown completes", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    let releaseRecorder!: () => void;
    const recorderBlocked = new Promise<void>((resolve) => {
      releaseRecorder = resolve;
    });
    let markRecorderStarted!: () => void;
    const recorderStarted = new Promise<void>((resolve) => {
      markRecorderStarted = resolve;
    });
    let blockNextWebSocketEvent = true;
    const server = await startWhatsAppServer({
      onEvent: async (event) => {
        if (blockNextWebSocketEvent && event.method === "WEBSOCKET") {
          blockNextWebSocketEvent = false;
          markRecorderStarted();
          await recorderBlocked;
        }
      },
      recorderPath: path.join(directory, "whatsapp-shutdown.jsonl"),
    });
    const socket = createBaileysTestSocket(server);
    let closePromise: Promise<void> | undefined;

    try {
      await recorderStarted;
      let closeSettled = false;
      closePromise = server.close().finally(() => {
        closeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closeSettled).toBe(false);

      releaseRecorder();
      await closePromise;
    } finally {
      releaseRecorder();
      socket.end(undefined);
      await closePromise?.catch(() => undefined);
    }
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
    const sentPayload = (await sent.json()) as { messages: Array<{ id: string }> };
    expect(sentPayload).toMatchObject({
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

    const outboundStatus = await fetch(server.manifest.endpoints.statusUrl, {
      body: JSON.stringify({
        message_id: sentPayload.messages[0]!.id,
        messaging_product: "whatsapp",
        status: "read",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(outboundStatus.status).toBe(400);
    await expect(outboundStatus.json()).resolves.toMatchObject({
      error: { message: "(#100) Invalid parameter: message_id" },
    });
    const unknownStatus = await fetch(server.manifest.endpoints.statusUrl, {
      body: JSON.stringify({
        message_id: "wamid.UNKNOWN",
        messaging_product: "whatsapp",
        status: "read",
      }),
      headers: {
        authorization: "Bearer fake-whatsapp-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(unknownStatus.status).toBe(400);

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
    const inboundPayload = (await inbound.json()) as {
      message: { key: { id: string } };
    };
    expect(inboundPayload).toMatchObject({
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
    const status = await fetch(server.manifest.endpoints.statusUrl, {
      body: JSON.stringify({
        message_id: inboundPayload.message.key.id,
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
      chatJid: "15551234567:4@c.us",
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

  it("separates PN and LID signal bundle/session keys while normalizing devices", () => {
    const phoneNumberKey = signalBundleIdentityKey("15551234567:2@s.whatsapp.net");
    const lidKey = signalBundleIdentityKey("15551234567:3@lid");
    expect(phoneNumberKey).toBe("15551234567@s.whatsapp.net");
    expect(lidKey).toBe("15551234567@lid");
    expect(phoneNumberKey).not.toBe(lidKey);

    const store = new WhatsAppSignalBundleStore(2);
    const [phoneNumber, lid] = store.resolveMany(["15551234567@s.whatsapp.net", "15551234567@lid"]);
    expect(phoneNumber).not.toBe(lid);
    expect(store.resolveMany(["15551234567:2@s.whatsapp.net"])[0]).toBe(phoneNumber);
    expect(store.resolveMany(["15551234567:0@c.us"])[0]).toBe(phoneNumber);
    expect(store.resolveMany(["15551234567:3@lid"])[0]).toBe(lid);
    expect(store.size).toBe(2);
  });

  it("rejects new Signal sessions at capacity without evicting established peers", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1, undefined, undefined, undefined, undefined, {
      maxSessionsPerBundle: 1,
    });
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const createSender = async (senderJid: string, registrationId: number, message: string) => {
      const identity = Curve.generateKeyPair();
      const storage = createSignalTestStorage(identity, registrationId);
      const address = new ProtocolAddress("15551234567", 0);
      await new SessionBuilder(storage, address).initOutgoing({
        identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
        preKey: {
          keyId: bundle.preKeyId,
          publicKey: signalTestKeyPair(bundle.preKey).pubKey,
        },
        registrationId: bundle.registrationId,
        signedPreKey: {
          keyId: bundle.signedPreKey.keyId,
          publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
          signature: bundle.signedPreKey.signature,
        },
      });
      const cipher = new SessionCipher(storage, address);
      const encrypted = await cipher.encrypt(Buffer.from(message));
      return { cipher, ciphertext: signalCiphertext(encrypted.body), senderJid };
    };
    const accept = async (plaintext: Buffer) => plaintext;

    const first = await createSender("15550000001@s.whatsapp.net", 2, "first sender");
    await expect(
      receiver.transactDirectMessage({
        accept,
        ciphertext: first.ciphertext,
        recipientJid,
        remoteJid: first.senderJid,
        type: "pkmsg",
      }),
    ).resolves.toEqual({ status: "accepted", value: Buffer.from("first sender") });
    expect(receiver.sessionCount).toBe(1);

    const second = await createSender("15550000002@s.whatsapp.net", 3, "second sender");
    await expect(
      receiver.transactDirectMessage({
        accept: async () => undefined,
        ciphertext: second.ciphertext,
        recipientJid,
        remoteJid: second.senderJid,
        type: "pkmsg",
      }),
    ).resolves.toEqual({ status: "rejected" });
    expect(receiver.sessionCount).toBe(1);

    await expect(
      receiver.transactDirectMessage({
        accept,
        ciphertext: second.ciphertext,
        recipientJid,
        remoteJid: second.senderJid,
        type: "pkmsg",
      }),
    ).resolves.toEqual({ status: "rejected" });
    expect(receiver.sessionCount).toBe(1);

    const followUp = await first.cipher.encrypt(Buffer.from("first sender follow-up"));
    await expect(
      receiver.transactDirectMessage({
        accept,
        ciphertext: signalCiphertext(followUp.body),
        recipientJid,
        remoteJid: first.senderJid,
        type: followUp.type === 3 ? "pkmsg" : "msg",
      }),
    ).resolves.toEqual({
      status: "accepted",
      value: Buffer.from("first sender follow-up"),
    });
  });

  it("does not commit failed Signal candidate ratchet mutations", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const senderJid = "15550000001@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const senderIdentity = Curve.generateKeyPair();
    const senderStorage = createSignalTestStorage(senderIdentity, 2);
    const senderAddress = new ProtocolAddress("15551234567", 0);
    await new SessionBuilder(senderStorage, senderAddress).initOutgoing({
      identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
      preKey: {
        keyId: bundle.preKeyId,
        publicKey: signalTestKeyPair(bundle.preKey).pubKey,
      },
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
        signature: bundle.signedPreKey.signature,
      },
    });
    const sender = new SessionCipher(senderStorage, senderAddress);
    const first = await sender.encrypt(Buffer.from("first direct message"));
    expect(first.type).toBe(3);
    await expect(
      receiver.decryptDirectMessage({
        ciphertext: signalCiphertext(first.body),
        recipientJid,
        remoteJid: senderJid,
        type: "pkmsg",
      }),
    ).resolves.toEqual(Buffer.from("first direct message"));

    const second = await sender.encrypt(Buffer.from("second direct message"));
    expect(second.type).toBe(3);
    const validCiphertext = signalCiphertext(second.body);
    const invalidCiphertext = Buffer.from(validCiphertext);
    invalidCiphertext[invalidCiphertext.length - 1] = invalidCiphertext.at(-1)! ^ 0xff;
    await expect(
      receiver.decryptDirectMessage({
        ciphertext: invalidCiphertext,
        recipientJid,
        remoteJid: senderJid,
        type: "pkmsg",
      }),
    ).rejects.toThrow(/.+/u);
    await expect(
      receiver.decryptDirectMessage({
        ciphertext: validCiphertext,
        recipientJid,
        remoteJid: senderJid,
        type: "pkmsg",
      }),
    ).resolves.toEqual(Buffer.from("second direct message"));
  });

  it("commits Signal ratchets and prekey replacement only after accepted evidence persists", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const senderJid = "15550000001@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const originalPreKey = bundle.preKey;
    const originalPreKeyId = bundle.preKeyId;
    const senderIdentity = Curve.generateKeyPair();
    const senderStorage = createSignalTestStorage(senderIdentity, 2);
    const senderAddress = new ProtocolAddress("15551234567", 0);
    await new SessionBuilder(senderStorage, senderAddress).initOutgoing({
      identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
      preKey: {
        keyId: bundle.preKeyId,
        publicKey: signalTestKeyPair(bundle.preKey).pubKey,
      },
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
        signature: bundle.signedPreKey.signature,
      },
    });
    const encrypted = await new SessionCipher(senderStorage, senderAddress).encrypt(
      Buffer.from("transactional inbound"),
    );
    const ciphertext = signalCiphertext(encrypted.body);
    const ordering: string[] = [];

    await expect(
      receiver.transactDirectMessage({
        accept: async (plaintext) => {
          ordering.push("persist:start");
          expect(plaintext).toEqual(Buffer.from("transactional inbound"));
          expect(bundle.preKey).toBe(originalPreKey);
          expect(bundle.preKeyId).toBe(originalPreKeyId);
          ordering.push("persist:done");
          return true;
        },
        ciphertext,
        recipientJid,
        remoteJid: senderJid,
        type: "pkmsg",
      }),
    ).resolves.toEqual({ status: "accepted", value: true });
    ordering.push("ack");

    expect(ordering).toEqual(["persist:start", "persist:done", "ack"]);
    expect(bundle.preKey).not.toBe(originalPreKey);
    expect(bundle.preKeyId).toBe(originalPreKeyId + 1);
    expect(receiver.resolveMany([recipientJid])[0]).toMatchObject({
      preKey: bundle.preKey,
      preKeyId: originalPreKeyId + 1,
    });
    await expect(
      receiver.transactDirectMessage({
        accept: async () => true,
        ciphertext,
        recipientJid,
        remoteJid: senderJid,
        type: "pkmsg",
      }),
    ).resolves.toMatchObject({ status: "decrypt-failed" });
  });

  it("keeps Signal ciphertext retryable when accepted evidence persistence fails", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const senderJid = "15550000001@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const originalPreKey = bundle.preKey;
    const originalPreKeyId = bundle.preKeyId;
    const senderIdentity = Curve.generateKeyPair();
    const senderStorage = createSignalTestStorage(senderIdentity, 2);
    const senderAddress = new ProtocolAddress("15551234567", 0);
    await new SessionBuilder(senderStorage, senderAddress).initOutgoing({
      identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
      preKey: {
        keyId: bundle.preKeyId,
        publicKey: signalTestKeyPair(bundle.preKey).pubKey,
      },
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
        signature: bundle.signedPreKey.signature,
      },
    });
    const encrypted = await new SessionCipher(senderStorage, senderAddress).encrypt(
      Buffer.from("retry recorder failure"),
    );
    const ciphertext = signalCiphertext(encrypted.body);
    let markPersistenceStarted: () => void = () => undefined;
    let releasePersistence: () => void = () => undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceBlocked = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const failedAttempt = receiver.transactDirectMessage({
      accept: async () => {
        markPersistenceStarted();
        await persistenceBlocked;
        throw new Error("simulated recorder failure");
      },
      ciphertext,
      recipientJid,
      remoteJid: senderJid,
      type: "pkmsg",
    });
    await persistenceStarted;
    let retryAccepted = false;
    const retry = receiver.transactDirectMessage({
      accept: async (plaintext) => {
        retryAccepted = true;
        return plaintext.toString("utf8");
      },
      ciphertext,
      recipientJid,
      remoteJid: senderJid,
      type: "pkmsg",
    });
    await Promise.resolve();

    expect(retryAccepted).toBe(false);
    expect(bundle.preKey).toBe(originalPreKey);
    expect(bundle.preKeyId).toBe(originalPreKeyId);
    releasePersistence();
    await expect(failedAttempt).rejects.toThrow("simulated recorder failure");
    await expect(retry).resolves.toEqual({
      status: "accepted",
      value: "retry recorder failure",
    });
    expect(bundle.preKey).not.toBe(originalPreKey);
    expect(bundle.preKeyId).toBe(originalPreKeyId + 1);
  });

  it("deduplicates accepted evidence across reconnect acknowledgement retries", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const senderJid = "15550000001@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const originalPreKey = bundle.preKey;
    const originalPreKeyId = bundle.preKeyId;
    const senderIdentity = Curve.generateKeyPair();
    const senderStorage = createSignalTestStorage(senderIdentity, 2);
    const senderAddress = new ProtocolAddress("15551234567", 0);
    await new SessionBuilder(senderStorage, senderAddress).initOutgoing({
      identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
      preKey: {
        keyId: bundle.preKeyId,
        publicKey: signalTestKeyPair(bundle.preKey).pubKey,
      },
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
        signature: bundle.signedPreKey.signature,
      },
    });
    const encrypted = await new SessionCipher(senderStorage, senderAddress).encrypt(
      padSignalMessage(Buffer.from([0x0a, 0x05, ...Buffer.from("retry")])),
    );
    const node = signalMessageNode({
      ciphertext: signalCiphertext(encrypted.body),
      id: "retry-ack",
      recipientJid,
      type: encrypted.type,
    });
    const events: Array<{ accepted?: boolean; body?: unknown }> = [];

    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node,
        path: "/ws/chat",
        remoteJid: senderJid,
        signalBundles: receiver,
      }),
    ).resolves.toBe(true);
    expect(events).toHaveLength(1);
    expect(bundle.preKey).not.toBe(originalPreKey);
    expect(bundle.preKeyId).toBe(originalPreKeyId + 1);

    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node,
        path: "/ws/chat",
        remoteJid: senderJid,
        signalBundles: receiver,
      }),
    ).resolves.toBe(true);
    expect(events).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      accepted: true,
      body: {
        message: { conversation: "retry" },
      },
    });
    expect(bundle.preKeyId).toBe(originalPreKeyId + 1);
    receiver.markMessageAcknowledged("15557654321@s.whatsapp.net", "retry-ack");

    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node,
        path: "/ws/chat",
        remoteJid: senderJid,
        signalBundles: receiver,
      }),
    ).resolves.toBe(true);
    expect(events).toHaveLength(1);
  });

  it("commits acknowledgements received while message acceptance is pending", async () => {
    const receiver = new WhatsAppSignalBundleStore(1, 1);
    let markAcceptanceStarted!: () => void;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    let releaseAcceptance!: (accepted: boolean) => void;
    const acceptanceBlocked = new Promise<boolean>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptance = receiver.acceptMessageOnce("15557654321@s.whatsapp.net\0pending-ack", () => {
      markAcceptanceStarted();
      return acceptanceBlocked;
    });
    await acceptanceStarted;

    receiver.markMessageAcknowledged("15557654321@s.whatsapp.net", "pending-ack");
    releaseAcceptance(true);
    await expect(acceptance).resolves.toBe(true);

    const duplicateOperation = vi.fn(async () => true);
    await expect(
      receiver.acceptMessageOnce("15557654321@s.whatsapp.net\0pending-ack", duplicateOperation),
    ).resolves.toBe(true);
    expect(duplicateOperation).not.toHaveBeenCalled();
    await expect(
      receiver.acceptMessageOnce("15557654321@s.whatsapp.net\0next", async () => true),
    ).resolves.toBe(true);
  });

  it("bounds aggregate acceptance work without blocking unrelated message keys", async () => {
    const receiver = new WhatsAppSignalBundleStore(1, 2);
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: (accepted: boolean) => void;
    const firstBlocked = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const first = receiver.acceptMessageOnce("peer\0first", () => {
      markFirstStarted();
      return firstBlocked;
    });
    await firstStarted;

    const secondOperation = vi.fn(async () => true);
    await expect(receiver.acceptMessageOnce("peer\0second", secondOperation)).resolves.toBe(true);
    expect(secondOperation).toHaveBeenCalledOnce();
    await expect(receiver.acceptMessageOnce("peer\0overflow", async () => true)).rejects.toThrow(
      "pending acknowledgement limit exceeded (2)",
    );

    releaseFirst(true);
    await expect(first).resolves.toBe(true);
  });

  it("shares a pending false acceptance with concurrent duplicates", async () => {
    const receiver = new WhatsAppSignalBundleStore(1, 1);
    let markAcceptanceStarted!: () => void;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    let releaseAcceptance!: (accepted: boolean) => void;
    const acceptanceBlocked = new Promise<boolean>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptance = receiver.acceptMessageOnce("15557654321@s.whatsapp.net\0false-ack", () => {
      markAcceptanceStarted();
      return acceptanceBlocked;
    });
    await acceptanceStarted;

    receiver.markMessageAcknowledged("15557654321@s.whatsapp.net", "false-ack");
    const duplicateOperation = vi.fn(async () => true);
    const duplicate = receiver.acceptMessageOnce(
      "15557654321@s.whatsapp.net\0false-ack",
      duplicateOperation,
    );
    let duplicateSettled = false;
    void duplicate.finally(() => {
      duplicateSettled = true;
    });
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    releaseAcceptance(false);

    await expect(acceptance).resolves.toBe(false);
    await expect(duplicate).resolves.toBe(false);
    expect(duplicateOperation).not.toHaveBeenCalled();

    const retryOperation = vi.fn(async () => true);
    await expect(
      receiver.acceptMessageOnce("15557654321@s.whatsapp.net\0false-ack", retryOperation),
    ).resolves.toBe(true);
    expect(retryOperation).toHaveBeenCalledOnce();
  });

  it("shares a pending rejection with concurrent duplicates", async () => {
    const receiver = new WhatsAppSignalBundleStore(1, 1);
    let markAcceptanceStarted!: () => void;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    let rejectAcceptance!: (error: Error) => void;
    const acceptanceBlocked = new Promise<boolean>((_resolve, reject) => {
      rejectAcceptance = reject;
    });
    const acceptance = receiver.acceptMessageOnce(
      "15557654321@s.whatsapp.net\0rejected-ack",
      () => {
        markAcceptanceStarted();
        return acceptanceBlocked;
      },
    );
    await acceptanceStarted;

    receiver.markMessageAcknowledged("15557654321@s.whatsapp.net", "rejected-ack");
    const duplicateOperation = vi.fn(async () => true);
    const duplicate = receiver.acceptMessageOnce(
      "15557654321@s.whatsapp.net\0rejected-ack",
      duplicateOperation,
    );
    let duplicateSettled = false;
    void duplicate
      .catch(() => undefined)
      .finally(() => {
        duplicateSettled = true;
      });
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    const outcomes = Promise.allSettled([acceptance, duplicate]);
    rejectAcceptance(new Error("simulated acceptance failure"));
    await expect(outcomes).resolves.toEqual([
      {
        reason: expect.objectContaining({ message: "simulated acceptance failure" }),
        status: "rejected",
      },
      {
        reason: expect.objectContaining({ message: "simulated acceptance failure" }),
        status: "rejected",
      },
    ]);
    expect(duplicateOperation).not.toHaveBeenCalled();

    const retryOperation = vi.fn(async () => true);
    await expect(
      receiver.acceptMessageOnce("15557654321@s.whatsapp.net\0rejected-ack", retryOperation),
    ).resolves.toBe(true);
    expect(retryOperation).toHaveBeenCalledOnce();
  });

  it("recovers expired pending acknowledgement capacity without duplicate delivery", async () => {
    let now = 0;
    const receiver = new WhatsAppSignalBundleStore(1, 1, 2, 100, () => now);
    const firstNode: BinaryNode = {
      attrs: { id: "first", to: "15557654321@s.whatsapp.net" },
      tag: "message",
    };
    const secondNode: BinaryNode = {
      attrs: { id: "second", to: "15557654321@s.whatsapp.net" },
      tag: "message",
    };
    const events: unknown[] = [];
    const persist = (node: BinaryNode) =>
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node,
        path: "/ws/chat",
        remoteJid: "15550000001@s.whatsapp.net",
        signalBundles: receiver,
      });

    await expect(persist(firstNode)).resolves.toBe(true);
    await expect(persist(secondNode)).rejects.toThrow(
      "WhatsApp pending acknowledgement limit exceeded (1).",
    );
    expect(events).toHaveLength(1);

    now = 99;
    await expect(persist(secondNode)).rejects.toThrow(
      "WhatsApp pending acknowledgement limit exceeded (1).",
    );
    now = 100;
    await expect(persist(secondNode)).resolves.toBe(true);
    expect(events).toHaveLength(2);

    await expect(persist(firstNode)).resolves.toBe(true);
    expect(events).toHaveLength(2);
  });

  it("commits and acknowledges decryptable unsupported payloads before later text", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const senderJid = "15550000001@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const senderIdentity = Curve.generateKeyPair();
    const senderStorage = createSignalTestStorage(senderIdentity, 2);
    const senderAddress = new ProtocolAddress("15551234567", 0);
    await new SessionBuilder(senderStorage, senderAddress).initOutgoing({
      identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
      preKey: {
        keyId: bundle.preKeyId,
        publicKey: signalTestKeyPair(bundle.preKey).pubKey,
      },
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
        signature: bundle.signedPreKey.signature,
      },
    });
    const sender = new SessionCipher(senderStorage, senderAddress);
    const unsupported = await sender.encrypt(padSignalMessage(Buffer.from([0x12, 0x01, 0x00])));
    const events: Array<{ accepted?: boolean; body?: unknown }> = [];

    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node: signalMessageNode({
          ciphertext: signalCiphertext(unsupported.body),
          id: "unsupported",
          recipientJid,
          type: unsupported.type,
        }),
        path: "/ws/chat",
        remoteJid: senderJid,
        signalBundles: receiver,
      }),
    ).resolves.toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        accepted: true,
        body: expect.objectContaining({ tag: "message" }),
      }),
    );

    const text = Buffer.from("text after unsupported", "utf8");
    const supported = await sender.encrypt(
      padSignalMessage(Buffer.from([0x0a, text.byteLength, ...text])),
    );
    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node: signalMessageNode({
          ciphertext: signalCiphertext(supported.body),
          id: "supported",
          recipientJid,
          type: supported.type,
        }),
        path: "/ws/chat",
        remoteJid: senderJid,
        signalBundles: receiver,
      }),
    ).resolves.toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        accepted: true,
        body: expect.objectContaining({
          message: { conversation: "text after unsupported" },
        }),
      }),
    );
  });

  it("persists unsupported message envelopes before allowing acknowledgement", async () => {
    const node: BinaryNode = {
      attrs: {
        id: "unsupported-envelope",
        to: "15557654321@s.whatsapp.net",
      },
      content: [
        {
          attrs: { type: "skmsg" },
          content: Buffer.from("sender-key-envelope"),
          tag: "enc",
        },
      ],
      tag: "message",
    };
    const events: Array<{ accepted?: boolean; body?: unknown }> = [];

    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async (event) => {
          events.push(event);
        },
        node,
        path: "/ws/chat",
        remoteJid: "15550000001@s.whatsapp.net",
        signalBundles: new WhatsAppSignalBundleStore(1),
      }),
    ).resolves.toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        accepted: true,
        body: expect.objectContaining({
          attrs: expect.objectContaining({ id: "unsupported-envelope" }),
          tag: "message",
        }),
      }),
    );

    await expect(
      persistAcceptedBaileysMessage({
        appendEvent: async () => {
          throw new Error("simulated recorder failure");
        },
        node,
        path: "/ws/chat",
        remoteJid: "15550000001@s.whatsapp.net",
        signalBundles: new WhatsAppSignalBundleStore(1),
      }),
    ).rejects.toThrow("simulated recorder failure");
  });

  it("serializes first-contact Signal transactions by recipient bundle", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const createSender = async (senderJid: string, registrationId: number) => {
      const identity = Curve.generateKeyPair();
      const storage = createSignalTestStorage(identity, registrationId);
      const address = new ProtocolAddress("15551234567", 0);
      await new SessionBuilder(storage, address).initOutgoing({
        identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
        preKey: {
          keyId: bundle.preKeyId,
          publicKey: signalTestKeyPair(bundle.preKey).pubKey,
        },
        registrationId: bundle.registrationId,
        signedPreKey: {
          keyId: bundle.signedPreKey.keyId,
          publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
          signature: bundle.signedPreKey.signature,
        },
      });
      const encrypted = await new SessionCipher(storage, address).encrypt(
        Buffer.from(`first contact from ${senderJid}`),
      );
      return { ciphertext: signalCiphertext(encrypted.body), senderJid };
    };
    const firstSender = await createSender("15550000001@s.whatsapp.net", 2);
    const secondSender = await createSender("15550000002@s.whatsapp.net", 3);
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let secondStarted = false;
    const first = receiver.transactDirectMessage({
      accept: async () => {
        markFirstStarted();
        await firstBlocked;
        return true;
      },
      ciphertext: firstSender.ciphertext,
      recipientJid,
      remoteJid: firstSender.senderJid,
      type: "pkmsg",
    });
    await firstStarted;
    const second = receiver.transactDirectMessage({
      accept: async () => {
        secondStarted = true;
        return true;
      },
      ciphertext: secondSender.ciphertext,
      recipientJid,
      remoteJid: secondSender.senderJid,
      type: "pkmsg",
    });
    await Promise.resolve();

    expect(secondStarted).toBe(false);
    releaseFirst();
    await expect(first).resolves.toEqual({ status: "accepted", value: true });
    await expect(second).resolves.toMatchObject({ status: "decrypt-failed" });
  });

  it("generates replacement prekeys before accepted evidence persists", async () => {
    const recipientJid = "15551234567@s.whatsapp.net";
    const senderJid = "15550000001@s.whatsapp.net";
    const receiver = new WhatsAppSignalBundleStore(1);
    const bundle = receiver.resolveMany([recipientJid])[0]!;
    const senderIdentity = Curve.generateKeyPair();
    const senderStorage = createSignalTestStorage(senderIdentity, 2);
    const senderAddress = new ProtocolAddress("15551234567", 0);
    await new SessionBuilder(senderStorage, senderAddress).initOutgoing({
      identityKey: signalTestKeyPair(bundle.identityKey).pubKey,
      preKey: {
        keyId: bundle.preKeyId,
        publicKey: signalTestKeyPair(bundle.preKey).pubKey,
      },
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: signalTestKeyPair(bundle.signedPreKey.keyPair).pubKey,
        signature: bundle.signedPreKey.signature,
      },
    });
    const encrypted = await new SessionCipher(senderStorage, senderAddress).encrypt(
      Buffer.from("prekey generation ordering"),
    );
    const generateKeyPair = vi.spyOn(Curve, "generateKeyPair").mockImplementationOnce(() => {
      throw new Error("simulated replacement prekey failure");
    });
    let persisted = false;

    await expect(
      receiver.transactDirectMessage({
        accept: async () => {
          persisted = true;
          return true;
        },
        ciphertext: signalCiphertext(encrypted.body),
        recipientJid,
        remoteJid: senderJid,
        type: "pkmsg",
      }),
    ).rejects.toThrow("simulated replacement prekey failure");
    expect(persisted).toBe(false);
    generateKeyPair.mockRestore();
  });

  it("drains unauthorized request bodies before reusing the connection", async () => {
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
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

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
    try {
      const unauthorizedOversized = await requestHttp({
        agent,
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
      expect(
        (
          await requestHttp({
            agent,
            headers: { authorization: "Bearer fake" },
            method: "GET",
            url: server.manifest.endpoints.phoneNumberUrl,
          })
        ).status,
      ).toBe(200);

      const unauthorizedAdmin = await requestHttp({
        agent,
        body: Buffer.alloc(1024 * 1024 + 1, 0x20),
        headers: {
          "content-length": String(1024 * 1024 + 1),
          "content-type": "application/json",
        },
        method: "POST",
        url: server.manifest.endpoints.adminInboundUrl,
      });
      expect(unauthorizedAdmin.status).toBe(401);
      expect(
        (
          await requestHttp({
            agent,
            headers: { authorization: "Bearer fake" },
            method: "GET",
            url: server.manifest.endpoints.phoneNumberUrl,
          })
        ).status,
      ).toBe(200);
    } finally {
      agent.destroy();
    }

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
    expect(observed).toHaveLength(3);
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: new URL(server.manifest.endpoints.phoneNumberUrl).pathname,
          type: "api",
        }),
      ]),
    );
  });

  it("drains request bodies on early 404 routes", async () => {
    const server = await startWhatsAppServer({
      accessToken: "fake",
      adminToken: "admin",
    });
    servers.push(server);
    const body = JSON.stringify({ text: "discard this body" });
    const routes = [
      { method: "PUT", url: server.manifest.endpoints.adminInboundUrl },
      { method: "GET", url: server.manifest.endpoints.messagesUrl },
      { method: "POST", url: `${server.manifest.baseUrl}/v25.0/unknown` },
    ];

    for (const route of routes) {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const rejected = await requestHttp({
          agent,
          body,
          headers: {
            authorization: "Bearer fake",
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
            [ADMIN_TOKEN_HEADER]: "admin",
          },
          method: route.method,
          url: route.url,
        });
        expect(rejected.status).toBe(404);
        const accepted = await requestHttp({
          agent,
          headers: { authorization: "Bearer fake" },
          method: "GET",
          url: server.manifest.endpoints.phoneNumberUrl,
        });
        expect(accepted.status).toBe(200);
      } finally {
        agent.destroy();
      }
    }
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

  it("records successful read-status requests as accepted provider operations", async () => {
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

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatJid: "15551234567@s.whatsapp.net",
        messageId: "wamid.status",
        senderJid: "15551234567@s.whatsapp.net",
        text: "read me",
      }),
      headers: {
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);

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
        accepted: true,
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
      await expect(
        socket.query({
          attrs: {
            to: "120363001234567890@g.us",
            type: "set",
            xmlns: "w:g2",
          },
          content: [{ attrs: {}, content: Buffer.from("unsupported mutation"), tag: "subject" }],
          tag: "iq",
        }),
      ).rejects.toThrow("unsupported group operation");
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
          fs
            .readFile(server.manifest.recorderPath, "utf8")
            .then((recorder) =>
              recorder
                .trim()
                .split("\n")
                .some((line) => {
                  const event: unknown = JSON.parse(line);
                  return (
                    !!event &&
                    typeof event === "object" &&
                    "accepted" in event &&
                    event.accepted === true &&
                    "body" in event &&
                    !!event.body &&
                    typeof event.body === "object" &&
                    "message" in event.body &&
                    !!event.body.message &&
                    typeof event.body.message === "object" &&
                    "conversation" in event.body.message &&
                    event.body.message.conversation === "hello through real baileys"
                  );
                }),
            )
            .catch(() => false),
        "accepted WhatsApp Baileys recorder event",
      );
      const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
      expect(recorder).toContain('"method":"WEBSOCKET"');
      expect(recorder).toContain('"tag":"message"');
      expect(recorder).toContain('"to":"15551234567@s.whatsapp.net"');
      const recorderEvents = recorder
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      const acceptedEvent = recorderEvents.find(
        (event) =>
          !!event &&
          typeof event === "object" &&
          "accepted" in event &&
          event.accepted === true &&
          "method" in event &&
          event.method === "WEBSOCKET",
      );
      expect(acceptedEvent).toMatchObject({
        accepted: true,
        body: {
          key: {
            fromMe: true,
            remoteJid: "15551234567@s.whatsapp.net",
          },
          message: { conversation: "hello through real baileys" },
        },
        method: "WEBSOCKET",
        path: "/ws/chat",
        type: "api",
      });
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          event: acceptedEvent,
          manifest: server.manifest,
          targetByProviderTarget: new Map([["15551234567@s.whatsapp.net", "dm:alice"]]),
        }),
      ).toEqual({
        accountId: "default",
        senderId: "openclaw",
        senderName: "OpenClaw QA",
        text: "hello through real baileys",
        to: "dm:alice",
      });
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
