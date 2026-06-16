import { CrablineError } from "../core/errors.js";
import type {
  BuiltinAdapterId,
  FixtureMode,
  ManifestDefinition,
  ProviderConfig,
} from "../config/schema.js";
import { ScriptProviderAdapter } from "./builtin/script.js";
import { OPENCLAW_SUPPORT_CATALOG } from "./catalog.js";
import type {
  InboundEnvelope,
  NormalizedTarget,
  ProbeResult,
  ProviderAdapter,
  ProviderContext,
  ProviderSupportStatus,
  SendContext,
  SendResult,
  WaitContext,
  WatchContext,
} from "./types.js";

export type Registry = {
  catalog: typeof OPENCLAW_SUPPORT_CATALOG;
  resolve(providerId: string, fixtureId: string): ProviderAdapter;
};

const COMMON_PROVIDER_SUPPORT = [
  "probe",
  "send",
  "roundtrip",
  "agent",
] as const satisfies readonly FixtureMode[];

type LazyAdapterId = Exclude<BuiltinAdapterId, "script">;
type ProviderFactory = () => Promise<ProviderAdapter>;
type LazyProviderFactory = (params: {
  config: ProviderConfig;
  providerId: string;
  userName: string;
}) => Promise<ProviderAdapter>;

const LAZY_PROVIDER_FACTORIES = {
  async discord({ config, providerId, userName }) {
    const { DiscordProviderAdapter } = await import("./builtin/discord.js");
    return new DiscordProviderAdapter(providerId, config, userName);
  },
  async feishu({ config, providerId, userName }) {
    const { FeishuProviderAdapter } = await import("./builtin/feishu.js");
    return new FeishuProviderAdapter(providerId, config, userName);
  },
  async imessage({ config, providerId, userName }) {
    const { IMessageProviderAdapter } = await import("./builtin/imessage.js");
    return new IMessageProviderAdapter(providerId, config, userName);
  },
  async loopback({ config, providerId, userName }) {
    const { LoopbackProviderAdapter } = await import("./builtin/loopback.js");
    return new LoopbackProviderAdapter(providerId, config, userName);
  },
  async matrix({ config, providerId, userName }) {
    const { MatrixProviderAdapter } = await import("./builtin/matrix.js");
    return new MatrixProviderAdapter(providerId, config, userName);
  },
  async mattermost({ config, providerId, userName }) {
    const { MattermostProviderAdapter } = await import("./builtin/mattermost.js");
    return new MattermostProviderAdapter(providerId, config, userName);
  },
  async slack({ config, providerId, userName }) {
    const { SlackProviderAdapter } = await import("./builtin/slack.js");
    return new SlackProviderAdapter(providerId, config, userName);
  },
  async telegram({ config, providerId, userName }) {
    const { TelegramProviderAdapter } = await import("./builtin/telegram.js");
    return new TelegramProviderAdapter(providerId, config, userName);
  },
  async whatsapp({ config, providerId, userName }) {
    const { WhatsAppProviderAdapter } = await import("./builtin/whatsapp.js");
    return new WhatsAppProviderAdapter(providerId, config, userName);
  },
  async zalo({ config, providerId, userName }) {
    const { ZaloProviderAdapter } = await import("./builtin/zalo.js");
    return new ZaloProviderAdapter(providerId, config, userName);
  },
} satisfies Record<LazyAdapterId, LazyProviderFactory>;

function isLazyAdapter(adapter: BuiltinAdapterId): adapter is LazyAdapterId {
  return adapter in LAZY_PROVIDER_FACTORIES;
}

function normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
  const normalized: NormalizedTarget = { id: target.id, metadata: target.metadata };
  if (target.channelId) {
    normalized.channelId = target.channelId;
  }
  if (target.threadId) {
    normalized.threadId = target.threadId;
  }
  return normalized;
}

function createLazyProvider(params: {
  adapter: LazyAdapterId;
  config: ProviderConfig;
  providerId: string;
  userName: string;
}): ProviderAdapter {
  return new LazyProviderAdapter({
    adapterName: params.adapter,
    factory: () => LAZY_PROVIDER_FACTORIES[params.adapter](params),
    id: params.providerId,
    platform: params.config.platform,
    status: "ready",
    supports: COMMON_PROVIDER_SUPPORT,
  });
}

class LazyProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status;
  readonly supports;

  readonly #adapterName: string;
  readonly #factory: ProviderFactory;
  #providerPromise: Promise<ProviderAdapter> | null = null;

  constructor(params: {
    adapterName: string;
    factory: ProviderFactory;
    id: string;
    platform: ProviderAdapter["platform"];
    status: ProviderSupportStatus;
    supports: ProviderAdapter["supports"];
  }) {
    this.#adapterName = params.adapterName;
    this.#factory = params.factory;
    this.id = params.id;
    this.platform = params.platform;
    this.status = params.status;
    this.supports = params.supports;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget {
    return normalizeTarget(target);
  }

  async probe(context: ProviderContext): Promise<ProbeResult> {
    return await (await this.#provider()).probe(context);
  }

  async send(context: SendContext): Promise<SendResult> {
    return await (await this.#provider()).send(context);
  }

  async waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    return await (await this.#provider()).waitForInbound(context);
  }

  watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    return this.#watch(context);
  }

  async cleanup(): Promise<void> {
    if (!this.#providerPromise) {
      return;
    }
    await (await this.#providerPromise).cleanup?.();
  }

  async #provider(): Promise<ProviderAdapter> {
    this.#providerPromise ??= this.#factory().catch((error: unknown) => {
      this.#providerPromise = null;
      throw new CrablineError(
        `Provider adapter "${this.#adapterName}" could not load. Install its optional peer dependencies before using this adapter.`,
        { cause: error, kind: "config" },
      );
    });
    return await this.#providerPromise;
  }

  async *#watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    const provider = await this.#provider();
    if (!provider.watch) {
      throw new CrablineError(`Provider "${this.id}" does not implement watch.`, {
        kind: "config",
      });
    }
    yield* provider.watch(context);
  }
}

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

      if (isLazyAdapter(config.adapter)) {
        return createLazyProvider({
          adapter: config.adapter,
          config,
          providerId,
          userName: manifest.userName,
        });
      }

      return new ScriptProviderAdapter(context);
    },
  };
}
