import { createHash } from "node:crypto";
import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";

const SIGNAL_UUID_RE =
  /^(?:uuid:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

type SignalDirectIdentity =
  | { recipient: string; sourceNumber: string }
  | { recipient: string; sourceUuid: string };

function deterministicSignalUuid(value: string): string {
  const bytes = createHash("sha256")
    .update("crabline:signal:direct\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function signalDirectIdentity(id: string): SignalDirectIdentity {
  const value = id.trim();
  if (/^\+?[1-9]\d{2,14}$/u.test(value)) {
    const sourceNumber = value.startsWith("+") ? value : `+${value}`;
    return { recipient: sourceNumber, sourceNumber };
  }
  const sourceUuid =
    SIGNAL_UUID_RE.exec(value)?.[1]?.toLowerCase() ?? deterministicSignalUuid(value);
  return { recipient: sourceUuid, sourceUuid };
}

function signalRecipientValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(readString).filter((entry): entry is string => entry !== undefined);
}

function signalOutboundTargets(params: Record<string, unknown>, account: string): string[] {
  const targets = [
    ...signalRecipientValues(params.groupId).map((id) => `group:${id}`),
    ...signalRecipientValues(params.groupIds).map((id) => `group:${id}`),
    ...signalRecipientValues(params.recipient),
    ...signalRecipientValues(params.recipients),
    ...signalRecipientValues(params.username),
    ...signalRecipientValues(params.usernames),
    ...(params.noteToSelf === true ? [account] : []),
  ];
  return [...new Set(targets)];
}

function signalTarget(kind: "direct" | "group", id: string): string {
  const value = id.trim();
  if (!value) {
    throw new Error("Signal target is required.");
  }
  return kind === "group" ? `group:${value}` : signalDirectIdentity(value).recipient;
}

export const SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "signal",
  createAdapter(signal) {
    return {
      async probe(abortSignal) {
        const response = await fetch(`${signal.baseUrl}/api/v1/check`, {
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!response.ok) {
          throw new Error(`Crabline Signal check probe failed with HTTP ${response.status}.`);
        }
        return { ok: true, status: response.status };
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "signal",
          createChannelDriverSmokeEnv: (env) => env,
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const signalConfig = isRecord(channels.signal) ? channels.signal : {};
            return {
              ...openclawConfig,
              channels: {
                ...channels,
                signal: {
                  ...signalConfig,
                  account: signal.account,
                  allowFrom: ["*"],
                  apiMode: "native",
                  autoStart: false,
                  dmPolicy: "open",
                  enabled: true,
                  groupAllowFrom: ["*"],
                  groupPolicy: "open",
                  httpUrl: signal.baseUrl,
                },
              },
            };
          },
          requiredPluginIds: ["signal"],
        };
      },
      createAgentDelivery(parsed) {
        if (parsed.threadId !== undefined) {
          throw new Error("Signal does not support thread targets.");
        }
        const to = signalTarget(parsed.kind, parsed.id);
        return { channel: "signal", replyChannel: "signal", replyTo: to, to };
      },
      createInbound(input) {
        if (input.threadId !== undefined) {
          throw new Error("Signal does not support thread targets.");
        }
        const kind = input.conversation.kind === "direct" ? "direct" : "group";
        const conversationId = input.conversation.id.trim();
        const senderId = input.senderId.trim();
        if (!conversationId || !senderId) {
          throw new Error("Signal conversation and sender are required.");
        }
        const senderIdentity = signalDirectIdentity(senderId);
        if (
          kind === "direct" &&
          signalDirectIdentity(conversationId).recipient !== senderIdentity.recipient
        ) {
          throw new Error(
            "Signal direct conversation and sender must identify the same recipient.",
          );
        }
        return {
          ...createAdminInboundRequest(signal),
          providerBody: {
            ...(kind === "group" ? { groupId: conversationId } : {}),
            ...(input.senderName ? { sourceName: input.senderName } : {}),
            ...("sourceNumber" in senderIdentity
              ? { sourceNumber: senderIdentity.sourceNumber }
              : { sourceUuid: senderIdentity.sourceUuid }),
            text: input.text,
          },
          providerTargetKey:
            kind === "group" ? `group:${conversationId}` : senderIdentity.recipient,
          qaTarget: qaTargetForInbound(input),
          stateConversation: { id: conversationId, kind },
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (
          !isRecord(event) ||
          event.type !== "api" ||
          event.path !== "/api/v1/rpc" ||
          !isRecord(event.body) ||
          event.body.method !== "send" ||
          !isRecord(event.body.params)
        ) {
          return null;
        }
        const text = readNonBlankString(event.body.params.message);
        const targets = signalOutboundTargets(event.body.params, signal.account);
        if (!text || targets.length !== 1) {
          return null;
        }
        const target = targets[0]!;
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: "openclaw",
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(target) ?? target,
        };
      },
    };
  },
});
