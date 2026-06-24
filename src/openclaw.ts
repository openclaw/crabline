import {
  CRABLINE_FAKE_PROVIDER_CHANNELS,
  isCrablineFakeProviderChannel,
  startCrablineFakeProviderServer,
  type CrablineFakeProviderChannel,
  type CrablineFakeProviderManifest,
  type StartedCrablineFakeProviderServer,
} from "./fake-servers/index.js";
import { TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/telegram.js";
import { WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/whatsapp.js";
import {
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  parseQaTarget,
  type OpenClawCrablineAgentDelivery,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineChannelDriverSmokeResult,
  type OpenClawCrablineGatewayBinding,
  type OpenClawCrablineInbound,
  type OpenClawCrablineInboundInput,
  type OpenClawCrablineOutboundMessage,
  type OpenClawCrablineProviderBridge,
  type StartedOpenClawCrablineAdapter,
  type StartOpenClawCrablineAdapterParams,
} from "./openclaw/shared.js";
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
  telegram: TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  whatsapp: WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
} satisfies Record<CrablineFakeProviderChannel, OpenClawCrablineProviderBridge>;

function getOpenClawCrablineProviderBridge(
  manifest: CrablineFakeProviderManifest,
): OpenClawCrablineProviderBridge {
  const bridge = OPENCLAW_CRABLINE_PROVIDER_BRIDGES[manifest.provider];
  if (!bridge) {
    throw new Error(`Unsupported OpenClaw fake provider binding: ${String(manifest.provider)}`);
  }
  return bridge;
}

export function resolveOpenClawCrablineChannel(input?: string | null): CrablineFakeProviderChannel {
  const channel = input?.trim().toLowerCase() || OPENCLAW_CRABLINE_DEFAULT_CHANNEL;
  if (isCrablineFakeProviderChannel(channel)) {
    return channel;
  }
  throw new Error(
    `--channel must be one of ${CRABLINE_FAKE_PROVIDER_CHANNELS.join(", ")} for --channel-driver crabline, got "${input}".`,
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

export async function probeOpenClawCrablineFakeProvider(
  manifest: CrablineFakeProviderManifest,
): Promise<unknown> {
  return await getOpenClawCrablineProviderBridge(manifest).probe(manifest);
}

export function createOpenClawCrablineFakeProviderBinding(
  manifest: CrablineFakeProviderManifest,
): OpenClawCrablineGatewayBinding {
  return getOpenClawCrablineProviderBridge(manifest).createBinding(manifest);
}

export function createOpenClawCrablineAgentDelivery(params: {
  manifest: CrablineFakeProviderManifest;
  target: string;
}): OpenClawCrablineAgentDelivery {
  return getOpenClawCrablineProviderBridge(params.manifest).createAgentDelivery({
    manifest: params.manifest,
    parsed: parseQaTarget(params.target),
  });
}

export function createOpenClawCrablineInbound(params: {
  input: OpenClawCrablineInboundInput;
  manifest: CrablineFakeProviderManifest;
}): OpenClawCrablineInbound {
  return getOpenClawCrablineProviderBridge(params.manifest).createInbound(params);
}

export function createOpenClawCrablineOutboundFromRecorderEvent(params: {
  event: unknown;
  manifest: CrablineFakeProviderManifest;
  targetByProviderTarget: ReadonlyMap<string, string>;
}): OpenClawCrablineOutboundMessage | null {
  return getOpenClawCrablineProviderBridge(params.manifest).createOutboundFromRecorderEvent(params);
}

export async function startOpenClawCrablineAdapter(
  params: StartOpenClawCrablineAdapterParams,
): Promise<StartedOpenClawCrablineAdapter> {
  const server: StartedCrablineFakeProviderServer = await startCrablineFakeProviderServer({
    channel: params.channel,
    recorderPath: params.recorderPath,
  });
  const binding = createOpenClawCrablineFakeProviderBinding(server.manifest);
  return {
    ...binding,
    close: server.close,
    createGatewayConfig: (openclawConfig = params.openclawConfig ?? {}) =>
      binding.createGatewayConfig(openclawConfig),
    createAgentDelivery: ({ target }) =>
      createOpenClawCrablineAgentDelivery({
        manifest: server.manifest,
        target,
      }),
    createInbound: ({ input }) =>
      createOpenClawCrablineInbound({
        input,
        manifest: server.manifest,
      }),
    createOutboundFromRecorderEvent: ({ event, targetByProviderTarget }) =>
      createOpenClawCrablineOutboundFromRecorderEvent({
        event,
        manifest: server.manifest,
        targetByProviderTarget,
      }),
    manifest: server.manifest,
    probe: () => probeOpenClawCrablineFakeProvider(server.manifest),
  };
}

export async function runOpenClawCrablineChannelDriverSmoke(params: {
  outputDir: string;
  selection: OpenClawCrablineChannelDriverSelection;
}): Promise<OpenClawCrablineChannelDriverSmokeResult> {
  const manifestPath = path.join(params.outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH);
  const recorderPath = path.join(
    params.outputDir,
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
    await fs.writeFile(manifestPath, `${JSON.stringify(adapter.manifest, null, 2)}\n`, "utf8");
    const probe = await adapter.probe();
    return {
      capabilityReport: {
        result: {
          driver: "crabline",
          selectedChannel: params.selection.channel,
          supportedChannels: [...CRABLINE_FAKE_PROVIDER_CHANNELS],
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
          recorderPath: path.relative(params.outputDir, adapter.manifest.recorderPath),
        },
      },
    };
  } finally {
    await adapter.close();
  }
}

export function createOpenClawCrablineChannelReportNotes(
  selection: OpenClawCrablineChannelDriverSelection | null | undefined,
): string[] {
  if (!selection) {
    return [];
  }

  return [
    `Channel driver: ${selection.channelDriver} fake provider for ${selection.channel}.`,
    `Channel capability report: ${selection.capabilityMatrixPath}.`,
    `Channel driver smoke: ${selection.smokeArtifactPath}.`,
    "Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.",
  ];
}
