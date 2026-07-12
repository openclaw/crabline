import { Buffer } from "node:buffer";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  aesDecryptGCM,
  aesEncryptGCM,
  Curve,
  encodeBigEndian,
  hkdf,
  NOISE_MODE,
  NOISE_WA_HEADER,
  sha256,
  signedKeyPair,
  type KeyPair,
  type SignedKeyPair,
} from "./whatsapp-wire/crypto.js";
import {
  decodeBinaryNode,
  encodeBinaryNode,
  S_WHATSAPP_NET,
  type BinaryNode,
} from "./whatsapp-wire/binary-node.js";
import { decodeHandshakeMessage, encodeHandshakeMessage } from "./whatsapp-wire/handshake.js";
import { KEY_BUNDLE_TYPE, xmppPreKey, xmppSignedPreKey } from "./whatsapp-wire/signal.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ServerRequestEvent } from "./http.js";
import { closeWebSocketServer } from "./websocket.js";

// Keep the local server independent from Baileys at runtime. Tests use Baileys
// as a black-box client to verify this narrow WhatsApp Web wire subset.
const EMPTY_BUFFER = Buffer.alloc(0);
const IV_LENGTH = 12;
const MAX_PENDING_INBOUND_MESSAGES = 1_000;
export const MAX_WHATSAPP_SIGNAL_BUNDLES = 1_024;
const SIGNAL_BUNDLE_JID_RE = /^\d{7,15}(?::\d+)?@(?:s\.whatsapp\.net|lid)$/iu;
type NodeBuffer = Buffer<ArrayBufferLike>;
const WHATSAPP_NOISE_CERT_CHAIN = Buffer.from(
  "CncKMwjjAhADGiCRKg7Kg1iu4CSulwLBaxX51Tefw6VXGgZqcr5OEbXIRiDQ04bOBijQjZ/TBhJA34Bj82jAHhLpCWBNVBlGnFDieamd8+138S57uMt9ke9mrn5r4+VepwBPKEgHjob6bR70rlCmWDkxZv+CfVjIAxJ2CjIIAxAAGiAcUamsMDmUxsjQuS6hh4pTNHZZnMWZ++o1mX2aqQzOYiCAka6+Bij/3rfcBhJAJw8pRkhTn+1IcOJQVN1OlZg6uikYnCumyO7acFVVX3U3QPXsGSq2TCbCbWrebSC593Su43EgprIDlfU8ZgWFBw==",
  "base64",
);

export type WhatsAppBaileysWebSocketServer = {
  close(): Promise<void>;
  prepareInboundMessage(
    message: WhatsAppBaileysInboundMessage,
  ): PreparedWhatsAppBaileysInboundDelivery | undefined;
};

export type WhatsAppBaileysWebSocketServerParams = {
  accessToken: string;
  appendEvent(event: ServerRequestEvent): Promise<void>;
  httpServer: Server;
  maxPendingInboundMessages?: number | undefined;
  path: string;
  selfJid: string;
};

export type PreparedWhatsAppBaileysInboundDelivery = {
  cancel(): void;
  commit(): "delivered" | "queued";
};

export type WhatsAppBaileysInboundMessage = {
  key: {
    fromMe: boolean;
    id: string;
    participant?: string | undefined;
    remoteJid: string;
  };
  message: {
    conversation: string;
  };
  messageTimestamp: number;
  pushName?: string | undefined;
};

export function resolveMaxPendingWhatsAppInboundMessages(value: number | undefined): number {
  const resolved = value ?? MAX_PENDING_INBOUND_MESSAGES;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("WhatsApp maxPendingInboundMessages must be a positive safe integer.");
  }
  return resolved;
}

export type MockSignalBundle = {
  identityKey: KeyPair;
  preKey: KeyPair;
  preKeyId: number;
  registrationId: number;
  signedPreKey: SignedKeyPair;
};

export class WhatsAppSignalBundleStore {
  readonly #bundles = new Map<string, MockSignalBundle>();

  constructor(private readonly maxBundles = MAX_WHATSAPP_SIGNAL_BUNDLES) {
    if (!Number.isSafeInteger(maxBundles) || maxBundles < 1) {
      throw new Error("WhatsApp maxSignalBundles must be a positive safe integer.");
    }
  }

  get size(): number {
    return this.#bundles.size;
  }

