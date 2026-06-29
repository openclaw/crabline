import {
  startSlackFakeServer,
  type SlackFakeServerManifest,
  type StartedSlackFakeServer,
  type StartSlackFakeServerParams,
} from "./slack.js";
import {
  startTelegramFakeServer,
  type StartedTelegramFakeServer,
  type StartTelegramFakeServerParams,
  type TelegramFakeServerManifest,
} from "./telegram.js";
import {
  startWhatsAppFakeServer,
  type StartedWhatsAppFakeServer,
  type StartWhatsAppFakeServerParams,
  type WhatsAppFakeServerManifest,
} from "./whatsapp.js";
import { CrablineError } from "../core/errors.js";

export const CRABLINE_FAKE_PROVIDER_CHANNELS = Object.freeze([
  "slack",
  "telegram",
  "whatsapp",
] as const);

export type CrablineFakeProviderChannel = (typeof CRABLINE_FAKE_PROVIDER_CHANNELS)[number];

export type CrablineFakeProviderManifest =
  | SlackFakeServerManifest
  | TelegramFakeServerManifest
  | WhatsAppFakeServerManifest;

export type StartedCrablineFakeProviderServer =
  | StartedSlackFakeServer
  | StartedTelegramFakeServer
  | StartedWhatsAppFakeServer;

export type StartCrablineFakeProviderServerParams =
  | (StartSlackFakeServerParams & { channel: "slack" })
  | (StartTelegramFakeServerParams & { channel: "telegram" })
  | (StartWhatsAppFakeServerParams & { channel: "whatsapp" });

const CRABLINE_FAKE_PROVIDER_CHANNEL_SET = new Set<string>(CRABLINE_FAKE_PROVIDER_CHANNELS);

export function isCrablineFakeProviderChannel(value: string): value is CrablineFakeProviderChannel {
  return CRABLINE_FAKE_PROVIDER_CHANNEL_SET.has(value);
}

export function startCrablineFakeProviderServer(
  params: StartSlackFakeServerParams & { channel: "slack" },
): Promise<StartedSlackFakeServer>;
export function startCrablineFakeProviderServer(
  params: StartTelegramFakeServerParams & { channel: "telegram" },
): Promise<StartedTelegramFakeServer>;
export function startCrablineFakeProviderServer(
  params: StartWhatsAppFakeServerParams & { channel: "whatsapp" },
): Promise<StartedWhatsAppFakeServer>;
export function startCrablineFakeProviderServer(
  params: StartCrablineFakeProviderServerParams,
): Promise<StartedCrablineFakeProviderServer>;
export async function startCrablineFakeProviderServer(
  params: StartCrablineFakeProviderServerParams,
): Promise<StartedCrablineFakeProviderServer> {
  if (params.channel === "slack") {
    return await startSlackFakeServer(params);
  }
  if (params.channel === "telegram") {
    return await startTelegramFakeServer(params);
  }
  if (params.channel === "whatsapp") {
    return await startWhatsAppFakeServer(params);
  }
  throw new CrablineError("Unsupported fake provider server.", { kind: "config" });
}
