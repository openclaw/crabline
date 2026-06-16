import { ManifestSchema, type ManifestDefinition, type ProviderPlatform } from "./config/schema.js";
import { runFixtureCommand, type CommandRunResult } from "./core/run.js";
import { LocalChannelProviderAdapter } from "./providers/builtin/channel.js";
import { OPENCLAW_SUPPORT_CATALOG } from "./providers/catalog.js";
import type { Registry } from "./providers/registry.js";
import {
  LOCAL_CHANNEL_DRIVER_METADATA,
  LOCAL_CHANNEL_DRIVER_MATRIX,
  type ChannelCapabilityMatrixRow,
  type ChannelDriverMetadata,
} from "./channels/index.js";

export type LocalChannelDriverSmokeResult = {
  driver: ChannelDriverMetadata;
  matrix: readonly ChannelCapabilityMatrixRow[];
  result: CommandRunResult;
};

export function listLocalChannelDriverMatrix() {
  return {
    drivers: LOCAL_CHANNEL_DRIVER_METADATA,
    matrix: LOCAL_CHANNEL_DRIVER_MATRIX,
  };
}

export function findLocalChannelDriver(params: {
  channel: ProviderPlatform;
}): ChannelDriverMetadata | null {
  return (
    listLocalChannelDriverMatrix().drivers.find((driver) => driver.channel === params.channel) ??
    null
  );
}

function buildLocalChannelSmokeManifest(params: {
  driver: ChannelDriverMetadata;
  userName?: string;
}): ManifestDefinition {
  const providerId = `${params.driver.channel}-local`;
  const fixtureId = localChannelSmokeFixtureId(params.driver);

  return ManifestSchema.parse({
    configVersion: 1,
    userName: params.userName ?? "crabline",
    providers: {
      [providerId]: {
        adapter: "channel",
        platform: params.driver.channel,
        channel: {
          botUserName: defaultBotUserName(params.driver.channel),
          qaResponse: {
            mode: "ack",
          },
        },
      },
    },
    fixtures: [
      {
        id: fixtureId,
        provider: providerId,
        mode: "roundtrip",
        target: localChannelSmokeTarget(params.driver),
        inboundMatch: {
          author: "assistant",
          nonce: "contains",
          strategy: "contains",
        },
        timeoutMs: 1_000,
      },
    ],
  });
}

function createLocalChannelDriverRegistry(manifest: ManifestDefinition): Registry {
  return {
    catalog: OPENCLAW_SUPPORT_CATALOG,
    resolve(providerId, fixtureId) {
      const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
      if (!fixture) {
        throw new Error(`Unknown fixture: ${fixtureId}`);
      }
      const config = manifest.providers[providerId];
      if (!config) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      if (config.adapter !== "channel") {
        throw new Error(`Expected local channel provider: ${providerId}`);
      }

      return new LocalChannelProviderAdapter(providerId, config);
    },
  };
}

export async function runLocalChannelDriverSmoke(params: {
  channel: ProviderPlatform;
  manifestPath?: string;
  userName?: string;
}): Promise<LocalChannelDriverSmokeResult> {
  const driver = findLocalChannelDriver({
    channel: params.channel,
  });
  if (!driver) {
    throw new Error(`local channel driver not found: ${params.channel}`);
  }

  const manifest = buildLocalChannelSmokeManifest({
    driver,
    ...(params.userName ? { userName: params.userName } : {}),
  });
  const manifestPath = params.manifestPath ?? "crabline-local-channel-driver-smoke.json";
  const registry = createLocalChannelDriverRegistry(manifest);
  const result = await runFixtureCommand({
    fixtureId: localChannelSmokeFixtureId(driver),
    manifest,
    manifestPath,
    registry,
  });
  if (!result.ok) {
    throw new Error(
      `local channel driver smoke failed: ${result.diagnostics.join("; ") || "unknown failure"}`,
    );
  }

  return {
    driver,
    matrix: LOCAL_CHANNEL_DRIVER_MATRIX,
    result,
  };
}

function defaultBotUserName(channel: ChannelDriverMetadata["channel"]): string {
  return channel === "whatsapp" ? "crabline_whatsapp_bot" : "crabline_telegram_bot";
}

function localChannelSmokeFixtureId(driver: ChannelDriverMetadata): string {
  return `${driver.channel}-local-driver-smoke`;
}

function localChannelSmokeTarget(driver: ChannelDriverMetadata): {
  id: string;
  metadata: Record<string, string>;
} {
  if (driver.channel === "whatsapp") {
    return {
      id: "15551230001",
      metadata: {
        chatType: "dm",
        pushName: "qa-user",
        userJid: "15551230001@s.whatsapp.net",
      },
    };
  }

  return {
    id: "100000001",
    metadata: {
      chatType: "dm",
      userName: "qa-user",
    },
  };
}
