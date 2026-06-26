import fs from "node:fs";
import fsPromises from "node:fs/promises";
import {
  createWhatsAppBaileysMockSocket,
  type WhatsAppBaileysMessage,
  type WhatsAppBaileysMockConfig,
  type WhatsAppBaileysMockSocket,
} from "./whatsapp.js";

export const CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV = "CRABLINE_WHATSAPP_ACCESS_TOKEN";
export const CRABLINE_WHATSAPP_API_ROOT_ENV = "CRABLINE_WHATSAPP_API_ROOT";
export const CRABLINE_WHATSAPP_RECORDER_PATH_ENV = "CRABLINE_WHATSAPP_RECORDER_PATH";
export const CRABLINE_WHATSAPP_SELF_JID_ENV = "CRABLINE_WHATSAPP_SELF_JID";

const DEFAULT_RECORDER_POLL_MS = 50;
const RECORDER_BRIDGE_STATE_KEY = Symbol.for("crabline.whatsapp.baileysRecorderBridge");

type RecorderBridgeState = {
  cursor: number;
  interval: ReturnType<typeof setInterval> | null;
  sockets: Set<WhatsAppBaileysMockSocket>;
  syncPromise: Promise<void> | null;
};

type RecorderBridgeStateMap = Map<string, RecorderBridgeState>;

type GlobalRecorderBridgeState = typeof globalThis & {
  [RECORDER_BRIDGE_STATE_KEY]?: RecorderBridgeStateMap;
};

export type WhatsAppBaileysRuntimeGroupMetadata = {
  id: string;
  participants: unknown[];
  subject: string;
};

export type WhatsAppBaileysRuntimeMockSocket = WhatsAppBaileysMockSocket & {
  end(error?: Error | undefined): void;
  groupFetchAllParticipating(): Promise<Record<string, WhatsAppBaileysRuntimeGroupMetadata>>;
  groupMetadata(jid: string): Promise<WhatsAppBaileysRuntimeGroupMetadata>;
  readMessages(keys?: unknown[] | undefined): Promise<void>;
};

export type WhatsAppBaileysRuntimeMockConfig = WhatsAppBaileysMockConfig & {
  emitConnectionOpen?: boolean | undefined;
  recorderPath?: string | undefined;
  recorderPollMs?: number | undefined;
};

export type WhatsAppSocketFactoryOptions = {
  fetch?: typeof fetch | undefined;
  selfJid?: string | undefined;
};

