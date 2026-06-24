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

export const CRABLINE_FAKE_PROVIDER_CHANNELS = Object.freeze(["telegram", "whatsapp"] as const);

export type CrablineFakeProviderChannel = (typeof CRABLINE_FAKE_PROVIDER_CHANNELS)[number];

export type CrablineFakeProviderManifest = TelegramFakeServerManifest | WhatsAppFakeServerManifest;

export type StartedCrablineFakeProviderServer =
  | StartedTelegramFakeServer
  | StartedWhatsAppFakeServer;

export type StartCrablineFakeProviderServerParams =
  | (StartTelegramFakeServerParams & { channel: "telegram" })
  | (StartWhatsAppFakeServerParams & { channel: "whatsapp" });

export function isCrablineFakeProviderChannel(value: string): value is CrablineFakeProviderChannel {
  return CRABLINE_FAKE_PROVIDER_CHANNELS.includes(value as CrablineFakeProviderChannel);
}

export async function startCrablineFakeProviderServer(
  params: StartCrablineFakeProviderServerParams,
): Promise<StartedCrablineFakeProviderServer> {
  switch (params.channel) {
    case "telegram":
      return await startTelegramFakeServer(params);
    case "whatsapp":
      return await startWhatsAppFakeServer(params);
  }
}
