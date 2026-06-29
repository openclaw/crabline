import { ADMIN_TOKEN_HEADER } from "../servers/http.js";
import type { CrablineServerChannel, CrablineServerManifest } from "../servers/index.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH =
  "crabline-fake-provider-capabilities.json";
export const OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-fake-provider-smoke.json";
export const OPENCLAW_CRABLINE_MANIFEST_PATH = "crabline-fake-provider-server.json";
export const OPENCLAW_CRABLINE_DEFAULT_CHANNEL = "telegram";

export type OpenClawCrablineChannelDriverSelection = {
  channel: CrablineServerChannel;
  channelDriver: "crabline";
  capabilityMatrixPath: typeof OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
  smokeArtifactPath: typeof OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH;
};

export type OpenClawCrablineChannelDriverSmokeResult = {
  capabilityReport: unknown;
  manifestPath: string;
  smoke: unknown;
};

export type OpenClawCrablineConversation = {
  id: string;
  kind: "direct" | "group";
};

export type OpenClawCrablineGatewayBinding = {
  accountId: string;
  channel: string;
  createChannelDriverSmokeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  createGatewayConfig(openclawConfig?: Record<string, unknown>): Record<string, unknown>;
  requiredPluginIds: string[];
};

export type OpenClawCrablineAgentDelivery = {
  channel: string;
  replyChannel: string;
  replyTo: string;
  to: string;
};

export type OpenClawCrablineInboundInput = {
  conversation: {
    id: string;
    kind: string;
  };
  senderId: string;
  senderName?: string | undefined;
  text: string;
  threadId?: string | undefined;
};

export type OpenClawCrablineInbound = {
  providerBody: Record<string, unknown>;
  providerHeaders: Record<string, string>;
  providerTargetKey: string;
  providerUrl: string;
  qaTarget: string;
  stateConversation: OpenClawCrablineConversation;
  threadId?: string | undefined;
};

export type OpenClawCrablineOutboundMessage = {
  accountId: string;
  senderId: string;
  senderName: string;
  text: string;
  to: string;
};

export type StartOpenClawCrablineAdapterParams = {
  channel: CrablineServerChannel;
  openclawConfig?: Record<string, unknown> | undefined;
  recorderPath?: string | undefined;
};

export type StartedOpenClawCrablineAdapter = OpenClawCrablineGatewayBinding & {
  close(): Promise<void>;
  createAgentDelivery(params: { target: string }): OpenClawCrablineAgentDelivery;
  createInbound(params: { input: OpenClawCrablineInboundInput }): OpenClawCrablineInbound;
  createOutboundFromRecorderEvent(params: {
    event: unknown;
    targetByProviderTarget: ReadonlyMap<string, string>;
  }): OpenClawCrablineOutboundMessage | null;
  manifest: CrablineServerManifest;
  probe(): Promise<unknown>;
};

export type ParsedQaTarget = {
  kind: "direct" | "group";
  id: string;
  threadId?: string;
};

export type OpenClawCrablineProviderAdapter = {
  createAgentDelivery(parsed: ParsedQaTarget): OpenClawCrablineAgentDelivery;
  createBinding(): OpenClawCrablineGatewayBinding;
  createInbound(input: OpenClawCrablineInboundInput): OpenClawCrablineInbound;
  createOutboundFromRecorderEvent(params: {
    event: unknown;
    targetByProviderTarget: ReadonlyMap<string, string>;
  }): OpenClawCrablineOutboundMessage | null;
  probe(): Promise<unknown>;
};

export type OpenClawCrablineProviderBridge<
  TManifest extends CrablineServerManifest = CrablineServerManifest,
> = {
  createAdapter(manifest: TManifest): OpenClawCrablineProviderAdapter;
  createAdapterFromManifest(manifest: CrablineServerManifest): OpenClawCrablineProviderAdapter;
  provider: TManifest["provider"];
};

export type OpenClawCrablineProviderBridgeRegistry = {
  [Provider in CrablineServerManifest["provider"]]: OpenClawCrablineProviderBridge<
    Extract<CrablineServerManifest, { provider: Provider }>
  >;
};

export function createOpenClawCrablineProviderBridge<
  TProvider extends CrablineServerManifest["provider"],
>(params: {
  createAdapter(
    manifest: Extract<CrablineServerManifest, { provider: TProvider }>,
  ): OpenClawCrablineProviderAdapter;
  provider: TProvider;
}): OpenClawCrablineProviderBridge<Extract<CrablineServerManifest, { provider: TProvider }>> {
  type ProviderManifest = Extract<CrablineServerManifest, { provider: TProvider }>;
  const bridge: OpenClawCrablineProviderBridge<ProviderManifest> = {
    createAdapter: params.createAdapter,
    createAdapterFromManifest(manifest) {
      if (manifest.provider !== params.provider) {
        throw new Error(
          `Unsupported OpenClaw provider binding: expected ${params.provider}, got ${manifest.provider}.`,
        );
      }
      return params.createAdapter(manifest as ProviderManifest);
    },
    provider: params.provider as ProviderManifest["provider"],
  };
  return bridge;
}

export function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readInteger(value: unknown): number | undefined {
  const stringValue = readString(value);
  if (!stringValue || !/^-?\d+$/u.test(stringValue)) {
    return undefined;
  }
  return Number(stringValue);
}

export function parseQaTarget(target: string): ParsedQaTarget {
  const trimmed = target.trim();
  if (trimmed.startsWith("thread:")) {
    const rest = trimmed.slice("thread:".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      return { kind: "group", id: rest.slice(0, slash), threadId: rest.slice(slash + 1) };
    }
  }
  if (trimmed.startsWith("channel:")) {
    return { kind: "group", id: trimmed.slice("channel:".length) };
  }
  if (trimmed.startsWith("group:")) {
    return { kind: "group", id: trimmed.slice("group:".length) };
  }
  if (trimmed.startsWith("dm:")) {
    return { kind: "direct", id: trimmed.slice("dm:".length) };
  }
  return { kind: "direct", id: trimmed };
}

export function qaTargetForInbound(input: OpenClawCrablineInboundInput) {
  const prefix =
    input.conversation.kind === "direct"
      ? "dm"
      : input.conversation.kind === "channel"
        ? "channel"
        : "group";
  return input.threadId
    ? `thread:${input.conversation.id}/${input.threadId}`
    : `${prefix}:${input.conversation.id}`;
}

export function createAdminInboundRequest(manifest: CrablineServerManifest) {
  return {
    providerHeaders: {
      "content-type": "application/json",
      [ADMIN_TOKEN_HEADER]: manifest.adminToken,
    },
    providerUrl: manifest.endpoints.adminInboundUrl,
  };
}
