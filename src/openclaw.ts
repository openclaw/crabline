import {
  CRABLINE_FAKE_PROVIDER_CHANNELS,
  isCrablineFakeProviderChannel,
  startCrablineFakeProviderServer,
  type CrablineFakeProviderChannel,
  type CrablineFakeProviderManifest,
  type StartedCrablineFakeProviderServer,
} from "./servers/index.js";
import { SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/slack.js";
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
  type OpenClawCrablineProviderAdapter,
  type OpenClawCrablineProviderBridge,
  type OpenClawCrablineProviderBridgeRegistry,
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
  slack: SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  telegram: TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  whatsapp: WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
} satisfies OpenClawCrablineProviderBridgeRegistry;

const OPENCLAW_CRABLINE_PROVIDER_BRIDGE_LIST = Object.values(
  OPENCLAW_CRABLINE_PROVIDER_BRIDGES,
) as readonly OpenClawCrablineProviderBridge[];

function createOpenClawCrablineProviderAdapter(
  manifest: CrablineFakeProviderManifest,
): OpenClawCrablineProviderAdapter {
  const bridge = OPENCLAW_CRABLINE_PROVIDER_BRIDGE_LIST.find(
    (candidate) => candidate.provider === manifest.provider,
  );
  if (bridge) {
    return bridge.createAdapterFromManifest(manifest);
  }
  throw new Error("Unsupported OpenClaw fake provider binding.");
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
  return await createOpenClawCrablineProviderAdapter(manifest).probe();
}

export function createOpenClawCrablineFakeProviderBinding(
  manifest: CrablineFakeProviderManifest,
): OpenClawCrablineGatewayBinding {
  return createOpenClawCrablineProviderAdapter(manifest).createBinding();
}

export function createOpenClawCrablineAgentDelivery(params: {
  manifest: CrablineFakeProviderManifest;
  target: string;
}): OpenClawCrablineAgentDelivery {
  return createOpenClawCrablineProviderAdapter(params.manifest).createAgentDelivery(
    parseQaTarget(params.target),
  );
}

export function createOpenClawCrablineInbound(params: {
  input: OpenClawCrablineInboundInput;
  manifest: CrablineFakeProviderManifest;
}): OpenClawCrablineInbound {
  return createOpenClawCrablineProviderAdapter(params.manifest).createInbound(params.input);
}

export function createOpenClawCrablineOutboundFromRecorderEvent(params: {
  event: unknown;
  manifest: CrablineFakeProviderManifest;
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
  const server: StartedCrablineFakeProviderServer = await startCrablineFakeProviderServer({
    channel: params.channel,
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
