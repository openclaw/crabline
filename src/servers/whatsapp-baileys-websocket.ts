import { Buffer } from "node:buffer";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ProtocolAddress, SessionCipher, SessionRecord, type SignalStorage } from "libsignal";
import {
  aesDecryptGCM,
  aesEncryptGCM,
  Curve,
  encodeBigEndian,
  ensureSignalPublicKey,
  generateSignalKeyPair,
  hkdf,
  NOISE_MODE,
  NOISE_WA_HEADER,
  sha256,
  signedKeyPair,
  scrubSignalPublicKey,
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
import { WebSocket, WebSocketServer, type ServerOptions } from "ws";
import type { ServerRequestEvent } from "./http.js";
import { closeWebSocketServer } from "./websocket.js";
import { canonicalizeWhatsAppUserCorrelationJid } from "./whatsapp-jid.js";

// Keep the local server independent from Baileys at runtime. Tests use Baileys
// as a black-box client to verify this narrow WhatsApp Web wire subset.
const EMPTY_BUFFER = Buffer.alloc(0);
const IV_LENGTH = 12;
const MAX_PENDING_INBOUND_MESSAGES = 1_000;
export const MAX_WHATSAPP_NOISE_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
export const MAX_WHATSAPP_WEBSOCKET_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_WHATSAPP_NOISE_BUFFER_CHUNKS = 1_024;
export const MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE = 1_024;
export const WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS = 5_000;
const MAX_PENDING_WEBSOCKET_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_WEBSOCKET_MESSAGES = 32;
const MAX_WHATSAPP_PENDING_ACKNOWLEDGEMENTS = 10_000;
const MAX_WHATSAPP_PENDING_ACKNOWLEDGEMENT_AGE_MS = 5 * 60 * 1_000;
const MAX_WHATSAPP_RECENT_ACKNOWLEDGEMENTS = 10_000;
export const MAX_WHATSAPP_WEBSOCKET_FRAGMENTS = 1_024;
export const MAX_WHATSAPP_SIGNAL_BUNDLES = 1_024;
export const MAX_WHATSAPP_SIGNAL_SESSIONS_PER_BUNDLE = 32;
export const MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES = 123;
type NodeBuffer = Buffer<ArrayBufferLike>;
type WhatsAppWebSocketRawData = NodeBuffer | ArrayBuffer | NodeBuffer[];
type WhatsAppWebSocketSendTarget = {
  bufferedAmount: number;
  readyState: number;
  send(data: Uint8Array, callback: (error?: Error) => void): void;
  terminate(): void;
};
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
  commit(): Promise<"delivered" | "queued">;
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

export type WhatsAppSignalDecryptResult<T> =
  | { status: "accepted"; value: T }
  | { error: unknown; status: "decrypt-failed" }
  | { status: "unavailable" }
  | { status: "rejected" };

export type WhatsAppSignalBundleStoreOptions = {
  maxSessionsPerBundle?: number | undefined;
};

type PendingWhatsAppAcknowledgement = {
  acceptance: Promise<boolean>;
  acceptedAt: number | undefined;
  acknowledged: boolean;
};

export class WhatsAppSignalBundleStore {
  readonly #acknowledgedMessageIds = new Map<string, true>();
  readonly #bundles = new Map<string, MockSignalBundle>();
  readonly #lidByPhoneNumber = new Map<string, string>();
  readonly #maxSessionsPerBundle: number;
  readonly #pendingAcknowledgements = new Map<string, PendingWhatsAppAcknowledgement>();
  readonly #pendingTransactions = new Map<string, Promise<void>>();
  readonly #sessions = new Map<string, Map<string, SessionRecord>>();

  constructor(
    private readonly maxBundles = MAX_WHATSAPP_SIGNAL_BUNDLES,
    private readonly maxPendingAcknowledgements = MAX_WHATSAPP_PENDING_ACKNOWLEDGEMENTS,
    private readonly maxRecentAcknowledgements = MAX_WHATSAPP_RECENT_ACKNOWLEDGEMENTS,
    private readonly maxPendingAcknowledgementAgeMs = MAX_WHATSAPP_PENDING_ACKNOWLEDGEMENT_AGE_MS,
    private readonly now: () => number = Date.now,
    options: WhatsAppSignalBundleStoreOptions = {},
  ) {
    const maxSessionsPerBundle =
      options.maxSessionsPerBundle ?? MAX_WHATSAPP_SIGNAL_SESSIONS_PER_BUNDLE;
    if (!Number.isSafeInteger(maxBundles) || maxBundles < 1) {
      throw new Error("WhatsApp maxSignalBundles must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxSessionsPerBundle) || maxSessionsPerBundle < 1) {
      throw new Error("WhatsApp maxSignalSessionsPerBundle must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxPendingAcknowledgements) || maxPendingAcknowledgements < 1) {
      throw new Error("WhatsApp maxPendingAcknowledgements must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxRecentAcknowledgements) || maxRecentAcknowledgements < 1) {
      throw new Error("WhatsApp maxRecentAcknowledgements must be a positive safe integer.");
    }
    if (
      !Number.isSafeInteger(maxPendingAcknowledgementAgeMs) ||
      maxPendingAcknowledgementAgeMs < 1
    ) {
      throw new Error("WhatsApp maxPendingAcknowledgementAgeMs must be a positive safe integer.");
    }
    this.#maxSessionsPerBundle = maxSessionsPerBundle;
  }

  get size(): number {
    return this.#bundles.size;
  }

  get lidMappingSize(): number {
    return this.#lidByPhoneNumber.size;
  }

  get sessionCount(): number {
    let count = 0;
    for (const sessions of this.#sessions.values()) {
      count += sessions.size;
    }
    return count;
  }

  async acceptMessageOnce(messageKey: string, operation: () => Promise<boolean>): Promise<boolean> {
    this.#recoverExpiredPendingAcknowledgements();
    const pendingAcceptance = this.#pendingAcknowledgements.get(messageKey);
    if (pendingAcceptance) {
      return await pendingAcceptance.acceptance;
    }
    if (this.#acknowledgedMessageIds.delete(messageKey)) {
      this.#acknowledgedMessageIds.set(messageKey, true);
      return true;
    }
    if (this.#pendingAcknowledgements.size >= this.maxPendingAcknowledgements) {
      throw new Error(
        `WhatsApp pending acknowledgement limit exceeded (${this.maxPendingAcknowledgements}).`,
      );
    }
    let pendingAcknowledgement: PendingWhatsAppAcknowledgement;
    const acceptance = Promise.resolve().then(async () => {
      try {
        const accepted = await operation();
        if (!accepted) {
          this.#pendingAcknowledgements.delete(messageKey);
          return false;
        }
        if (pendingAcknowledgement.acknowledged) {
          this.#pendingAcknowledgements.delete(messageKey);
          this.#rememberAcknowledgedMessage(messageKey);
        } else {
          pendingAcknowledgement.acceptedAt = this.now();
        }
        return true;
      } catch (error) {
        this.#pendingAcknowledgements.delete(messageKey);
        throw error;
      }
    });
    pendingAcknowledgement = {
      acceptance,
      acceptedAt: undefined,
      acknowledged: false,
    };
    this.#pendingAcknowledgements.set(messageKey, pendingAcknowledgement);
    return await acceptance;
  }

  markMessageAcknowledged(peerJid: string, messageId: string): void {
    const peer = canonicalizeWhatsAppUserCorrelationJid(peerJid);
    if (peer && messageId) {
      const messageKey = `${peer}\0${messageId}`;
      this.#recoverExpiredPendingAcknowledgements();
      const pendingAcknowledgement = this.#pendingAcknowledgements.get(messageKey);
      if (!pendingAcknowledgement) {
        return;
      }
      if (pendingAcknowledgement.acceptedAt === undefined) {
        pendingAcknowledgement.acknowledged = true;
        return;
      }
      this.#pendingAcknowledgements.delete(messageKey);
      this.#rememberAcknowledgedMessage(messageKey);
    }
  }

  associateLid(phoneNumberJid: string, lidJid: string): void {
    const phoneNumber = canonicalizeWhatsAppUserCorrelationJid(phoneNumberJid);
    const lid = canonicalizeWhatsAppUserCorrelationJid(lidJid);
    if (!phoneNumber?.endsWith("@s.whatsapp.net") || !lid?.endsWith("@lid")) {
      throw new Error("Invalid WhatsApp PN/LID signal mapping.");
    }
    const phoneNumberKey = signalBundleIdentityKey(phoneNumber);
    this.#lidByPhoneNumber.delete(phoneNumberKey);
    this.#lidByPhoneNumber.set(phoneNumberKey, signalBundleIdentityKey(lid));
    if (this.#lidByPhoneNumber.size > this.maxBundles) {
      const oldestPhoneNumber = this.#lidByPhoneNumber.keys().next().value;
      if (oldestPhoneNumber !== undefined) {
        this.#lidByPhoneNumber.delete(oldestPhoneNumber);
      }
    }
  }

  resolveAssociatedLid(phoneNumberJid: string): string | undefined {
    const phoneNumber = canonicalizeWhatsAppUserCorrelationJid(phoneNumberJid);
    if (!phoneNumber?.endsWith("@s.whatsapp.net")) {
      return undefined;
    }
    return this.#lidByPhoneNumber.get(signalBundleIdentityKey(phoneNumber));
  }

  resolveMany(jids: string[]): MockSignalBundle[] {
    const uniqueNewIdentities = new Set<string>();
    const identityKeys: string[] = [];
    for (const jid of jids) {
      const canonical = canonicalizeWhatsAppUserCorrelationJid(jid);
      if (!canonical) {
        throw new Error(`Invalid WhatsApp signal bundle JID: ${jid}.`);
      }
      const identityKey = signalBundleIdentityKey(canonical);
      identityKeys.push(identityKey);
      if (!this.#bundles.has(identityKey)) {
        uniqueNewIdentities.add(identityKey);
      }
    }
    if (this.#bundles.size + uniqueNewIdentities.size > this.maxBundles) {
      // Published bundle identities stay stable for the store lifetime.
      throw new Error(`WhatsApp signal bundle limit exceeded (${this.maxBundles}).`);
    }
    return identityKeys.map((identityKey) => this.#resolve(identityKey));
  }

  async decryptDirectMessage(params: {
    ciphertext: Uint8Array;
    recipientJid: string;
    remoteJid: string;
    type: "msg" | "pkmsg";
  }): Promise<Buffer | undefined> {
    const result = await this.transactDirectMessage({
      ...params,
      accept: async (plaintext) => plaintext,
    });
    if (result.status === "decrypt-failed") {
      throw result.error;
    }
    return result.status === "accepted" ? result.value : undefined;
  }

  async transactDirectMessage<T>(params: {
    accept(plaintext: Buffer): Promise<T | undefined>;
    ciphertext: Uint8Array;
    recipientJid: string;
    remoteJid: string;
    type: "msg" | "pkmsg";
  }): Promise<WhatsAppSignalDecryptResult<T>> {
    const recipientJid = canonicalizeWhatsAppUserCorrelationJid(params.recipientJid);
    const recipientIdentityKey = recipientJid ? signalBundleIdentityKey(recipientJid) : undefined;
    const mappedLidIdentityKey = recipientIdentityKey
      ? this.resolveAssociatedLid(recipientIdentityKey)
      : undefined;
    const identityKey =
      mappedLidIdentityKey && this.#bundles.has(mappedLidIdentityKey)
        ? mappedLidIdentityKey
        : recipientIdentityKey;
    const bundle = identityKey ? this.#bundles.get(identityKey) : undefined;
    if (!identityKey || !bundle) {
      return { status: "unavailable" };
    }
    const remoteAddress = signalProtocolAddress(params.remoteJid);
    if (!remoteAddress) {
      return { status: "unavailable" };
    }
    const address = new ProtocolAddress(remoteAddress.name, remoteAddress.deviceId);
    // Capacity checks, staged writes, and commits stay atomic per recipient bundle.
    return await this.#runTransaction(identityKey, async () => {
      const sessions = this.#sessions.get(identityKey) ?? new Map<string, SessionRecord>();
      const sessionLimitError = new Error("WhatsApp Signal session limit exceeded.");
      const maxSessionsPerBundle = this.#maxSessionsPerBundle;
      let stagedNewSessionCount = 0;
      const stagedPreKeyRemovals = new Set<number>();
      const stagedSessions = new Map<string, SessionRecord>();
      const storage: SignalStorage = {
        async loadSession(id) {
          const session = stagedSessions.get(id) ?? sessions.get(id);
          return session ? cloneSignalSession(session) : undefined;
        },
        async storeSession(id, session) {
          if (!sessions.has(id) && !stagedSessions.has(id)) {
            if (sessions.size + stagedNewSessionCount >= maxSessionsPerBundle) {
              throw sessionLimitError;
            }
            stagedNewSessionCount += 1;
          }
          stagedSessions.set(id, cloneSignalSession(session));
        },
        isTrustedIdentity: () => true,
        async loadPreKey(id) {
          if (String(id) !== String(bundle.preKeyId)) {
            return undefined;
          }
          return signalKeyPair(bundle.preKey);
        },
        removePreKey(id) {
          stagedPreKeyRemovals.add(id);
        },
        loadSignedPreKey: () => signalKeyPair(bundle.signedPreKey.keyPair),
        getOurRegistrationId: () => bundle.registrationId,
        getOurIdentity: () => signalKeyPair(bundle.identityKey),
      };
      const cipher = new SessionCipher(storage, address);
      let plaintext: Buffer;
      try {
        plaintext =
          params.type === "pkmsg"
            ? await cipher.decryptPreKeyWhisperMessage(params.ciphertext)
            : await cipher.decryptWhisperMessage(params.ciphertext);
      } catch (error) {
        if (error === sessionLimitError) {
          return { status: "rejected" };
        }
        return { error, status: "decrypt-failed" };
      }
      const replacementPreKey = stagedPreKeyRemovals.has(bundle.preKeyId)
        ? {
            id: bundle.preKeyId === 0xff_ff_ff ? 1 : bundle.preKeyId + 1,
            keyPair: generateSignalKeyPair(),
          }
        : undefined;
      const accepted = await params.accept(plaintext);
      if (accepted === undefined) {
        return { status: "rejected" };
      }
      for (const [id, session] of stagedSessions) {
        sessions.set(id, session);
      }
      if (stagedSessions.size > 0) {
        this.#sessions.set(identityKey, sessions);
      }
      if (replacementPreKey) {
        bundle.preKey = replacementPreKey.keyPair;
        bundle.preKeyId = replacementPreKey.id;
      }
      return { status: "accepted", value: accepted };
    });
  }

  #resolve(bundleKey: string): MockSignalBundle {
    const existing = this.#bundles.get(bundleKey);
    if (existing) {
      return existing;
    }
    const identityKey = generateSignalKeyPair();
    const bundle = {
      identityKey,
      preKey: generateSignalKeyPair(),
      preKeyId: 1,
      registrationId: 1,
      signedPreKey: signedKeyPair(identityKey, 1),
    };
    this.#bundles.set(bundleKey, bundle);
    return bundle;
  }

  #recoverExpiredPendingAcknowledgements(): void {
    const now = this.now();
    for (const [messageKey, pendingAcknowledgement] of this.#pendingAcknowledgements) {
      const { acceptedAt } = pendingAcknowledgement;
      if (acceptedAt === undefined) {
        continue;
      }
      if (now - acceptedAt < this.maxPendingAcknowledgementAgeMs) {
        continue;
      }
      this.#pendingAcknowledgements.delete(messageKey);
      this.#rememberAcknowledgedMessage(messageKey);
    }
  }

  #rememberAcknowledgedMessage(messageKey: string): void {
    this.#acknowledgedMessageIds.delete(messageKey);
    this.#acknowledgedMessageIds.set(messageKey, true);
    if (this.#acknowledgedMessageIds.size > this.maxRecentAcknowledgements) {
      const oldestMessageKey = this.#acknowledgedMessageIds.keys().next().value;
      if (oldestMessageKey !== undefined) {
        this.#acknowledgedMessageIds.delete(oldestMessageKey);
      }
    }
  }

  async #runTransaction<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return await this.#runSerialized(this.#pendingTransactions, key, operation);
  }

  async #runSerialized<T>(
    pending: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pending.set(key, settled);
    try {
      return await result;
    } finally {
      if (pending.get(key) === settled) {
        pending.delete(key);
      }
    }
  }
}