  resolveMany(jids: string[]): MockSignalBundle[] {
    const uniqueNewJids = new Set<string>();
    for (const jid of jids) {
      if (!SIGNAL_BUNDLE_JID_RE.test(jid)) {
        throw new Error(`Invalid WhatsApp signal bundle JID: ${jid}.`);
      }
      if (!this.#bundles.has(jid)) {
        uniqueNewJids.add(jid);
      }
    }
    if (this.#bundles.size + uniqueNewJids.size > this.maxBundles) {
      throw new Error(`WhatsApp signal bundle limit exceeded (${this.maxBundles}).`);
    }
    return jids.map((jid) => this.#resolve(jid));
  }

  #resolve(jid: string): MockSignalBundle {
    const existing = this.#bundles.get(jid);
    if (existing) {
      return existing;
    }
    const identityKey = Curve.generateKeyPair();
    const bundle = {
      identityKey,
      preKey: Curve.generateKeyPair(),
      preKeyId: 1,
      registrationId: 1,
      signedPreKey: signedKeyPair(identityKey, 1),
    };
    this.#bundles.set(jid, bundle);
    return bundle;
  }
}

export function createSerializedMessageHandler<T>(
  processMessage: (message: T) => Promise<void>,
  onError: (error: unknown) => void,
): (message: T) => Promise<void> {
  let failed = false;
  let pending = Promise.resolve();
  return (message) => {
    const next = pending.then(async () => {
      if (!failed) {
        await processMessage(message);
      }
    });
    pending = next.catch((error: unknown) => {
      if (!failed) {
        failed = true;
        onError(error);
      }
    });
    return pending;
  };
}

class TransportState {
  #readCounter = 0;
  #writeCounter = 0;

  constructor(
    private readonly encKey: NodeBuffer,
    private readonly decKey: NodeBuffer,
  ) {}

