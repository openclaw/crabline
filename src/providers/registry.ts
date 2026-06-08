import { CrablineError } from "../core/errors.js";
import type { ManifestDefinition } from "../config/schema.js";
import { LocalChannelProviderAdapter } from "./builtin/channel.js";
import { DiscordProviderAdapter } from "./builtin/discord.js";
import { IMessageProviderAdapter } from "./builtin/imessage.js";
import { LoopbackProviderAdapter } from "./builtin/loopback.js";
import { MatrixProviderAdapter } from "./builtin/matrix.js";
import { SlackProviderAdapter } from "./builtin/slack.js";
import { ScriptProviderAdapter } from "./builtin/script.js";
import { OPENCLAW_SUPPORT_CATALOG } from "./catalog.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";

export type Registry = {
  catalog: typeof OPENCLAW_SUPPORT_CATALOG;
  resolve(providerId: string, fixtureId: string): ProviderAdapter;
};

export function createRegistry(manifest: ManifestDefinition, manifestPath: string): Registry {
  return {
    catalog: OPENCLAW_SUPPORT_CATALOG,
    resolve(providerId, fixtureId) {
      const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
      if (!fixture) {
        throw new CrablineError(`Unknown fixture: ${fixtureId}`, { kind: "config" });
      }

      const config = manifest.providers[providerId];
      if (!config) {
        throw new CrablineError(`Unknown provider: ${providerId}`, { kind: "config" });
      }

      if (config.status === "disabled") {
        throw new CrablineError(`Provider "${providerId}" is disabled.`, { kind: "config" });
      }

      const context: ProviderContext = {
        config,
        fixture,
        manifestPath,
        providerId,
        userName: manifest.userName,
      };

      if (config.adapter === "loopback") {
        return new LoopbackProviderAdapter(providerId, config, manifest.userName);
      }

      if (config.adapter === "channel") {
        return new LocalChannelProviderAdapter(providerId, config);
      }

      if (config.adapter === "discord") {
        return new DiscordProviderAdapter(providerId, config, manifest.userName);
      }

      if (config.adapter === "matrix") {
        return new MatrixProviderAdapter(providerId, config, manifest.userName);
      }

      if (config.adapter === "imessage") {
        return new IMessageProviderAdapter(providerId, config, manifest.userName);
      }

      if (config.adapter === "slack") {
        return new SlackProviderAdapter(providerId, config, manifest.userName);
      }

      return new ScriptProviderAdapter(context);
    },
  };
}