export function createSerializedMessageHandler<T>(
  processMessage: (message: T) => Promise<void>,
  onError: (error: unknown) => void,
  options: {
    maxPendingBytes?: number | undefined;
    maxPendingMessages?: number | undefined;
    sizeOf?: ((message: T) => number) | undefined;
  } = {},
): (message: T) => Promise<void> {
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_WEBSOCKET_BYTES;
  const maxPendingMessages = options.maxPendingMessages ?? MAX_PENDING_WEBSOCKET_MESSAGES;
  const sizeOf = options.sizeOf ?? (() => 1);
  let failed = false;
  let pendingBytes = 0;
  let pendingMessages = 0;
  let pending = Promise.resolve();
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      onError(error);
    }
  };
  return (message) => {
    if (failed) {
      return pending;
    }
    const messageBytes = sizeOf(message);
    if (!Number.isSafeInteger(messageBytes) || messageBytes < 0) {
      fail(new Error("WhatsApp WebSocket message size must be a non-negative safe integer."));
      return pending;
    }
    if (pendingMessages >= maxPendingMessages || pendingBytes + messageBytes > maxPendingBytes) {
      fail(new Error("WhatsApp WebSocket inbound backlog limit exceeded."));
      return pending;
    }
    pendingMessages += 1;
    pendingBytes += messageBytes;
    const next = pending
      .then(async () => {
        if (!failed) {
          await processMessage(message);
        }
      })
      .finally(() => {
        pendingMessages -= 1;
        pendingBytes -= messageBytes;
      });
    pending = next.catch((error: unknown) => {
      fail(error);
    });
    return pending;
  };
}

