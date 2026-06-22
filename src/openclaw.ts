import {
  startCrablineFakeProviderServer,
  type CrablineFakeProviderChannel,
  type CrablineFakeProviderManifest,
  type StartedCrablineFakeProviderServer,
} from "./fake-servers/index.js";

const TELEGRAM_ACCOUNT_ID = "default";
const TELEGRAM_DIRECT_CHAT_ID = "100001";
const TELEGRAM_GROUP_CHAT_ID = "-1001234567890";
const TELEGRAM_DEFAULT_SENDER_ID = 100001;

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
  providerTargetKey: string;
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
};

type TelegramRecorderEvent = {
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

function requireTelegramManifest(manifest: CrablineFakeProviderManifest) {
  if (manifest.provider !== "telegram") {
    throw new Error(`Unsupported OpenClaw fake provider binding: ${String(manifest.provider)}`);
  }
  return manifest;
}

export function createOpenClawCrablineFakeProviderBinding(
  manifest: CrablineFakeProviderManifest,
): OpenClawCrablineGatewayBinding {
  const telegram = requireTelegramManifest(manifest);
  return {
    accountId: TELEGRAM_ACCOUNT_ID,
    channel: "telegram",
    createChannelDriverSmokeEnv: (env) => ({
      ...env,
      TELEGRAM_BOT_TOKEN: telegram.botToken,
    }),
    createGatewayConfig: (_openclawConfig = {}) => ({
      channels: {
        telegram: {
          enabled: true,
          botToken: telegram.botToken,
          apiRoot: telegram.endpoints.apiRoot,
          dmPolicy: "open",
          groupPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["*"],
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
      },
    }),
    requiredPluginIds: ["telegram"],
  };
}

export function createOpenClawCrablineAgentDelivery(params: {
  manifest: CrablineFakeProviderManifest;
  target: string;
}): OpenClawCrablineAgentDelivery {
  requireTelegramManifest(params.manifest);
  const parsed = parseQaTarget(params.target);
  const chatId = normalizeTelegramChatId(parsed.kind, parsed.id);
  const threadId = readInteger(parsed.threadId);
  const to = telegramTargetKey(chatId, threadId);
  return {
    channel: "telegram",
    to,
    replyChannel: "telegram",
    replyTo: to,
  };
}

export function createOpenClawCrablineInbound(params: {
  input: OpenClawCrablineInboundInput;
  manifest: CrablineFakeProviderManifest;
}): OpenClawCrablineInbound {
  requireTelegramManifest(params.manifest);
  const kind = params.input.conversation.kind === "direct" ? "direct" : "group";
  const chatId = normalizeTelegramChatId(kind, params.input.conversation.id);
  const threadId = readInteger(params.input.threadId);
  return {
    providerBody: {
      chatId,
      fromId: readInteger(params.input.senderId) ?? TELEGRAM_DEFAULT_SENDER_ID,
      fromName: params.input.senderName ?? params.input.senderId,
      ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
      text: params.input.text,
    },
    providerTargetKey: telegramTargetKey(chatId, threadId),
    qaTarget: qaTargetForInbound(params.input),
    stateConversation: {
      id: chatId,
      kind: kind === "group" ? "group" : "direct",
    },
    ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
  };
}

export function createOpenClawCrablineOutboundFromRecorderEvent(params: {
  event: unknown;
  manifest: CrablineFakeProviderManifest;
  targetByProviderTarget: ReadonlyMap<string, string>;
}): OpenClawCrablineOutboundMessage | null {
  requireTelegramManifest(params.manifest);
  const event = params.event as TelegramRecorderEvent;
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
  const text = readString(event.body.text);
  if (!chatId || !text) {
    return null;
  }
  const threadId = readInteger(event.body.message_thread_id);
  const providerTargetKey = telegramTargetKey(chatId, threadId);
  return {
    accountId: TELEGRAM_ACCOUNT_ID,
    senderId: "openclaw",
    senderName: "OpenClaw QA",
    text,
    to:
      params.targetByProviderTarget.get(providerTargetKey) ??
      (threadId === undefined ? chatId : providerTargetKey),
  };
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
  };
}
