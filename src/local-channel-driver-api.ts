import { ManifestSchema, type ManifestDefinition, type ProviderPlatform } from "./config/schema.js";
import { runFixtureCommand, type CommandRunResult } from "./core/run.js";
import { LocalChannelProviderAdapter } from "./providers/builtin/channel.js";
import { OPENCLAW_SUPPORT_CATALOG } from "./providers/catalog.js";
import type { Registry } from "./providers/registry.js";
import {
  LOCAL_CHANNEL_DRIVER_MATRIX,
  TELEGRAM_LOCAL_DRIVER_METADATA,
  type ChannelCapabilityMatrixRow,
  type ChannelDriverMetadata,
  type LocalChannelDriverId,
} from "./channels/index.js";

export type LocalChannelDriverSmokeResult = {
  driver: ChannelDriverMetadata;
  matrix: readonly ChannelCapabilityMatrixRow[];
  result: CommandRunResult;
};

export function listLocalChannelDriverMatrix() {
  return {
    drivers: [TELEGRAM_LOCAL_DRIVER_METADATA],
    matrix: LOCAL_CHANNEL_DRIVER_MATRIX,
  };
}

export function findLocalChannelDriver(params: {
  channel: ProviderPlatform;
  driverId?: LocalChannelDriverId;
}): ChannelDriverMetadata | null {
  return (
    listLocalChannelDriverMatrix().drivers.find(
      (driver) =>
        driver.channel === params.channel &&
        (!params.driverId || driver.driverId === params.driverId),
    ) ?? null
  );
}

function buildLocalChannelSmokeManifest(params: {
  driver: ChannelDriverMetadata;
  userName?: string;
}): ManifestDefinition {
  if (params.driver.channel !== "telegram") {
    throw new Error(
      `unsupported local channel driver: ${params.driver.channel}/${params.driver.driverId}`,
    );
  }

  return ManifestSchema.parse({
    configVersion: 1,
    userName: params.userName ?? "crabline",
    providers: {
      "telegram-local": {
        adapter: "channel",
        platform: "telegram",
        channel: {
          driver: params.driver.driverId,
          botUserName: "crabline_telegram_bot",
          qaResponse: {
            mode: "ack",
          },
        },
      },
    },
    fixtures: [
      {
        id: "telegram-local-driver-smoke",
        provider: "telegram-local",
        mode: "roundtrip",
        target: {
          id: "100000001",
          metadata: {
            chatType: "dm",
            userName: "qa-user",
          },
        },
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
  driverId?: LocalChannelDriverId;
  manifestPath?: string;
  userName?: string;
}): Promise<LocalChannelDriverSmokeResult> {
  const driver = findLocalChannelDriver({
    channel: params.channel,
    ...(params.driverId ? { driverId: params.driverId } : {}),
  });
  if (!driver) {
    const suffix = params.driverId ? `/${params.driverId}` : "";
    throw new Error(`local channel driver not found: ${params.channel}${suffix}`);
  }

  const manifest = buildLocalChannelSmokeManifest({
    driver,
    ...(params.userName ? { userName: params.userName } : {}),
  });
  const manifestPath = params.manifestPath ?? "crabline-local-channel-driver-smoke.json";
  const registry = createLocalChannelDriverRegistry(manifest);
  const result = await runFixtureCommand({
    fixtureId: "telegram-local-driver-smoke",
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
