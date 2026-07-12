import { CrablineError } from "../core/errors.js";
import type { BuiltinAdapterId, ManifestDefinition, ProviderConfig } from "../config/schema.js";
import { ScriptProviderAdapter } from "./builtin/script.js";
import { OPENCLAW_SUPPORT_CATALOG } from "./catalog.js";
import type {
  InboundEnvelope,
  ProbeResult,
  ProviderAdapter,
  ProviderContext,
  ProviderSupportStatus,
  SendContext,
  SendResult,
  WaitContext,
  WatchContext,
} from "./types.js";
import { getBuiltinTargetCodec, type BuiltinProviderAdapterId } from "./target-normalizers.js";

export type Registry = {
  catalog: typeof OPENCLAW_SUPPORT_CATALOG;
  resolve(providerId: string, fixtureId: string): ProviderAdapter;
};

type LazyAdapterId = BuiltinProviderAdapterId;
type ProviderFactory = () => Promise<ProviderAdapter>;
type ActiveWatch = {
  abort(): void;
  close(): Promise<void>;
};
type AdmittedOperation = {
  completion: Promise<unknown>;
  dispatched: Promise<void>;
};
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
  async googlechat({ config, providerId, userName }) {
    const { GoogleChatProviderAdapter } = await import("./builtin/googlechat.js");
    return new GoogleChatProviderAdapter(providerId, config, userName);
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
  async msteams({ config, providerId, userName }) {
    const { MsTeamsProviderAdapter } = await import("./builtin/msteams.js");
    return new MsTeamsProviderAdapter(providerId, config, userName);
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
    normalizeTarget: getBuiltinTargetCodec(params.adapter).normalize,
    platform: params.config.platform,
    status: "ready",
    supports: params.config.capabilities,
  });
}

class LazyProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status;
  readonly supports;

  readonly #adapterName: string;
  readonly #factory: ProviderFactory;
  readonly #normalizeTarget: ProviderAdapter["normalizeTarget"];
  readonly #activeWatches = new Set<ActiveWatch>();
  readonly #inFlightOperations = new Set<AdmittedOperation>();
  #cleanedUp = false;
  #cleanupPromise: Promise<void> | null = null;
  #providerInstance: ProviderAdapter | null = null;
  #providerPromise: Promise<ProviderAdapter> | null = null;

  constructor(params: {
    adapterName: string;
    factory: ProviderFactory;
    id: string;
    normalizeTarget: ProviderAdapter["normalizeTarget"];
    platform: ProviderAdapter["platform"];
    status: ProviderSupportStatus;
    supports: ProviderAdapter["supports"];
  }) {
    this.#adapterName = params.adapterName;
    this.#factory = params.factory;
    this.#normalizeTarget = params.normalizeTarget;
    this.id = params.id;
    this.platform = params.platform;
    this.status = params.status;
    this.supports = params.supports;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]) {
    this.#assertActive();
    return this.#normalizeTarget(target);
  }

  probe(context: ProviderContext): Promise<ProbeResult> {
    return this.#runOperation((provider) => provider.probe(context));
  }

  send(context: SendContext): Promise<SendResult> {
    return this.#runOperation((provider) => provider.send(context));
  }

  waitForInbound(context: WaitContext): Promise<InboundEnvelope | null> {
    return this.#runOperation((provider) => provider.waitForInbound(context));
  }

  watch(context: WatchContext): AsyncIterable<InboundEnvelope> {
    if (this.#cleanedUp) {
      const error = this.#cleanedUpError();
      return {
        [Symbol.asyncIterator](): AsyncIterator<InboundEnvelope> {
          return {
            next: () => Promise.reject(error),
          };
        },
      };
    }
    const controller = new AbortController();
    const abortFromContext = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) {
      abortFromContext();
    } else {
      context.signal?.addEventListener("abort", abortFromContext, { once: true });
    }
    const source = this.#watch(context, controller.signal)[Symbol.asyncIterator]();
    let activeWatch: ActiveWatch;
    let closed = false;
    let closePromise: Promise<IteratorResult<InboundEnvelope>> | null = null;
    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      context.signal?.removeEventListener("abort", abortFromContext);
      this.#activeWatches.delete(activeWatch);
    };
    const close = () => {
      closePromise ??= (async () => {
        controller.abort();
        try {
          return source.return
            ? await source.return()
            : { done: true as const, value: undefined as never };
        } finally {
          finish();
        }
      })();
      return closePromise;
    };
    const iterator: AsyncIterableIterator<InboundEnvelope> = {
      async next() {
        try {
          const result = await source.next();
          if (result.done) {
            finish();
          }
          return result;
        } catch (error) {
          finish();
          throw error;
        }
      },
      return: close,
      async throw(error?: unknown) {
        controller.abort();
        try {
          if (source.throw) {
            return await source.throw(error);
          }
          throw error;
        } finally {
          finish();
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    activeWatch = {
      abort: () => controller.abort(),
      close: async () => {
        await close();
      },
    };
    this.#activeWatches.add(activeWatch);
    return iterator;
  }

  async cleanup(): Promise<void> {
    this.#cleanedUp = true;
    for (const watch of this.#activeWatches) {
      watch.abort();
    }
    this.#cleanupPromise ??= (async () => {
      const operations = [...this.#inFlightOperations];
      const closingWatches = [...this.#activeWatches].map(async (watch) => await watch.close());
      const providerCleanupBegun = this.#beginProviderCleanup();
      void providerCleanupBegun.catch(() => undefined);
      const providerCleanup = this.#cleanupProvider(
        operations.map((operation) => operation.dispatched),
        providerCleanupBegun,
      );
      void providerCleanup.catch(() => undefined);
      await Promise.allSettled(operations.map((operation) => operation.completion));
      await Promise.allSettled(closingWatches);
      await providerCleanup;
    })();
    await this.#cleanupPromise;
  }

  async #provider(): Promise<ProviderAdapter> {
    this.#assertActive();
    this.#providerPromise ??= this.#factory()
      .then((provider) => {
        this.#providerInstance = provider;
        return provider;
      })
      .catch((error: unknown) => {
        this.#providerPromise = null;
        throw new CrablineError(
          `Provider adapter "${this.#adapterName}" could not load. Install its optional peer dependencies before using this adapter.`,
          { cause: error, kind: "config" },
        );
      });
    return await this.#providerPromise;
  }

  async *#watch(context: WatchContext, signal: AbortSignal): AsyncIterable<InboundEnvelope> {
    const provider = await this.#provider();
    if (!provider.watch) {
      throw new CrablineError(`Provider "${this.id}" does not implement watch.`, {
        kind: "config",
      });
    }
    yield* provider.watch({ ...context, signal });
  }

  #assertActive(): void {
    if (this.#cleanedUp) {
      throw this.#cleanedUpError();
    }
  }

  #beginProviderCleanup(): Promise<ProviderAdapter | null> {
    if (this.#providerInstance) {
      try {
        this.#providerInstance.beginCleanup?.();
        return Promise.resolve(this.#providerInstance);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const providerPromise = this.#providerPromise;
    if (!providerPromise) {
      return Promise.resolve(null);
    }
    return providerPromise.then((provider) => {
      provider.beginCleanup?.();
      return provider;
    });
  }

  async #cleanupProvider(
    dispatched: readonly Promise<void>[],
    providerCleanupBegun: Promise<ProviderAdapter | null>,
  ): Promise<void> {
    await Promise.allSettled(dispatched);
    const provider = await providerCleanupBegun;
    if (!provider) {
      return;
    }
    await provider.cleanup?.();
  }

  #runOperation<T>(run: (provider: ProviderAdapter) => Promise<T>): Promise<T> {
    if (this.#cleanedUp) {
      return Promise.reject(this.#cleanedUpError());
    }
    let markDispatched: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const completion = (async () => {
      try {
        const provider = await this.#provider();
        const result = run(provider);
        markDispatched?.();
        return await result;
      } catch (error) {
        markDispatched?.();
        throw error;
      }
    })();
    const operation = { completion, dispatched };
    this.#inFlightOperations.add(operation);
    void completion.then(
      () => this.#inFlightOperations.delete(operation),
      () => this.#inFlightOperations.delete(operation),
    );
    return completion;
  }

  #cleanedUpError(): CrablineError {
    return new CrablineError(`Provider "${this.id}" has been cleaned up.`, { kind: "config" });
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
