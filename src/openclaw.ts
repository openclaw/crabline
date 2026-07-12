import {
  CRABLINE_SERVER_CHANNELS,
  isCrablineServerChannel,
  startCrablineServer,
  type CrablineServerChannel,
  type CrablineServerManifest,
  type StartedCrablineServer,
} from "./servers/index.js";
import { SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/slack.js";
import { MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/mattermost.js";
import { MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/matrix.js";
import { SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/signal.js";
import { TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/telegram.js";
import { WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/whatsapp.js";
import { ZALO_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/zalo.js";
import {
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  parseQaTarget,
  runOpenClawCrablineProviderProbe,
  type OpenClawCrablineAgentDelivery,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineChannelDriverSmokeResult,
  type OpenClawCrablineGatewayBinding,
  type OpenClawCrablineInbound,
  type OpenClawCrablineInboundInput,
  type OpenClawCrablineOutboundMessage,
  type OpenClawCrablineProviderAdapter,
  type OpenClawCrablineProviderBridge,
  type OpenClawCrablineProviderBridgeRegistry,
  type StartedOpenClawCrablineAdapter,
  type StartOpenClawCrablineAdapterParams,
} from "./openclaw/shared.js";
import { publishPrivateFileAtomically } from "./openclaw/private-file.js";
import {
  acquireOpenClawCrablineSmokeRunLock,
  releaseOpenClawCrablineSmokeRunLock,
} from "./openclaw/smoke-lock.js";
import fs from "node:fs/promises";
import path from "node:path";

export {
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
};
export type {
  OpenClawCrablineAgentDelivery,
  OpenClawCrablineChannelDriverSelection,
  OpenClawCrablineChannelDriverSmokeResult,
  OpenClawCrablineConversation,
  OpenClawCrablineGatewayBinding,
  OpenClawCrablineInbound,
  OpenClawCrablineInboundInput,
  OpenClawCrablineOutboundMessage,
  StartedOpenClawCrablineAdapter,
  StartOpenClawCrablineAdapterParams,
} from "./openclaw/shared.js";

const OPENCLAW_CRABLINE_PROVIDER_BRIDGES = {
  mattermost: MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  matrix: MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  signal: SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  slack: SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  telegram: TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  whatsapp: WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  zalo: ZALO_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
} satisfies OpenClawCrablineProviderBridgeRegistry;

const OPENCLAW_CRABLINE_PROVIDER_BRIDGE_LIST = Object.values(
  OPENCLAW_CRABLINE_PROVIDER_BRIDGES,
) as readonly OpenClawCrablineProviderBridge[];

function createOpenClawCrablineProviderAdapter(
  manifest: CrablineServerManifest,
): OpenClawCrablineProviderAdapter {
  const bridge = OPENCLAW_CRABLINE_PROVIDER_BRIDGE_LIST.find(
    (candidate) => candidate.provider === manifest.provider,
  );
  if (bridge) {
    const adapter = bridge.createAdapterFromManifest(manifest);
    return {
      ...adapter,
      probe: () =>
        runOpenClawCrablineProviderProbe(manifest.provider, (signal) => adapter.probe(signal)),
    };
  }
  throw new Error("Unsupported OpenClaw provider binding.");
}

export function resolveOpenClawCrablineChannel(input?: string | null): CrablineServerChannel {
  const channel = input?.trim().toLowerCase() || OPENCLAW_CRABLINE_DEFAULT_CHANNEL;
  if (isCrablineServerChannel(channel)) {
    return channel;
  }
  throw new Error(
    `--channel must be one of ${CRABLINE_SERVER_CHANNELS.join(", ")} for --channel-driver crabline, got "${input}".`,
  );
}

export function resolveOpenClawCrablineChannelDriverSelection(params: {
  channel?: string | null;
}): OpenClawCrablineChannelDriverSelection {
  return {
    channel: resolveOpenClawCrablineChannel(params.channel),
    channelDriver: "crabline",
    capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
    smokeArtifactPath: OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  };
}

export async function probeOpenClawCrablineProvider(
  manifest: CrablineServerManifest,
): Promise<unknown> {
  return await createOpenClawCrablineProviderAdapter(manifest).probe();
}

export function createOpenClawCrablineProviderBinding(
  manifest: CrablineServerManifest,
): OpenClawCrablineGatewayBinding {
  return createOpenClawCrablineProviderAdapter(manifest).createBinding();
}

export function createOpenClawCrablineAgentDelivery(params: {
  manifest: CrablineServerManifest;
  target: string;
}): OpenClawCrablineAgentDelivery {
  return createOpenClawCrablineProviderAdapter(params.manifest).createAgentDelivery(
    parseQaTarget(params.target),
  );
}

export function createOpenClawCrablineInbound(params: {
  input: OpenClawCrablineInboundInput;
  manifest: CrablineServerManifest;
}): OpenClawCrablineInbound {
  return createOpenClawCrablineProviderAdapter(params.manifest).createInbound(params.input);
}

export function createOpenClawCrablineOutboundFromRecorderEvent(params: {
  event: unknown;
  manifest: CrablineServerManifest;
  targetByProviderTarget: ReadonlyMap<string, string>;
}): OpenClawCrablineOutboundMessage | null {
  return createOpenClawCrablineProviderAdapter(params.manifest).createOutboundFromRecorderEvent({
    event: params.event,
    targetByProviderTarget: params.targetByProviderTarget,
  });
}

export async function startOpenClawCrablineAdapter(
  params: StartOpenClawCrablineAdapterParams,
): Promise<StartedOpenClawCrablineAdapter> {
  const server: StartedCrablineServer = await startCrablineServer({
    channel: params.channel,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath,
  });
  const providerAdapter = createOpenClawCrablineProviderAdapter(server.manifest);
  const binding = providerAdapter.createBinding();
  return {
    ...binding,
    close: server.close,
    createGatewayConfig: (openclawConfig = params.openclawConfig ?? {}) =>
      binding.createGatewayConfig(openclawConfig),
    createAgentDelivery: ({ target }) => providerAdapter.createAgentDelivery(parseQaTarget(target)),
    createInbound: ({ input }) => providerAdapter.createInbound(input),
    createOutboundFromRecorderEvent: ({ event, targetByProviderTarget }) =>
      providerAdapter.createOutboundFromRecorderEvent({
        event,
        targetByProviderTarget,
      }),
    manifest: server.manifest,
    probe: () => providerAdapter.probe(),
  };
}

export async function runOpenClawCrablineChannelDriverSmoke(params: {
  outputDir: string;
  selection: OpenClawCrablineChannelDriverSelection;
}): Promise<OpenClawCrablineChannelDriverSmokeResult> {
  const outputDir = path.resolve(params.outputDir);
  const smokeLock = await acquireOpenClawCrablineSmokeRunLock({
    channel: params.selection.channel,
    outputDir,
  });

  try {
    const manifestPath = path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH);
    const recorderPath = path.join(
      outputDir,
      "artifacts",
      "crabline",
      `${params.selection.channel}-fake-provider.jsonl`,
    );
    await fs.mkdir(path.dirname(recorderPath), { recursive: true });
    const adapter = await startOpenClawCrablineAdapter({
      channel: params.selection.channel,
      openclawConfig: {},
      recorderPath,
    });
    try {
      await publishPrivateFileAtomically(
        manifestPath,
        `${JSON.stringify(adapter.manifest, null, 2)}\n`,
      );
      const probe = await adapter.probe();
      return {
        capabilityReport: {
          result: {
            driver: "crabline",
            selectedChannel: params.selection.channel,
            supportedChannels: [...CRABLINE_SERVER_CHANNELS],
          },
        },
        manifestPath: path.basename(manifestPath),
        smoke: {
          manifestPath: path.basename(manifestPath),
          result: {
            ok: true,
            probe,
            provider: adapter.manifest.provider,
            endpoints: adapter.manifest.endpoints,
            recorderPath: path.relative(outputDir, adapter.manifest.recorderPath),
          },
        },
      };
    } finally {
      await adapter.close();
    }
  } finally {
    await releaseOpenClawCrablineSmokeRunLock(smokeLock);
  }
}

export function createOpenClawCrablineChannelReportNotes(
  selection: OpenClawCrablineChannelDriverSelection | null | undefined,
): string[] {
  if (!selection) {
    return [];
  }

  return [
    `Channel driver: ${selection.channelDriver} local provider for ${selection.channel}.`,
    `Channel capability report: ${selection.capabilityMatrixPath}.`,
    `Channel driver smoke: ${selection.smokeArtifactPath}.`,
    "Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.",
  ];
}
