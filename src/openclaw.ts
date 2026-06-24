import {
  CRABLINE_FAKE_PROVIDER_CHANNELS,
  isCrablineFakeProviderChannel,
  startCrablineFakeProviderServer,
  type CrablineFakeProviderChannel,
  type CrablineFakeProviderManifest,
  type StartedCrablineFakeProviderServer,
} from "./fake-servers/index.js";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ACCOUNT_ID = "default";
const TELEGRAM_DIRECT_CHAT_ID = "100001";
const TELEGRAM_GROUP_CHAT_ID = "-1001234567890";
const TELEGRAM_DEFAULT_SENDER_ID = 100001;
const WHATSAPP_JID_RE =
  /^(?:\d{7,15}(?::\d+)?@s\.whatsapp\.net|\d{7,15}@c\.us|\d{5,}@g\.us|\d{7,15}@lid)$/iu;
export const OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH =
  "crabline-fake-provider-capabilities.json";
export const OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-fake-provider-smoke.json";
export const OPENCLAW_CRABLINE_MANIFEST_PATH = "crabline-fake-provider-server.json";
export const OPENCLAW_CRABLINE_DEFAULT_CHANNEL = "telegram";

export type OpenClawCrablineChannelDriverSelection = {
  channel: CrablineFakeProviderChannel;
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
  channel: CrablineFakeProviderChannel;
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
  manifest: CrablineFakeProviderManifest;
  probe(): Promise<unknown>;
};

type RecorderEvent = {
  body?: Record<string, unknown>;
  path?: string;
  type?: string;
};

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInteger(value: unknown): number | undefined {
  const stringValue = readString(value);
  if (!stringValue || !/^-?\d+$/u.test(stringValue)) {
    return undefined;
  }
  return Number(stringValue);
}