  decrypt(ciphertext: Uint8Array): NodeBuffer {
    const iv = createIv(this.#readCounter++);
    return aesDecryptGCM(Buffer.from(ciphertext), this.decKey, iv, EMPTY_BUFFER);
  }

  encrypt(plaintext: Uint8Array): NodeBuffer {
    const iv = createIv(this.#writeCounter++);
    return aesEncryptGCM(Buffer.from(plaintext), this.encKey, iv, EMPTY_BUFFER);
  }
}

class BaileysNoiseServer {
  #counter = 0;
  #decKey: NodeBuffer;
  #encKey: NodeBuffer;
  #expectIntro = true;
  #hash: NodeBuffer;
  #inBytes: NodeBuffer = Buffer.alloc(0);
  #salt: NodeBuffer;
  #serverEphemeralKey: KeyPair | undefined;
  #serverStaticKey: KeyPair | undefined;
  #transport: TransportState | undefined;

  constructor() {
    const initial = Buffer.from(NOISE_MODE);
    this.#hash = Buffer.from(initial.byteLength === 32 ? initial : sha256(initial));
    this.#salt = this.#hash;
    this.#encKey = this.#hash;
    this.#decKey = this.#hash;
    this.#authenticate(NOISE_WA_HEADER);
  }

  decodeFrames(data: RawData): NodeBuffer[] {
    let chunk: NodeBuffer = Buffer.from(
      Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
    );
    if (this.#expectIntro) {
      chunk = this.#removeIntroHeader(chunk);
      this.#expectIntro = false;
    }
    this.#inBytes = this.#inBytes.length ? Buffer.concat([this.#inBytes, chunk]) : chunk;
    const frames: NodeBuffer[] = [];
    while (this.#inBytes.length >= 3) {
      const head0 = this.#inBytes[0];
      const head1 = this.#inBytes[1];
      const head2 = this.#inBytes[2];
      if (head0 === undefined || head1 === undefined || head2 === undefined) {
        break;
      }
      const size = (head0 << 16) | (head1 << 8) | head2;
      if (this.#inBytes.length < size + 3) {
        break;
      }
      frames.push(this.#inBytes.subarray(3, size + 3));
      this.#inBytes = this.#inBytes.subarray(size + 3);
    }
    return frames;
  }

  async decodeTransportNode(frame: Uint8Array): Promise<BinaryNode> {
    if (!this.#transport) {
      throw new Error("Cannot decode a Baileys node before the Noise transport is ready.");
    }
    return await decodeBinaryNode(this.#transport.decrypt(frame));
  }

  finishClientHandshake(frame: Uint8Array): void {
    const message = decodeHandshakeMessage(frame);
    const finish = message.clientFinish;
    if (!finish?.staticKey || !finish.payload || !this.#serverEphemeralKey) {
      throw new Error("Invalid Baileys client finish handshake.");
    }
    const clientNoisePublic = this.#decrypt(finish.staticKey);
    this.#mixIntoKey(Curve.sharedKey(this.#serverEphemeralKey.private, clientNoisePublic));
    this.#decrypt(finish.payload);
    const [writeKey, readKey] = this.#localHKDF(EMPTY_BUFFER);
    this.#transport = new TransportState(readKey, writeKey);
  }

  createServerHello(frame: Uint8Array): NodeBuffer {
    const message = decodeHandshakeMessage(frame);
    const clientHello = message.clientHello;
    if (!clientHello?.ephemeral) {
      throw new Error("Invalid Baileys client hello handshake.");
    }

    this.#authenticate(clientHello.ephemeral);
    this.#serverEphemeralKey = Curve.generateKeyPair();
    this.#serverStaticKey = Curve.generateKeyPair();
    this.#authenticate(this.#serverEphemeralKey.public);
    this.#mixIntoKey(Curve.sharedKey(this.#serverEphemeralKey.private, clientHello.ephemeral));
    const staticKey = this.#encrypt(this.#serverStaticKey.public);
    this.#mixIntoKey(Curve.sharedKey(this.#serverStaticKey.private, clientHello.ephemeral));
    const payload = this.#encrypt(WHATSAPP_NOISE_CERT_CHAIN);
    return encodeLengthPrefixed(
      encodeHandshakeMessage({
        serverHello: {
          ephemeral: this.#serverEphemeralKey.public,
          payload,
          staticKey,
        },
      }),
    );
  }

  encodeNode(node: BinaryNode): NodeBuffer {
    if (!this.#transport) {
      throw new Error("Cannot encode a Baileys node before the Noise transport is ready.");
    }
    return encodeLengthPrefixed(this.#transport.encrypt(encodeBinaryNode(node)));
  }

  #authenticate(data: Uint8Array) {
    this.#hash = sha256(Buffer.concat([this.#hash, Buffer.from(data)]));
  }

  #decrypt(ciphertext: Uint8Array): NodeBuffer {
    const result = aesDecryptGCM(
      Buffer.from(ciphertext),
      this.#decKey,
      createIv(this.#counter++),
      this.#hash,
    );
    this.#authenticate(ciphertext);
    return result;
  }

  #encrypt(plaintext: Uint8Array): NodeBuffer {
    const result = aesEncryptGCM(
      Buffer.from(plaintext),
      this.#encKey,
      createIv(this.#counter++),
      this.#hash,
    );
    this.#authenticate(result);
    return result;
  }

  #localHKDF(data: Uint8Array): [NodeBuffer, NodeBuffer] {
    const key = hkdf(Buffer.from(data), 64, { info: "", salt: this.#salt });
    return [Buffer.from(key.subarray(0, 32)), Buffer.from(key.subarray(32))];
  }

  #mixIntoKey(data: Uint8Array) {
    const [writeKey, readKey] = this.#localHKDF(data);
    this.#salt = writeKey;
    this.#encKey = readKey;
    this.#decKey = readKey;
    this.#counter = 0;
  }

  #removeIntroHeader(chunk: NodeBuffer): NodeBuffer {
    if (chunk.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER)) {
      return chunk.subarray(NOISE_WA_HEADER.length);
    }
    if (chunk.length >= 11 && chunk.subarray(0, 2).toString("utf8") === "ED" && chunk[3] === 1) {
      const routingInfoPrefix = chunk[4];
      if (routingInfoPrefix === undefined) {
        throw new Error("Invalid Baileys Noise routing header.");
      }
      const routingInfoLength = (routingInfoPrefix << 16) | chunk.readUInt16BE(5);
      const headerLength = 7 + routingInfoLength + NOISE_WA_HEADER.length;
      if (
        chunk.subarray(headerLength - NOISE_WA_HEADER.length, headerLength).equals(NOISE_WA_HEADER)
      ) {
        return chunk.subarray(headerLength);
      }
    }
    throw new Error("Invalid Baileys Noise intro header.");
  }
}

class WhatsAppBaileysWebSocketSession {
  #handshakeState: "client-finish" | "client-hello" | "open" = "client-hello";
  readonly #handleSerializedMessage: (data: RawData) => Promise<void>;
  readonly #noise = new BaileysNoiseServer();

  constructor(
    private readonly socket: WebSocket,
    private readonly params: {
      appendEvent(event: ServerRequestEvent): Promise<void>;
      path: string;
      onOpen(session: WhatsAppBaileysWebSocketSession): void;
      selfJid: string;
      signalBundles: WhatsAppSignalBundleStore;
    },
  ) {
    this.#handleSerializedMessage = createSerializedMessageHandler(
      (data) => this.#handleMessage(data),
      (error) => {
        this.socket.close(1011, error instanceof Error ? error.message : String(error));
      },
    );
  }

  get isOpen(): boolean {
    return this.#handshakeState === "open" && this.socket.readyState === WebSocket.OPEN;
  }

  handleMessage(data: RawData): void {
    void this.#handleSerializedMessage(data);
  }

  deliverInboundMessage(message: WhatsAppBaileysInboundMessage): boolean {
    if (!this.isOpen) {
      return false;
    }
    this.#sendNode(createInboundMessageNode(message));
    return true;
  }

  async #handleMessage(data: RawData): Promise<void> {
    for (const frame of this.#noise.decodeFrames(data)) {
      if (this.#handshakeState === "client-hello") {
        this.socket.send(this.#noise.createServerHello(frame));
        this.#handshakeState = "client-finish";
        continue;
      }
      if (this.#handshakeState === "client-finish") {
        this.#noise.finishClientHandshake(frame);
        this.#handshakeState = "open";
        this.#sendNode({
          attrs: {
            lid: lidForJid(this.params.selfJid),
            t: unixSeconds(),
          },
          tag: "success",
        });
        this.#sendNode({
          attrs: {},
          content: [{ attrs: { count: "0" }, tag: "offline" }],
          tag: "ib",
        });
        this.params.onOpen(this);
        continue;
      }
      await this.#handleNode(await this.#noise.decodeTransportNode(frame));
    }
  }

  async #handleNode(node: BinaryNode): Promise<void> {
    await this.#recordNode(node);
    if (node.tag === "iq") {
      this.#sendNode(this.#createIqResult(node));
      return;
    }
    if (node.tag === "message") {
      const peer = requireAttr(node, "to");
      this.#sendNode({
        attrs: {
          class: "message",
          from: peer,
          id: requireAttr(node, "id"),
          to: this.params.selfJid,
          ...(node.attrs.type ? { type: node.attrs.type } : {}),
        },
        tag: "ack",
      });
    }
  }

  #createIqResult(node: BinaryNode): BinaryNode {
    const child = firstChild(node);
    const id = requireAttr(node, "id");
    const attrs = {
      from: node.attrs.to ?? S_WHATSAPP_NET,
      id,
      t: unixSeconds(),
      type: "result",
    };

    if (node.attrs.xmlns === "encrypt" && child?.tag === "count") {
      return { attrs, content: [{ attrs: { value: "50" }, tag: "count" }], tag: "iq" };
    }
    if (node.attrs.xmlns === "encrypt" && child?.tag === "digest") {
      return { attrs, content: [{ attrs: {}, tag: "digest" }], tag: "iq" };
    }
    if (node.attrs.xmlns === "encrypt" && child?.tag === "key") {
      try {
        return { attrs, content: [this.#createKeyList(child)], tag: "iq" };
      } catch (error) {
        return {
          attrs: { ...attrs, type: "error" },
          content: [
            {
              attrs: {
                code: "400",
                text: error instanceof Error ? error.message : String(error),
                type: "modify",
              },
              tag: "error",
            },
          ],
          tag: "iq",
        };
      }
    }
    if (node.attrs.xmlns === "usync" && child?.tag === "usync") {
      return { attrs, content: [this.#createUSyncResult(child)], tag: "iq" };
    }
    if (node.attrs.xmlns === "abt") {
      return {
        attrs,
        content: [
          {
            attrs: { hash: "mock" },
            content: [
              { attrs: { name: "10518", value: "false" }, tag: "prop" },
              { attrs: { name: "14303", value: "false" }, tag: "prop" },
            ],
            tag: "props",
          },
        ],
        tag: "iq",
      };
    }
    if (node.attrs.xmlns === "blocklist") {
      return { attrs, content: [{ attrs: {}, content: [], tag: "list" }], tag: "iq" };
    }
    if (node.attrs.xmlns === "privacy") {
      return {
        attrs,
        content: [
          {
            attrs: {},
            content: [
              { attrs: { name: "readreceipts", value: "all" }, tag: "category" },
              { attrs: { name: "profile", value: "all" }, tag: "category" },
            ],
            tag: "privacy",
          },
        ],
        tag: "iq",
      };
    }
    if (node.attrs.xmlns === "w:m" && child?.tag === "media_conn") {
      return {
        attrs,
        content: [
          {
            attrs: { auth: "mock", ttl: "3600" },
            content: [
              {
                attrs: {
                  hostname: "127.0.0.1",
                  maxContentLengthBytes: "10485760",
                },
                tag: "host",
              },
            ],
            tag: "media_conn",
          },
        ],
        tag: "iq",
      };
    }
    if (node.attrs.xmlns === "w:g2") {
      return {
        attrs,
        content: [
          {
            attrs: {
              id: node.attrs.to ?? "120363000000000000@g.us",
              owner: this.params.selfJid,
              subject: "Test Group",
              s_t: unixSeconds(),
            },
            content: [{ attrs: { jid: this.params.selfJid }, tag: "participant" }],
            tag: "group",
          },
        ],
        tag: "iq",
      };
    }
    return { attrs, tag: "iq" };
  }

  #createKeyList(keyNode: BinaryNode): BinaryNode {
    const users = children(keyNode).filter((child) => child.tag === "user");
    const jids = users.map((userNode) => requireAttr(userNode, "jid"));
    const bundles = this.params.signalBundles.resolveMany(jids);
    return {
      attrs: {},
      content: jids.map((jid, index) => this.#createKeyUser(jid, bundles[index]!)),
      tag: "list",
    };
  }

  #createKeyUser(jid: string, bundle: MockSignalBundle): BinaryNode {
    return {
      attrs: { jid },
      content: [
        { attrs: {}, content: encodeBigEndian(bundle.registrationId), tag: "registration" },
        { attrs: {}, content: KEY_BUNDLE_TYPE, tag: "type" },
        { attrs: {}, content: bundle.identityKey.public, tag: "identity" },
        xmppSignedPreKey(bundle.signedPreKey),
        xmppPreKey(bundle.preKey, bundle.preKeyId),
      ],
      tag: "user",
    };
  }

  #createUSyncResult(usyncNode: BinaryNode): BinaryNode {
    const requestList = children(usyncNode).find((child) => child.tag === "list");
    const requestedUsers = requestList
      ? children(requestList).filter((child) => child.tag === "user")
      : [];
    return {
      attrs: {
        index: usyncNode.attrs.index ?? "0",
        last: "true",
        sid: usyncNode.attrs.sid ?? "mock",
      },
      content: [
        {
          attrs: {},
          content: requestedUsers.map((user) => this.#createUSyncUser(requireAttr(user, "jid"))),
          tag: "list",
        },
      ],
      tag: "usync",
    };
  }

  #createUSyncUser(jid: string): BinaryNode {
    return {
      attrs: { jid },
      content: [
        {
          attrs: {},
          content: [
            {
              attrs: {},
              content: [{ attrs: { id: "0" }, tag: "device" }],
              tag: "device-list",
            },
          ],
          tag: "devices",
        },
        { attrs: { val: lidForJid(jid) }, tag: "lid" },
      ],
      tag: "user",
    };
  }

  async #recordNode(node: BinaryNode): Promise<void> {
    await this.params.appendEvent({
      at: new Date().toISOString(),
      body: sanitizeNodeForJson(node),
      method: "WEBSOCKET",
      path: this.params.path,
      query: {},
      type: "api",
    });
  }

  #sendNode(node: BinaryNode): void {
    this.socket.send(this.#noise.encodeNode(node));
  }
}

