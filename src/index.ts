export { resolveTelegramAdapterConfig } from "./providers/builtin/telegram.js";
export { resolveWhatsAppAdapterConfig } from "./providers/builtin/whatsapp.js";
export { startTelegramFakeServer } from "./fake-servers/telegram.js";
export {
  CRABLINE_FAKE_PROVIDER_CHANNELS,
  isCrablineFakeProviderChannel,
  startCrablineFakeProviderServer,
} from "./fake-servers/index.js";
export {
  createOpenClawCrablineAgentDelivery,
  createOpenClawCrablineChannelReportNotes,
  createOpenClawCrablineFakeProviderBinding,
  createOpenClawCrablineInbound,
  createOpenClawCrablineOutboundFromRecorderEvent,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  probeOpenClawCrablineFakeProvider,
  resolveOpenClawCrablineChannel,
  resolveOpenClawCrablineChannelDriverSelection,
  runOpenClawCrablineChannelDriverSmoke,
  startOpenClawCrablineAdapter,
} from "./openclaw.js";
export {
  BUILTIN_ADAPTERS,
  FIXTURE_MODES,
  INBOUND_AUTHORS,
  INBOUND_NONCE_MODES,
  INBOUND_STRATEGIES,
  ManifestSchema,
  PROVIDER_PLATFORMS,
  ProviderConfigSchema,
} from "./config/schema.js";
export { OPENCLAW_SUPPORT_CATALOG } from "./providers/catalog.js";
export { createRegistry } from "./providers/registry.js";
export type { CatalogEntry } from "./providers/catalog.js";
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
  ProviderSupportStatus,
  SendContext,
  SendResult,
  WaitContext,
  WatchContext,
} from "./providers/types.js";
export type {
  StartedTelegramFakeServer,
  StartTelegramFakeServerParams,
  TelegramFakeServerManifest,
} from "./fake-servers/telegram.js";
export type {
  CrablineFakeProviderChannel,
  CrablineFakeProviderManifest,
  StartedCrablineFakeProviderServer,
  StartCrablineFakeProviderServerParams,
} from "./fake-servers/index.js";
export type {
  OpenClawCrablineAgentDelivery,
  OpenClawCrablineChannelDriverSelection,
  OpenClawCrablineChannelDriverSmokeResult,
  OpenClawCrablineGatewayBinding,
  OpenClawCrablineInbound,
  OpenClawCrablineInboundInput,
  OpenClawCrablineOutboundMessage,
  StartedOpenClawCrablineAdapter,
  StartOpenClawCrablineAdapterParams,
} from "./openclaw.js";