function parseQaTarget(target: string): {
  kind: "direct" | "group";
  id: string;
  threadId?: string;
} {
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

function normalizeTelegramChatId(kind: "direct" | "group", id: string) {
  return /^-?\d+$/u.test(id.trim())
    ? id.trim()
    : kind === "group"
      ? TELEGRAM_GROUP_CHAT_ID
      : TELEGRAM_DIRECT_CHAT_ID;
}

function telegramTargetKey(chatId: string, threadId?: number) {
  return threadId === undefined ? chatId : `${chatId}:topic:${threadId}`;
}

function qaTargetForInbound(input: OpenClawCrablineInboundInput) {
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

function requireWhatsAppJid(value: string, label: string): string {
  const trimmed = value.trim();
  if (!WHATSAPP_JID_RE.test(trimmed)) {
    throw new Error(`${label} must be a native WhatsApp JID.`);
  }
  return trimmed;
}

function requireManifestProvider<TProvider extends CrablineFakeProviderManifest["provider"]>(
  manifest: CrablineFakeProviderManifest,
  provider: TProvider,
): Extract<CrablineFakeProviderManifest, { provider: TProvider }> {
  if (manifest.provider !== provider) {
    throw new Error(`Unsupported OpenClaw fake provider binding: ${String(manifest.provider)}`);
  }
  return manifest as Extract<CrablineFakeProviderManifest, { provider: TProvider }>;
}

function createAdminInboundRequest(manifest: CrablineFakeProviderManifest) {
  return {
    providerHeaders: {
      "content-type": "application/json",
      "x-crabline-admin-token": manifest.adminToken,
    },
    providerUrl: manifest.endpoints.adminInboundUrl,
  };
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

type OpenClawCrablineProviderBridge = {
  createAgentDelivery(params: {
    manifest: CrablineFakeProviderManifest;
    parsed: ReturnType<typeof parseQaTarget>;
  }): OpenClawCrablineAgentDelivery;
  createBinding(manifest: CrablineFakeProviderManifest): OpenClawCrablineGatewayBinding;
  createInbound(params: {
    input: OpenClawCrablineInboundInput;
    manifest: CrablineFakeProviderManifest;
  }): OpenClawCrablineInbound;
  createOutboundFromRecorderEvent(params: {
    event: RecorderEvent;
    manifest: CrablineFakeProviderManifest;
    targetByProviderTarget: ReadonlyMap<string, string>;
  }): OpenClawCrablineOutboundMessage | null;
  probe(manifest: CrablineFakeProviderManifest): Promise<unknown>;
};

const OPENCLAW_CRABLINE_PROVIDER_BRIDGES = {
  telegram: {
    async probe(manifest) {
      const telegram = requireManifestProvider(manifest, "telegram");
      const response = await fetch(`${telegram.endpoints.apiRoot}/bot${telegram.botToken}/getMe`);
      if (!response.ok) {
        throw new Error(`Crabline Telegram getMe probe failed with HTTP ${response.status}.`);
      }
      return await response.json();
    },
    createBinding(manifest) {
      const telegram = requireManifestProvider(manifest, "telegram");
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        channel: "telegram",
        createChannelDriverSmokeEnv: (env) => ({
          ...env,
          TELEGRAM_BOT_TOKEN: telegram.botToken,
        }),
        createGatewayConfig: (openclawConfig = {}) => {
          const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
          const telegramConfig = isRecord(channels.telegram) ? channels.telegram : {};
          const groups = isRecord(telegramConfig.groups) ? telegramConfig.groups : {};
          const defaultGroup = isRecord(groups["*"]) ? groups["*"] : {};
          const messages = isRecord(openclawConfig.messages) ? openclawConfig.messages : {};
          const groupChat = isRecord(messages.groupChat) ? messages.groupChat : {};

          return {
            ...openclawConfig,
            channels: {
              ...channels,
              telegram: {
                ...telegramConfig,
                enabled: true,
                botToken: telegram.botToken,
                apiRoot: telegram.endpoints.apiRoot,
                dmPolicy: "open",
                groupPolicy: "open",
                allowFrom: ["*"],
                groupAllowFrom: ["*"],
                groups: {
                  ...groups,
                  "*": {
                    ...defaultGroup,
                    requireMention: false,
                  },
                },
              },
            },
            messages: {
              ...messages,
              groupChat: {
                ...groupChat,
                mentionPatterns: ["\\b@?openclaw\\b"],
                visibleReplies: "automatic",
              },
            },
          };
        },
        requiredPluginIds: ["telegram"],
      };
    },
    createAgentDelivery({ manifest, parsed }) {
      requireManifestProvider(manifest, "telegram");
      const chatId = normalizeTelegramChatId(parsed.kind, parsed.id);
      const threadId = readInteger(parsed.threadId);
      const to = telegramTargetKey(chatId, threadId);
      return {
        channel: "telegram",
        to,
        replyChannel: "telegram",
        replyTo: to,
      };
    },
    createInbound({ input, manifest }) {
      const telegram = requireManifestProvider(manifest, "telegram");
      const kind = input.conversation.kind === "direct" ? "direct" : "group";
      const chatId = normalizeTelegramChatId(kind, input.conversation.id);
      const threadId = readInteger(input.threadId);
      return {
        ...createAdminInboundRequest(telegram),
        providerBody: {
          chatId,
          fromId: readInteger(input.senderId) ?? TELEGRAM_DEFAULT_SENDER_ID,
          fromName: input.senderName ?? input.senderId,
          ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
          text: input.text,
        },
        providerTargetKey: telegramTargetKey(chatId, threadId),
        qaTarget: qaTargetForInbound(input),
        stateConversation: {
          id: chatId,
          kind: kind === "group" ? "group" : "direct",
        },
        ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
      };
    },
    createOutboundFromRecorderEvent({ event, manifest, targetByProviderTarget }) {
      requireManifestProvider(manifest, "telegram");
      if (
        event.type !== "api" ||
        typeof event.path !== "string" ||
        !event.path.endsWith("/sendMessage") ||
        !event.body ||
        typeof event.body !== "object"
      ) {
        return null;
      }
      const chatId = readString(event.body.chat_id);
      const text =
        typeof event.body.text === "string" && event.body.text.trim() ? event.body.text : undefined;
      if (!chatId || !text) {
        return null;
      }
      const threadId = readInteger(event.body.message_thread_id);
      const providerTargetKey = telegramTargetKey(chatId, threadId);
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        senderId: "openclaw",
        senderName: "OpenClaw QA",
        text,
        to:
          targetByProviderTarget.get(providerTargetKey) ??
          (threadId === undefined ? chatId : providerTargetKey),
      };
    },
  },
  whatsapp: {
    async probe(manifest) {
      const whatsapp = requireManifestProvider(manifest, "whatsapp");
      const response = await fetch(`${whatsapp.endpoints.apiRoot}/health`);
      if (!response.ok) {
        throw new Error(`Crabline WhatsApp health probe failed with HTTP ${response.status}.`);
      }
      return await response.json();
    },
    createBinding(manifest) {
      const whatsapp = requireManifestProvider(manifest, "whatsapp");
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        channel: "whatsapp",
        createChannelDriverSmokeEnv: (env) => ({
          ...env,
          CRABLINE_WHATSAPP_ADMIN_TOKEN: whatsapp.adminToken,
          CRABLINE_WHATSAPP_ACCESS_TOKEN: whatsapp.accessToken,
          CRABLINE_WHATSAPP_API_ROOT: whatsapp.endpoints.apiRoot,
          CRABLINE_WHATSAPP_SELF_JID: whatsapp.selfJid,
        }),
        createGatewayConfig: (openclawConfig = {}) => {
          const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
          const whatsappConfig = isRecord(channels.whatsapp) ? channels.whatsapp : {};
          const groups = isRecord(whatsappConfig.groups) ? whatsappConfig.groups : {};
          const defaultGroup = isRecord(groups["*"]) ? groups["*"] : {};

          return {
            ...openclawConfig,
            channels: {
              ...channels,
              whatsapp: {
                ...whatsappConfig,
                enabled: true,
                dmPolicy: "open",
                groupPolicy: "open",
                allowFrom: ["*"],
                groupAllowFrom: ["*"],
                groups: {
                  ...groups,
                  "*": {
                    ...defaultGroup,
                    requireMention: false,
                  },
                },
              },
            },
          };
        },
        requiredPluginIds: ["whatsapp"],
      };
    },
    createAgentDelivery({ manifest, parsed }) {
      requireManifestProvider(manifest, "whatsapp");
      const to = requireWhatsAppJid(parsed.id, "WhatsApp target");
      return {
        channel: "whatsapp",
        to,
        replyChannel: "whatsapp",
        replyTo: to,
      };
    },
    createInbound({ input, manifest }) {
      const whatsapp = requireManifestProvider(manifest, "whatsapp");
      const chatJid = requireWhatsAppJid(input.conversation.id, "WhatsApp conversation");
      const senderJid = requireWhatsAppJid(input.senderId, "WhatsApp sender");
      return {
        ...createAdminInboundRequest(whatsapp),
        providerBody: {
          chatJid,
          senderJid,
          ...(input.senderName ? { pushName: input.senderName } : {}),
          text: input.text,
        },
        providerTargetKey: chatJid,
        qaTarget: qaTargetForInbound(input),
        stateConversation: {
          id: chatJid,
          kind: chatJid.endsWith("@g.us") ? "group" : "direct",
        },
      };
    },
    createOutboundFromRecorderEvent({ event, manifest, targetByProviderTarget }) {
      requireManifestProvider(manifest, "whatsapp");
      if (
        event.type !== "api" ||
        typeof event.path !== "string" ||
        !event.path.endsWith("/crabline/whatsapp/messages") ||
        !event.body ||
        typeof event.body !== "object"
      ) {
        return null;
      }
      const to = readString(event.body.to ?? event.body.jid);
      const textPayload = event.body.text;
      const text =
        textPayload && typeof textPayload === "object"
          ? readString((textPayload as Record<string, unknown>).body)
          : readString(textPayload);
      if (!to || !text) {
        return null;
      }
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        senderId: "openclaw",
        senderName: "OpenClaw QA",
        text,
        to: targetByProviderTarget.get(to) ?? to,
      };
    },
  },
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
  return getOpenClawCrablineProviderBridge(params.manifest).createOutboundFromRecorderEvent({
    event: params.event as RecorderEvent,
    manifest: params.manifest,
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