export function attachWhatsAppBaileysWebSocketServer(
  params: WhatsAppBaileysWebSocketServerParams,
): WhatsAppBaileysWebSocketServer {
  const signalBundles = new WhatsAppSignalBundleStore();
  const sessions = new Set<WhatsAppBaileysWebSocketSession>();
  const pendingMessages: WhatsAppBaileysInboundMessage[] = [];
  const maxPendingInboundMessages = resolveMaxPendingWhatsAppInboundMessages(
    params.maxPendingInboundMessages,
  );
  let pendingReservations = 0;
  const wss = new WebSocketServer({ noServer: true });
  const flushPendingMessages = (session: WhatsAppBaileysWebSocketSession) => {
    while (pendingMessages.length > 0) {
      const message = pendingMessages[0];
      if (!message || !session.deliverInboundMessage(message)) {
        return;
      }
      pendingMessages.shift();
    }
  };
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== params.path) {
      socket.destroy();
      return;
    }
    if (url.searchParams.get("access_token") !== params.accessToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
  params.httpServer.on("upgrade", handleUpgrade);
  wss.on("connection", (socket: WebSocket) => {
    const session = new WhatsAppBaileysWebSocketSession(socket, {
      appendEvent: params.appendEvent,
      onOpen: (openSession) => {
        flushPendingMessages(openSession);
      },
      path: params.path,
      selfJid: params.selfJid,
      signalBundles,
    });
    sessions.add(session);
    socket.once("close", () => sessions.delete(session));
    socket.on("error", () => {
      sessions.delete(session);
      socket.terminate();
    });
    socket.on("message", (data) => session.handleMessage(data));
  });
  return {
    async close() {
      params.httpServer.off("upgrade", handleUpgrade);
      pendingMessages.length = 0;
      await closeWebSocketServer(wss);
    },
    prepareInboundMessage(message) {
      if (pendingMessages.length + pendingReservations >= maxPendingInboundMessages) {
        return undefined;
      }
      let reserved = true;
      let settled = false;
      pendingReservations += 1;
      const releaseReservation = () => {
        if (reserved) {
          reserved = false;
          pendingReservations -= 1;
        }
      };
      return {
        cancel() {
          if (!settled) {
            settled = true;
            releaseReservation();
          }
        },
        commit() {
          if (settled) {
            throw new Error("WhatsApp inbound delivery reservation is already settled.");
          }
          settled = true;
          try {
            if (pendingMessages.length > 0) {
              releaseReservation();
              if (pendingMessages.length >= maxPendingInboundMessages) {
                throw new Error("WhatsApp inbound delivery reservation exceeded queue capacity.");
              }
              pendingMessages.push(message);
              for (const session of sessions) {
                flushPendingMessages(session);
              }
              return pendingMessages.includes(message) ? "queued" : "delivered";
            }
            let delivered = false;
            for (const session of sessions) {
              if (session.deliverInboundMessage(message)) {
                delivered = true;
              }
            }
            if (delivered) {
              return "delivered";
            }
            releaseReservation();
            if (pendingMessages.length >= maxPendingInboundMessages) {
              throw new Error("WhatsApp inbound delivery reservation exceeded queue capacity.");
            }
            pendingMessages.push(message);
            return "queued";
          } finally {
            releaseReservation();
          }
        },
      };
    },
  };
}

