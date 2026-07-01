export { resolveTelegramAdapterConfig } from "./providers/builtin/telegram.js";
export { resolveWhatsAppAdapterConfig } from "./providers/builtin/whatsapp.js";
export { startMattermostServer } from "./servers/mattermost.js";
export { startMatrixServer } from "./servers/matrix.js";
export { startSignalServer } from "./servers/signal.js";
export { startSlackServer, startSlackServer as startSlackFakeServer } from "./servers/slack.js";
export {
  startTelegramServer,
  startTelegramServer as startTelegramFakeServer,
} from "./servers/telegram.js";
export {
  startWhatsAppServer,
  startWhatsAppServer as startWhatsAppFakeServer,
} from "./servers/whatsapp.js";
export {
  CRABLINE_SERVER_CHANNELS,
  CRABLINE_SERVER_CHANNELS as CRABLINE_FAKE_PROVIDER_CHANNELS,
  isCrablineServerChannel,
  isCrablineServerChannel as isCrablineFakeProviderChannel,
  startCrablineServer,
  startCrablineServer as startCrablineFakeProviderServer,
} from "./servers/index.js";
export {
  createOpenClawCrablineAgentDelivery,
  createOpenClawCrablineChannelReportNotes,
  createOpenClawCrablineProviderBinding as createOpenClawCrablineFakeProviderBinding,
  createOpenClawCrablineProviderBinding,
  createOpenClawCrablineInbound,
  createOpenClawCrablineOutboundFromRecorderEvent,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  probeOpenClawCrablineProvider as probeOpenClawCrablineFakeProvider,
  probeOpenClawCrablineProvider,
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
  MattermostServerManifest,
  StartedMattermostServer,
  StartMattermostServerParams,
} from "./servers/mattermost.js";
export type {
  MatrixServerManifest,
  StartedMatrixServer,
  StartMatrixServerParams,
} from "./servers/matrix.js";
export type {
  SignalServerManifest,
  StartedSignalServer,
  StartSignalServerParams,
} from "./servers/signal.js";
export type {
  SlackServerManifest as SlackFakeServerManifest,
  SlackServerManifest,
  StartedSlackServer as StartedSlackFakeServer,
  StartedSlackServer,
  StartSlackServerParams as StartSlackFakeServerParams,
  StartSlackServerParams,
} from "./servers/slack.js";
export type {
  StartedTelegramServer as StartedTelegramFakeServer,
  StartedTelegramServer,
  StartTelegramServerParams as StartTelegramFakeServerParams,
  StartTelegramServerParams,
  TelegramServerManifest as TelegramFakeServerManifest,
  TelegramServerManifest,
} from "./servers/telegram.js";
export type {
  StartedWhatsAppServer as StartedWhatsAppFakeServer,
  StartedWhatsAppServer,
  StartWhatsAppServerParams as StartWhatsAppFakeServerParams,
  StartWhatsAppServerParams,
  WhatsAppBaileysMessage,
  WhatsAppServerManifest as WhatsAppFakeServerManifest,
  WhatsAppServerManifest,
} from "./servers/whatsapp.js";
export type {
  CrablineServerChannel as CrablineFakeProviderChannel,
  CrablineServerChannel,
  CrablineServerManifest as CrablineFakeProviderManifest,
  CrablineServerManifest,
  StartedCrablineServer as StartedCrablineFakeProviderServer,
  StartedCrablineServer,
  StartCrablineServerParams as StartCrablineFakeProviderServerParams,
  StartCrablineServerParams,
} from "./servers/index.js";
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