export class WhatsAppNoiseFrameDecoder {
  #bufferedBytes = 0;
  readonly #chunks: NodeBuffer[] = [];
  #expectIntro = true;
  #offset = 0;

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  decodeFrames(data: WhatsAppWebSocketRawData): NodeBuffer[] {
    let chunk = rawDataToBuffer(data);
    if (this.#expectIntro) {
      chunk = removeNoiseIntroHeader(chunk);
      this.#expectIntro = false;
    }
    if (chunk.length > 0) {
      if (this.#chunks.length >= MAX_WHATSAPP_NOISE_BUFFER_CHUNKS) {
        throw new Error(
          `WhatsApp Noise buffer exceeds ${MAX_WHATSAPP_NOISE_BUFFER_CHUNKS} chunks.`,
        );
      }
      this.#chunks.push(chunk);
      this.#bufferedBytes += chunk.length;
    }

    const frames: NodeBuffer[] = [];
    while (this.#bufferedBytes >= 3) {
      const size = (this.#peekByte(0) << 16) | (this.#peekByte(1) << 8) | this.#peekByte(2);
      if (size > MAX_WHATSAPP_NOISE_FRAME_BYTES) {
        throw new Error(`WhatsApp Noise frame exceeds ${MAX_WHATSAPP_NOISE_FRAME_BYTES} bytes.`);
      }
      if (this.#bufferedBytes < size + 3) {
        break;
      }
      if (frames.length >= MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE) {
        throw new Error(
          `WhatsApp Noise message exceeds ${MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE} frames.`,
        );
      }
      this.#consume(3);
      frames.push(this.#read(size));
    }
    return frames;
  }

  #consume(length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.#chunks[0];
      if (!chunk) {
        throw new Error("Unexpected end of WhatsApp Noise frame buffer.");
      }
      const available = chunk.length - this.#offset;
      const consumed = Math.min(available, remaining);
      this.#offset += consumed;
      this.#bufferedBytes -= consumed;
      remaining -= consumed;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
  }

  #peekByte(index: number): number {
    let remaining = index + this.#offset;
    for (const chunk of this.#chunks) {
      if (remaining < chunk.length) {
        return chunk[remaining]!;
      }
      remaining -= chunk.length;
    }
    throw new Error("Unexpected end of WhatsApp Noise frame buffer.");
  }