function children(node: BinaryNode): BinaryNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

function createInboundMessageNode(message: WhatsAppBaileysInboundMessage): BinaryNode {
  const from = message.key.remoteJid;
  const attrs: Record<string, string> = {
    from,
    id: message.key.id,
    notify: message.pushName ?? "Test User",
    t: String(message.messageTimestamp),
  };
  if (isGroupJid(from) && message.key.participant) {
    attrs.participant = message.key.participant;
  }
  return {
    attrs,
    content: [
      {
        attrs: {},
        content: encodePlaintextConversationMessage(message.message.conversation),
        tag: "plaintext",
      },
    ],
    tag: "message",
  };
}

function createIv(counter: number): NodeBuffer {
  const iv = Buffer.alloc(IV_LENGTH);
  iv.writeUInt32BE(counter, 8);
  return iv;
}

function encodeLengthPrefixed(data: Uint8Array): NodeBuffer {
  const frame = Buffer.allocUnsafe(3 + data.byteLength);
  frame[0] = (data.byteLength >>> 16) & 0xff;
  frame[1] = (data.byteLength >>> 8) & 0xff;
  frame[2] = data.byteLength & 0xff;
  frame.set(data, 3);
  return frame;
}

function firstChild(node: BinaryNode): BinaryNode | undefined {
  return children(node)[0];
}

function encodePlaintextConversationMessage(text: string): NodeBuffer {
  const textBytes = Buffer.from(text, "utf8");
  return Buffer.from([0x0a, ...encodeVarint(textBytes.byteLength), ...textBytes]);
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return bytes;
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

function requireAttr(node: BinaryNode, name: string): string {
  const value = node.attrs[name];
  if (!value) {
    throw new Error(`Baileys node <${node.tag}> requires ${name}.`);
  }
  return value;
}

function lidForJid(jid: string): string {
  const user = jid.split("@", 1)[0]?.split(":", 1)[0] ?? "15550000000";
  return `${user}@lid`;
}

function sanitizeNodeForJson(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { base64: Buffer.from(value).toString("base64"), type: "Buffer" };
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeNodeForJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeNodeForJson(entry)]),
    );
  }
  return value;
}

function unixSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}
