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

export const CRABLINE_FAKE_PROVIDER_CHANNELS = Object.freeze(["telegram", "whatsapp"] as const);

export type CrablineFakeProviderChannel = (typeof CRABLINE_FAKE_PROVIDER_CHANNELS)[number];

export type CrablineFakeProviderManifest = TelegramFakeServerManifest | WhatsAppFakeServerManifest;

export type StartedCrablineFakeProviderServer =
  | StartedTelegramFakeServer
  | StartedWhatsAppFakeServer;

export type StartCrablineFakeProviderServerParams =
  | (StartTelegramFakeServerParams & { channel: "telegram" })
  | (StartWhatsAppFakeServerParams & { channel: "whatsapp" });

type FakeProviderServerDefinition = {
  start(params: StartCrablineFakeProviderServerParams): Promise<StartedCrablineFakeProviderServer>;
};

const FAKE_PROVIDER_SERVER_DEFINITIONS = {
  telegram: {
    start: async (params) =>
      await startTelegramFakeServer(
        params as StartTelegramFakeServerParams & {
          channel: "telegram";
        },
      ),
  },
  whatsapp: {
    start: async (params) =>
      await startWhatsAppFakeServer(
        params as StartWhatsAppFakeServerParams & {
          channel: "whatsapp";
        },
      ),
  },
} satisfies Record<CrablineFakeProviderChannel, FakeProviderServerDefinition>;

export function isCrablineFakeProviderChannel(value: string): value is CrablineFakeProviderChannel {
  return Object.hasOwn(FAKE_PROVIDER_SERVER_DEFINITIONS, value);
}

export async function startCrablineFakeProviderServer(
  params: StartCrablineFakeProviderServerParams,
): Promise<StartedCrablineFakeProviderServer> {
  const definition = FAKE_PROVIDER_SERVER_DEFINITIONS[params.channel];
  if (!definition) {
    throw new CrablineError(`Unsupported fake provider server: ${String(params.channel)}`, {
      kind: "config",
    });
  }
  return await definition.start(params);
}
