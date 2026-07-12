import { ADMIN_TOKEN_HEADER } from "../servers/http.js";
import type { CrablineServerChannel, CrablineServerManifest } from "../servers/index.js";
import type { ServerEventObserver } from "../servers/recorder.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH =
  "crabline-fake-provider-capabilities.json";
export const OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-fake-provider-smoke.json";
export const OPENCLAW_CRABLINE_MANIFEST_PATH = "crabline-fake-provider-server.json";
export const OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY = ".crabline-smoke-artifacts";
export const OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH = `${OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY}/current.json`;
export const OPENCLAW_CRABLINE_DEFAULT_CHANNEL = "telegram";

const OPENCLAW_CRABLINE_PROVIDER_PROBE_TIMEOUT_MS = 5_000;
const OPENCLAW_CRABLINE_PROVIDER_PROBE_LABELS = {
  mattermost: "Mattermost users.me",
  matrix: "Matrix whoami",
  signal: "Signal check",
  slack: "Slack auth.test",
  telegram: "Telegram getMe",
  whatsapp: "WhatsApp phone number",
  zalo: "Zalo getMe",
} satisfies Record<CrablineServerManifest["provider"], string>;

export type OpenClawCrablineChannelDriverSelection = {
  channel: CrablineServerChannel;
  channelDriver: "crabline";
  capabilityMatrixPath: typeof OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
  smokeArtifactPath: typeof OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH;
};

export type OpenClawCrablineChannelDriverSmokeResult = {
  artifactPointerPath: string;
  capabilityReport: unknown;
  capabilityMatrixPath: string;
  generation: string;
  manifestPath: string;
  smoke: unknown;
  smokeArtifactPath: string;
  warnings?: string[];
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
  nativeCommand?: { name: string } | undefined;
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
  onEvent?: ServerEventObserver | undefined;
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
  native: boolean;
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
  probe(signal?: AbortSignal): Promise<unknown>;
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
  const createAdapter = (manifest: ProviderManifest): OpenClawCrablineProviderAdapter => {
    const adapter = params.createAdapter(manifest);
    return {
      ...adapter,
      createInbound(input) {
        if (!readNonBlankString(input.text)) {
          throw new Error("OpenClaw Crabline inbound message text is required.");
        }
        return adapter.createInbound(input);
      },
    };
  };
  const bridge: OpenClawCrablineProviderBridge<ProviderManifest> = {
    createAdapter,
    createAdapterFromManifest(manifest) {
      if (manifest.provider !== params.provider) {
        throw new Error(
          `Unsupported OpenClaw provider binding: expected ${params.provider}, got ${manifest.provider}.`,
        );
      }
      return createAdapter(manifest as ProviderManifest);
    },
    provider: params.provider as ProviderManifest["provider"],
  };
  return bridge;
}

export async function runOpenClawCrablineProviderProbe<T>(
  provider: CrablineServerManifest["provider"],
  probe: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(OPENCLAW_CRABLINE_PROVIDER_PROBE_TIMEOUT_MS);
  const timeoutError = (cause: unknown) =>
    new Error(
      `Crabline ${OPENCLAW_CRABLINE_PROVIDER_PROBE_LABELS[provider]} probe timed out after ${OPENCLAW_CRABLINE_PROVIDER_PROBE_TIMEOUT_MS} ms.`,
      { cause },
    );
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    onAbort = () => reject(timeoutError(signal.reason));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const probeResult = Promise.resolve()
    .then(() => probe(signal))
    .catch((error: unknown) => {
      if (signal.aborted) {
        throw timeoutError(error);
      }
      throw error;
    });
  try {
    return await Promise.race([probeResult, timeout]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
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

export function readNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
  const invalidTarget = () => {
    throw new Error(
      "OpenClaw Crabline target must be a non-blank native id or a valid dm:<id>, group:<id>, channel:<id>, or thread:<id>/<thread-id> target.",
    );
  };
  if (!trimmed) {
    return invalidTarget();
  }
  if (trimmed.startsWith("thread:")) {
    const rest = trimmed.slice("thread:".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash !== rest.lastIndexOf("/")) {
      return invalidTarget();
    }
    const id = rest.slice(0, slash).trim();
    const threadId = rest.slice(slash + 1).trim();
    if (!id || !threadId) {
      return invalidTarget();
    }
    return { kind: "group", id, native: false, threadId };
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    return id ? { kind: "group", id, native: false } : invalidTarget();
  }
  if (trimmed.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? { kind: "group", id, native: false } : invalidTarget();
  }
  if (trimmed.startsWith("dm:")) {
    const id = trimmed.slice("dm:".length).trim();
    return id ? { kind: "direct", id, native: false } : invalidTarget();
  }
  if (/^(?:dm|group|channel|thread)(?=\s*:|$)/iu.test(trimmed)) {
    return invalidTarget();
  }
  return { kind: "direct", id: trimmed, native: true };
}

export function canonicalConversationIdForInbound(input: OpenClawCrablineInboundInput) {
  return input.conversation.id.trim();
}

export function qaTargetForInbound(input: OpenClawCrablineInboundInput) {
  const conversationId = canonicalConversationIdForInbound(input);
  const threadId = input.threadId?.trim();
  const prefix =
    input.conversation.kind === "direct"
      ? "dm"
      : input.conversation.kind === "channel"
        ? "channel"
        : "group";
  return threadId ? `thread:${conversationId}/${threadId}` : `${prefix}:${conversationId}`;
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