  #read(length: number): NodeBuffer {
    const result = Buffer.allocUnsafe(length);
    let resultOffset = 0;
    while (resultOffset < length) {
      const chunk = this.#chunks[0];
      if (!chunk) {
        throw new Error("Unexpected end of WhatsApp Noise frame buffer.");
      }
      const copied = chunk.copy(
        result,
        resultOffset,
        this.#offset,
        Math.min(chunk.length, this.#offset + length - resultOffset),
      );
      this.#offset += copied;
      this.#bufferedBytes -= copied;
      resultOffset += copied;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    return result;
  }
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
  readonly #frames = new WhatsAppNoiseFrameDecoder();
  #hash: NodeBuffer;
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

  decodeFrames(data: WhatsAppWebSocketRawData): NodeBuffer[] {
    return this.#frames.decodeFrames(data);
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
}

class WhatsAppBaileysWebSocketSession {
  #handshakeState: "client-finish" | "client-hello" | "open" = "client-hello";
  readonly #handleSerializedMessage: (data: WhatsAppWebSocketRawData) => Promise<void>;
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
        const close = resolveWhatsAppWebSocketClose(error);
        this.socket.close(close.code, close.reason);
      },
      {
        sizeOf: rawDataByteLength,
      },
    );
  }

  get isOpen(): boolean {
    return this.#handshakeState === "open" && this.socket.readyState === WebSocket.OPEN;
  }

  handleMessage(data: WhatsAppWebSocketRawData): Promise<void> {
    return this.#handleSerializedMessage(data);
  }

  async deliverInboundMessage(message: WhatsAppBaileysInboundMessage): Promise<boolean> {
    if (!this.isOpen) {
      return false;
    }
    try {
      await this.#sendNode(createInboundMessageNode(message));
      return true;
    } catch {
      this.socket.terminate();
      return false;
    }
  }

  async #handleMessage(data: WhatsAppWebSocketRawData): Promise<void> {
    for (const frame of this.#noise.decodeFrames(data)) {
      if (this.#handshakeState === "client-hello") {
        await sendWhatsAppWebSocketPayload(this.socket, this.#noise.createServerHello(frame));
        this.#handshakeState = "client-finish";
        continue;
      }
      if (this.#handshakeState === "client-finish") {
        this.#noise.finishClientHandshake(frame);
        this.#handshakeState = "open";
        await this.#sendNode({
          attrs: {
            lid: lidForJid(this.params.selfJid),
            t: unixSeconds(),
          },
          tag: "success",
        });
        await this.#sendNode({
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
      await this.#sendNode(this.#createIqResult(node));
      return;
    }
    if (node.tag === "message") {
      const peer = requireAttr(node, "to");
      const messageId = requireAttr(node, "id");
      const accepted = await persistAcceptedBaileysMessage({
        appendEvent: this.params.appendEvent,
        node,
        path: this.params.path,
        remoteJid: this.params.selfJid,
        signalBundles: this.params.signalBundles,
      });
      if (!accepted) {
        return;
      }
      await this.#sendNode({
        attrs: {
          class: "message",
          from: peer,
          id: messageId,
          to: this.params.selfJid,
          ...(node.attrs.type ? { type: node.attrs.type } : {}),
        },
        tag: "ack",
      });
      this.params.signalBundles.markMessageAcknowledged(peer, messageId);
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
      if (node.attrs.type !== "get" || child?.tag !== "query") {
        return {
          attrs: { ...attrs, type: "error" },
          content: [
            {
              attrs: { code: "501", text: "unsupported group operation", type: "cancel" },
              tag: "error",
            },
          ],
          tag: "iq",
        };
      }
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
        {
          attrs: {},
          content: scrubSignalPublicKey(bundle.identityKey.public),
          tag: "identity",
        },
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
    const lid = lidForJid(jid);
    if (canonicalizeWhatsAppUserCorrelationJid(jid)?.endsWith("@s.whatsapp.net")) {
      this.params.signalBundles.associateLid(jid, lid);
    }
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
        { attrs: { val: lid }, tag: "lid" },
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

  async #sendNode(node: BinaryNode): Promise<void> {
    await sendWhatsAppWebSocketPayload(this.socket, this.#noise.encodeNode(node));
  }
}

