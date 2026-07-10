import { createHash } from "node:crypto";
import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readString,
} from "../shared.js";

function signalDirectId(id: string): string {
  const value = id.trim();
  if (/^\+?\d{3,}$/u.test(value)) {
    return value.startsWith("+") ? value : `+${value}`;
  }
  const suffix = createHash("sha256").update(value).digest().readUInt32BE() % 10_000_000;
  return `+1555${String(suffix).padStart(7, "0")}`;
}

function signalTarget(kind: "direct" | "group", id: string): string {
  const value = id.trim();
  if (!value) {
    throw new Error("Signal target is required.");
  }
  return kind === "group" ? `group:${value}` : signalDirectId(value);
}

export const SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "signal",
  createAdapter(signal) {
    return {
      async probe() {
        const response = await fetch(`${signal.baseUrl}/api/v1/check`);
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
        const to = signalTarget(parsed.kind, parsed.id);
        return {
          channel: "signal",
          providerTargetKey: to,
          replyChannel: "signal",
          replyTo: to,
          to,
        };
      },
      createInbound(input) {
        const kind = input.conversation.kind === "direct" ? "direct" : "group";
        const conversationId = input.conversation.id.trim();
        const senderId = input.senderId.trim();
        if (!conversationId || !senderId) {
          throw new Error("Signal conversation and sender are required.");
        }
        const sourceNumber = signalDirectId(senderId);
        return {
          ...createAdminInboundRequest(signal),
          providerBody: {
            ...(kind === "group" ? { groupId: conversationId } : {}),
            ...(input.senderName ? { sourceName: input.senderName } : {}),
            sourceNumber,
            text: input.text,
          },
          providerTargetKey: kind === "group" ? `group:${conversationId}` : sourceNumber,
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
        const text = readString(event.body.params.message);
        const groupId = readString(event.body.params.groupId);
        const recipients = event.body.params.recipient;
        const recipient = Array.isArray(recipients) ? readString(recipients[0]) : undefined;
        const target = groupId ? `group:${groupId}` : recipient;
        if (!text || !target) {
          return null;
        }
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
