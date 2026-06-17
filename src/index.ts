export { resolveTelegramAdapterConfig } from "./providers/builtin/telegram.js";
export { resolveWhatsAppAdapterConfig } from "./providers/builtin/whatsapp.js";
export { createRegistry } from "./providers/registry.js";
export type { Registry } from "./providers/registry.js";
export type {
  BuiltinAdapterId,
  FixtureDefinition,
  FixtureMode,
  ManifestDefinition,
  ProviderConfig,
  ProviderPlatform,
} from "./config/schema.js";
export type {
  InboundEnvelope,
  NormalizedTarget,
  ProbeResult,
  ProviderAdapter,
  ProviderContext,
  SendContext,
  SendResult,
  WaitContext,
  WatchContext,
} from "./providers/types.js";