export async function sendWhatsAppWebSocketPayload(
  socket: WhatsAppWebSocketSendTarget,
  payload: Uint8Array,
): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("WhatsApp WebSocket is not open.");
  }
  if (socket.bufferedAmount + payload.byteLength > MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES) {
    socket.terminate();
    throw new Error("WhatsApp WebSocket outbound buffer limit exceeded.");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      finish(new Error("WhatsApp WebSocket send timed out."));
    }, WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS);
    try {
      socket.send(payload, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function resolveWhatsAppWebSocketClose(error: unknown): {
  code: 1002 | 1009 | 1011;
  reason: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const code = /(?:backlog|exceeds|limit|payload is too large|too many)/iu.test(message)
    ? 1009
    : /(?:baileys|binary node|handshake|noise|protocol|unexpected end|unsupported|invalid)/iu.test(
          message,
        )
      ? 1002
      : 1011;
  return { code, reason: truncateWebSocketCloseReason(message) };
}

function truncateWebSocketCloseReason(reason: string): string {
  let result = "";
  for (const character of reason) {
    if (Buffer.byteLength(result + character) > MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES) {
      break;
    }
    result += character;
  }
  return result;
}

export function attachWhatsAppBaileysWebSocketServer(
  params: WhatsAppBaileysWebSocketServerParams,
): WhatsAppBaileysWebSocketServer {
  const signalBundles = new WhatsAppSignalBundleStore();
  const sessions = new Set<WhatsAppBaileysWebSocketSession>();
  const pendingSessionMessages = new Set<Promise<void>>();
  const pendingMessages: WhatsAppBaileysInboundMessage[] = [];
  const maxPendingInboundMessages = resolveMaxPendingWhatsAppInboundMessages(
    params.maxPendingInboundMessages,
  );
  let pendingReservations = 0;
  let closing = false;
  let flushPromise = Promise.resolve();
  const webSocketServerOptions: ServerOptions & {
    maxBufferedChunks: number;
    maxFragments: number;
  } = {
    maxBufferedChunks: MAX_WHATSAPP_WEBSOCKET_FRAGMENTS,
    maxFragments: MAX_WHATSAPP_WEBSOCKET_FRAGMENTS,
    maxPayload: MAX_WHATSAPP_WEBSOCKET_MESSAGE_BYTES,
    noServer: true,
  };
  const wss = new WebSocketServer(webSocketServerOptions);
  const flushPendingMessages = (): Promise<void> => {
    const next = flushPromise.then(async () => {
      while (pendingMessages.length > 0) {
        if (closing) {
          return;
        }
        const message = pendingMessages[0];
        if (!message) {
          return;
        }
        const results = await Promise.all(
          [...sessions].map((session) => session.deliverInboundMessage(message)),
        );
        if (!results.some(Boolean)) {
          return;
        }
        pendingMessages.shift();
      }
    });
    flushPromise = next.catch(() => undefined);
    return next;
  };
  const rejectUpgrade = (socket: Duplex, response: string) => {
    socket.end(response, () => socket.destroy());
  };
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseWhatsAppWebSocketUpgradeUrl(request.url);
    if (!url) {
      rejectUpgrade(socket, "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname !== params.path) {
      socket.destroy();
      return;
    }
    if (url.searchParams.get("access_token") !== params.accessToken) {
      rejectUpgrade(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
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
      onOpen: () => {
        void flushPendingMessages();
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
    socket.on("message", (data) => {
      const pending = session.handleMessage(data);
      pendingSessionMessages.add(pending);
      void pending.then(
        () => pendingSessionMessages.delete(pending),
        () => pendingSessionMessages.delete(pending),
      );
    });
  });
  return {
    async close() {
      closing = true;
      params.httpServer.off("upgrade", handleUpgrade);
      pendingMessages.length = 0;
      await closeWebSocketServer(wss);
      const messageResults = await Promise.allSettled([...pendingSessionMessages]);
      await flushPromise;
      const messageErrors = messageResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (messageErrors.length === 1) {
        throw messageErrors[0];
      }
      if (messageErrors.length > 1) {
        throw new AggregateError(messageErrors, "WhatsApp WebSocket message drain failed.");
      }
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
        async commit() {
          if (settled) {
            throw new Error("WhatsApp inbound delivery reservation is already settled.");
          }
          settled = true;
          try {
            releaseReservation();
            if (pendingMessages.length >= maxPendingInboundMessages) {
              throw new Error("WhatsApp inbound delivery reservation exceeded queue capacity.");
            }
            pendingMessages.push(message);
            await flushPendingMessages();
            return pendingMessages.includes(message) ? "queued" : "delivered";
          } finally {
            releaseReservation();
          }
        },
      };
    },
  };
}

export function parseWhatsAppWebSocketUpgradeUrl(
  requestTarget: string | undefined,
): URL | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://127.0.0.1");
  } catch {
    return undefined;
  }
}

function rawDataByteLength(data: WhatsAppWebSocketRawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function rawDataToBuffer(data: WhatsAppWebSocketRawData): NodeBuffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function removeNoiseIntroHeader(chunk: NodeBuffer): NodeBuffer {
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

function children(node: BinaryNode): BinaryNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

export async function persistAcceptedBaileysMessage(params: {
  appendEvent(event: ServerRequestEvent): Promise<void>;
  node: BinaryNode;
  path: string;
  remoteJid: string;
  signalBundles: WhatsAppSignalBundleStore;
}): Promise<boolean> {
  const peer = canonicalizeWhatsAppUserCorrelationJid(params.node.attrs.to ?? "");
  const messageId = params.node.attrs.id;
  if (!peer || !messageId) {
    return false;
  }
  return await params.signalBundles.acceptMessageOnce(`${peer}\0${messageId}`, async () => {
    const candidates = encryptedMessageCandidates(params.node);
    if (candidates.length === 0) {
      await params.appendEvent({
        accepted: true,
        at: new Date().toISOString(),
        body: sanitizeNodeForJson(params.node),
        method: "WEBSOCKET",
        path: params.path,
        query: {},
        type: "api",
      } as ServerRequestEvent & { accepted: true });
      return true;
    }
    const remoteCorrelationJid = canonicalizeWhatsAppUserCorrelationJid(params.remoteJid);
    candidates.sort((left, right) => {
      const leftIsSelf =
        canonicalizeWhatsAppUserCorrelationJid(left.recipientJid) === remoteCorrelationJid;
      const rightIsSelf =
        canonicalizeWhatsAppUserCorrelationJid(right.recipientJid) === remoteCorrelationJid;
      return Number(leftIsSelf) - Number(rightIsSelf);
    });
    for (const candidate of candidates) {
      const result = await params.signalBundles.transactDirectMessage({
        accept: async (decrypted) => {
          let text: string | undefined;
          try {
            text = readWhatsAppConversation(unpadRandomMax16(decrypted));
          } catch {
            text = undefined;
          }
          const message: WhatsAppBaileysInboundMessage | undefined = text
            ? {
                key: {
                  fromMe: true,
                  id: messageId,
                  remoteJid: peer,
                },
                message: { conversation: text },
                messageTimestamp: Math.floor(Date.now() / 1000),
              }
            : undefined;
          await params.appendEvent({
            accepted: true,
            at: new Date().toISOString(),
            body: message ?? sanitizeNodeForJson(params.node),
            method: "WEBSOCKET",
            path: params.path,
            query: {},
            type: "api",
          } as ServerRequestEvent & { accepted: true });
          return true;
        },
        ciphertext: candidate.ciphertext,
        recipientJid: candidate.recipientJid,
        remoteJid: params.remoteJid,
        type: candidate.type,
      });
      if (result.status === "accepted") {
        return true;
      }
    }
    return false;
  });
}

function encryptedMessageCandidates(node: BinaryNode): Array<{
  ciphertext: Uint8Array;
  recipientJid: string;
  type: "msg" | "pkmsg";
}> {
  const result: Array<{
    ciphertext: Uint8Array;
    recipientJid: string;
    type: "msg" | "pkmsg";
  }> = [];
  const visit = (current: BinaryNode, recipientJid?: string) => {
    const nextRecipient = current.tag === "to" ? current.attrs.jid : recipientJid;
    if (
      current.tag === "enc" &&
      nextRecipient &&
      (current.attrs.type === "msg" || current.attrs.type === "pkmsg") &&
      current.content instanceof Uint8Array
    ) {
      result.push({
        ciphertext: current.content,
        recipientJid: nextRecipient,
        type: current.attrs.type,
      });
    }
    for (const child of children(current)) {
      visit(child, nextRecipient);
    }
  };
  visit(node);
  return result;
}

function signalKeyPair(pair: KeyPair): { privKey: Buffer; pubKey: Buffer } {
  return {
    privKey: Buffer.from(pair.private),
    pubKey: ensureSignalPublicKey(pair.public),
  };
}

function cloneSignalSession(session: SessionRecord): SessionRecord {
  return SessionRecord.deserialize(session.serialize());
}

export function signalBundleIdentityKey(jid: string): string {
  return jid.replace(/:\d+(?=@)/u, "");
}

function signalProtocolAddress(jid: string): { deviceId: number; name: string } | undefined {
  const match = /^(\d{7,15})(?::(\d+))?@(s\.whatsapp\.net|lid)$/iu.exec(jid);
  if (!match) {
    return undefined;
  }
  const deviceId = Number(match[2] ?? "0");
  if (!Number.isSafeInteger(deviceId) || deviceId < 0) {
    return undefined;
  }
  return {
    deviceId,
    name: match[3]!.toLowerCase() === "lid" ? `${match[1]}_1` : match[1]!,
  };
}

function unpadRandomMax16(value: Uint8Array): Buffer {
  const buffer = Buffer.from(value);
  const padding = buffer.at(-1);
  if (!padding || padding > 16 || padding > buffer.length) {
    throw new Error("Invalid WhatsApp message padding.");
  }
  for (let index = buffer.length - padding; index < buffer.length; index += 1) {
    if (buffer[index] !== padding) {
      throw new Error("Invalid WhatsApp message padding.");
    }
  }
  return buffer.subarray(0, buffer.length - padding);
}

function readWhatsAppConversation(message: Uint8Array): string | undefined {
  const fields = readProtobufLengthDelimitedFields(message);
  const conversation = readUtf8(fields.get(1)?.[0]);
  if (conversation?.trim()) {
    return conversation;
  }
  const extendedText = fields.get(6)?.[0];
  const extendedConversation = extendedText
    ? readUtf8(readProtobufLengthDelimitedFields(extendedText).get(1)?.[0])
    : undefined;
  if (extendedConversation?.trim()) {
    return extendedConversation;
  }
  const deviceSentMessage = fields.get(31)?.[0];
  const nestedMessage = deviceSentMessage
    ? readProtobufLengthDelimitedFields(deviceSentMessage).get(2)?.[0]
    : undefined;
  return nestedMessage ? readWhatsAppConversation(nestedMessage) : undefined;
}

function readProtobufLengthDelimitedFields(value: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>();
  let offset = 0;
  while (offset < value.length) {
    const tag = readProtobufVarint(value, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 7;
    if (fieldNumber < 1) {
      throw new Error("Invalid WhatsApp protobuf field.");
    }
    if (wireType === 2) {
      const length = readProtobufVarint(value, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > value.length) {
        throw new Error("Invalid WhatsApp protobuf length.");
      }
      const entries = fields.get(fieldNumber) ?? [];
      entries.push(value.subarray(offset, end));
      fields.set(fieldNumber, entries);
      offset = end;
      continue;
    }
    if (wireType === 0) {
      offset = readProtobufVarint(value, offset).offset;
      continue;
    }
    if (wireType === 1) {
      offset += 8;
      continue;
    }
    if (wireType === 5) {
      offset += 4;
      continue;
    }
    throw new Error(`Unsupported WhatsApp protobuf wire type: ${wireType}.`);
  }
  return fields;
}

function readProtobufVarint(value: Uint8Array, start: number): { offset: number; value: number } {
  let result = 0;
  let shift = 0;
  let offset = start;
  while (offset < value.length && shift <= 28) {
    const byte = value[offset++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) {
        break;
      }
      return { offset, value: result };
    }
    shift += 7;
  }
  throw new Error("Invalid WhatsApp protobuf varint.");
}

function readUtf8(value: Uint8Array | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = Buffer.from(value).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(value)) ? text : undefined;
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
