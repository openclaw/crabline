import {
  startSignalServer,
  type SignalServerManifest,
  type StartedSignalServer,
  type StartSignalServerParams,
} from "./signal.js";
import {
  startSlackServer,
  type SlackServerManifest,
  type StartedSlackServer,
  type StartSlackServerParams,
} from "./slack.js";
import {
  startTelegramServer,
  type StartedTelegramServer,
  type StartTelegramServerParams,
  type TelegramServerManifest,
} from "./telegram.js";
import {
  startWhatsAppServer,
  type StartedWhatsAppServer,
  type StartWhatsAppServerParams,
  type WhatsAppServerManifest,
} from "./whatsapp.js";
import { CrablineError } from "../core/errors.js";

export const CRABLINE_SERVER_CHANNELS = Object.freeze([
  "signal",
  "slack",
  "telegram",
  "whatsapp",
] as const);

export type CrablineServerChannel = (typeof CRABLINE_SERVER_CHANNELS)[number];

export type CrablineServerManifest =
  | SignalServerManifest
  | SlackServerManifest
  | TelegramServerManifest
  | WhatsAppServerManifest;

export type StartedCrablineServer =
  | StartedSignalServer
  | StartedSlackServer
  | StartedTelegramServer
  | StartedWhatsAppServer;

export type StartCrablineServerParams =
  | (StartSignalServerParams & { channel: "signal" })
  | (StartSlackServerParams & { channel: "slack" })
  | (StartTelegramServerParams & { channel: "telegram" })
  | (StartWhatsAppServerParams & { channel: "whatsapp" });

const CRABLINE_SERVER_CHANNEL_SET = new Set<string>(CRABLINE_SERVER_CHANNELS);

export function isCrablineServerChannel(value: string): value is CrablineServerChannel {
  return CRABLINE_SERVER_CHANNEL_SET.has(value);
}

export function startCrablineServer(
  params: StartSignalServerParams & { channel: "signal" },
): Promise<StartedSignalServer>;
export function startCrablineServer(
  params: StartSlackServerParams & { channel: "slack" },
): Promise<StartedSlackServer>;
export function startCrablineServer(
  params: StartTelegramServerParams & { channel: "telegram" },
): Promise<StartedTelegramServer>;
export function startCrablineServer(
  params: StartWhatsAppServerParams & { channel: "whatsapp" },
): Promise<StartedWhatsAppServer>;
export function startCrablineServer(
  params: StartCrablineServerParams,
): Promise<StartedCrablineServer>;
export async function startCrablineServer(
  params: StartCrablineServerParams,
): Promise<StartedCrablineServer> {
  if (params.channel === "signal") {
    return await startSignalServer(params);
  }
  if (params.channel === "slack") {
    return await startSlackServer(params);
  }
  if (params.channel === "telegram") {
    return await startTelegramServer(params);
  }
  if (params.channel === "whatsapp") {
    return await startWhatsAppServer(params);
  }
  throw new CrablineError("Unsupported server channel.", { kind: "config" });
}
