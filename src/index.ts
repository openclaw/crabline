export { resolveTelegramAdapterConfig } from "./providers/builtin/telegram.js";
export { resolveWhatsAppAdapterConfig } from "./providers/builtin/whatsapp.js";
export { startSlackFakeServer } from "./fake-servers/slack.js";
export { startTelegramFakeServer } from "./fake-servers/telegram.js";
export {
  createWhatsAppBaileysMockSocket,
  DEFAULT_WHATSAPP_BAILEYS_MOCK_REGISTRY,
  startWhatsAppFakeServer,
  WhatsAppBaileysMockRegistry,
} from "./fake-servers/whatsapp.js";
export {
  CRABLINE_WHATSAPP_ACCESS_TOKEN_ENV,
  CRABLINE_WHATSAPP_API_ROOT_ENV,
  CRABLINE_WHATSAPP_RECORDER_PATH_ENV,
  CRABLINE_WHATSAPP_SELF_JID_ENV,
  createWhatsAppBaileysRuntimeMockSocket,
  createWhatsAppBaileysRuntimeMockSocketFromEnv,
  createWhatsAppSocket,
  startWhatsAppBaileysRecorderBridge,
} from "./fake-servers/whatsapp-socket-factory.js";
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
  SlackFakeServerManifest,
  StartedSlackFakeServer,
  StartSlackFakeServerParams,
} from "./fake-servers/slack.js";
export type {
  StartedTelegramFakeServer,
  StartTelegramFakeServerParams,
  TelegramFakeServerManifest,
} from "./fake-servers/telegram.js";
export type {
  StartedWhatsAppFakeServer,
  StartWhatsAppFakeServerParams,
  WhatsAppBaileysMessage,
  WhatsAppBaileysMockConfig,
  WhatsAppBaileysMockSocketOverrides,
  WhatsAppBaileysMockSocket,
  WhatsAppBaileysPresence,
  WhatsAppFakeServerManifest,
} from "./fake-servers/whatsapp.js";
export type {
  WhatsAppBaileysRuntimeGroupMetadata,
  WhatsAppBaileysRuntimeMockConfig,
  WhatsAppBaileysRuntimeMockSocket,
  WhatsAppSocketFactoryOptions,
} from "./fake-servers/whatsapp-socket-factory.js";
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
