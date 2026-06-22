import {
  startTelegramFakeServer,
  type StartedTelegramFakeServer,
  type StartTelegramFakeServerParams,
  type TelegramFakeServerManifest,
} from "./telegram.js";

export const CRABLINE_FAKE_PROVIDER_CHANNELS = Object.freeze(["telegram"] as const);

export type CrablineFakeProviderChannel = (typeof CRABLINE_FAKE_PROVIDER_CHANNELS)[number];

export type CrablineFakeProviderManifest = TelegramFakeServerManifest;

export type StartedCrablineFakeProviderServer = StartedTelegramFakeServer;

export type StartCrablineFakeProviderServerParams = StartTelegramFakeServerParams & {
  channel: CrablineFakeProviderChannel;
};

export function isCrablineFakeProviderChannel(value: string): value is CrablineFakeProviderChannel {
  return CRABLINE_FAKE_PROVIDER_CHANNELS.includes(value as CrablineFakeProviderChannel);
}

export async function startCrablineFakeProviderServer(
  params: StartCrablineFakeProviderServerParams,
): Promise<StartedCrablineFakeProviderServer> {
  switch (params.channel) {
    case "telegram":
      return await startTelegramFakeServer(params);
  }
}