function readNonEmptyString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = readNonEmptyString(env[key]);
  if (!value) {
    throw new Error(`${key} is required to create a WhatsApp Baileys mock socket.`);
  }
  return value;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return readNonEmptyString(env[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readRecordedInboundMessage(value: unknown): WhatsAppBaileysMessage | undefined {
  if (!isRecord(value) || !isRecord(value.key) || !isRecord(value.message)) {
    return undefined;
  }
  const id = readNonEmptyString(value.key.id);
  const remoteJid = readNonEmptyString(value.key.remoteJid);
  if (!id || !remoteJid || value.key.fromMe !== false) {
    return undefined;
  }
  return value as WhatsAppBaileysMessage;
}

function getRecorderBridgeState(recorderPath: string): RecorderBridgeState {
  const globalState = globalThis as GlobalRecorderBridgeState;
  const states = globalState[RECORDER_BRIDGE_STATE_KEY] ?? new Map();
  globalState[RECORDER_BRIDGE_STATE_KEY] = states;
  const state = states.get(recorderPath) ?? {
    cursor: readRecorderLineCountSync(recorderPath),
    interval: null,
    sockets: new Set<WhatsAppBaileysMockSocket>(),
    syncPromise: null,
  };
  states.set(recorderPath, state);
  return state;
}

function parseRecorderLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function createInboundMessageFromRecorderEvent(
  event: unknown,
  lineIndex: number,
): WhatsAppBaileysMessage | null {
  if (!isRecord(event) || event.type !== "admin" || typeof event.path !== "string") {
    return null;
  }
  if (!event.path.endsWith("/crabline/whatsapp/inbound")) {
    return null;
  }
  const recordedMessage = readRecordedInboundMessage(event.message);
  if (recordedMessage) {
    return recordedMessage;
  }
  if (!isRecord(event.body)) {
    return null;
  }

  const chatJid = readNonEmptyString(event.body.chatJid ?? event.body.chatId);
  const senderJid = readNonEmptyString(event.body.senderJid ?? event.body.from);
  const text = readNonEmptyString(event.body.text);
  if (!chatJid || !senderJid || !text) {
    return null;
  }

  const messageId =
    readNonEmptyString(event.body.messageId) ??
    `wamid.FAKEQA${String(lineIndex + 1).padStart(8, "0")}`;
  return {
    key: {
      fromMe: false,
      id: messageId,
      ...(chatJid.endsWith("@g.us") ? { participant: senderJid } : {}),
      remoteJid: chatJid,
    },
    message: {
      conversation: text,
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: readNonEmptyString(event.body.pushName) ?? "Test User",
  };
}

async function readRecorderLines(recorderPath: string): Promise<string[]> {
  const text = await fsPromises.readFile(recorderPath, "utf8").catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

function readRecorderLineCountSync(recorderPath: string): number {
  try {
    return fs
      .readFileSync(recorderPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).length;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export function startWhatsAppBaileysRecorderBridge(params: {
  recorderPath: string;
  recorderPollMs?: number | undefined;
  socket: WhatsAppBaileysMockSocket;
}): () => void {
  const state = getRecorderBridgeState(params.recorderPath);
  state.sockets.add(params.socket);
  const sync = async () => {
    if (state.syncPromise) {
      await state.syncPromise;
      return;
    }
    state.syncPromise = (async () => {
      const lines = await readRecorderLines(params.recorderPath);
      if (lines.length < state.cursor) {
        state.cursor = 0;
      }
      for (let lineIndex = state.cursor; lineIndex < lines.length; lineIndex += 1) {
        const event = parseRecorderLine(lines[lineIndex] ?? "");
        const message = createInboundMessageFromRecorderEvent(event, lineIndex);
        if (message) {
          const payload = { messages: [message], type: "notify" };
          for (const socket of state.sockets) {
            socket.ev.emit("messages.upsert", payload);
          }
        }
      }
      state.cursor = lines.length;
    })();
    try {
      await state.syncPromise;
    } finally {
      state.syncPromise = null;
    }
  };

  if (!state.interval) {
    state.interval = setInterval(() => {
      void sync().catch(() => undefined);
    }, params.recorderPollMs ?? DEFAULT_RECORDER_POLL_MS);
    state.interval.unref?.();
  }
  void sync().catch(() => undefined);

  return () => {
    state.sockets.delete(params.socket);
    if (state.sockets.size === 0 && state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
  };
}

export function createWhatsAppBaileysRuntimeMockSocket(
  config: WhatsAppBaileysRuntimeMockConfig,
): WhatsAppBaileysRuntimeMockSocket {
  const socket = createWhatsAppBaileysMockSocket(config);
  const stopRecorderBridge = config.recorderPath
    ? startWhatsAppBaileysRecorderBridge({
        recorderPath: config.recorderPath,
        recorderPollMs: config.recorderPollMs,
        socket,
      })
    : () => {};
  const openTimer =
    config.emitConnectionOpen === false
      ? null
      : setTimeout(() => {
          socket.ev.emit("connection.update", { connection: "open" });
        }, 0);
  openTimer?.unref?.();
  let closed = false;

  return {
    ...socket,
    end(error) {
      if (closed) {
        return;
      }
      closed = true;
      if (openTimer) {
        clearTimeout(openTimer);
      }
      stopRecorderBridge();
      socket.ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: error ? { error } : undefined,
      });
    },
    async groupFetchAllParticipating() {
      return {};
    },
    async groupMetadata(jid) {
      return {
        id: jid,
        participants: [],
        subject: "Test Group",
      };
    },
    async readMessages() {
      return undefined;
    },
  };
}

export function createWhatsAppBaileysRuntimeMockSocketFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: WhatsAppSocketFactoryOptions = {},
): WhatsAppBaileysRuntimeMockSocket {
  return createWhatsAppBaileysRuntimeMockSocket({
    accessToken: readRequiredEnv(env, CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV),
    apiRoot: readRequiredEnv(env, CRABLINE_WHATSAPP_API_ROOT_ENV),
    fetch: options.fetch,
    recorderPath: readOptionalEnv(env, CRABLINE_WHATSAPP_RECORDER_PATH_ENV),
    selfJid: readOptionalEnv(env, CRABLINE_WHATSAPP_SELF_JID_ENV) ?? options.selfJid,
  });
}

export async function createWhatsAppSocket(
  _printQr?: boolean,
  _verbose?: boolean,
  options: WhatsAppSocketFactoryOptions = {},
): Promise<WhatsAppBaileysRuntimeMockSocket> {
  return createWhatsAppBaileysRuntimeMockSocketFromEnv(process.env, options);
}

export default createWhatsAppSocket;
