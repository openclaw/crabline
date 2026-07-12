import {
  canonicalConversationIdForInbound,
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readNonBlankString,
  readString,
} from "../shared.js";

function matrixRoomId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("!") || !trimmed.includes(":")) {
    throw new Error("Matrix targets must be native room IDs.");
  }
  return trimmed;
}

function targetKey(roomId: string, threadId?: string): string {
  return threadId ? `${roomId}:thread:${threadId}` : roomId;
}

function eventThreadId(content: Record<string, unknown>): string | undefined {
  const relation = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : undefined;
  return relation?.rel_type === "m.thread" ? readString(relation.event_id) : undefined;
}

const MAX_DELIVERED_MATRIX_TRANSACTIONS = 1_000;

export const MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "matrix",
  createAdapter(matrix) {
    const deliveredTransactions = new Set<string>();
    return {
      async probe(signal) {
        const response = await fetch(`${matrix.endpoints.clientApiRoot}/account/whoami`, {
          headers: { authorization: `Bearer ${matrix.accessToken}` },
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          throw new Error(`Crabline Matrix probe failed with HTTP ${response.status}.`);
        }
        const payload: unknown = await response.json();
        if (!isRecord(payload) || readString(payload.user_id) !== matrix.botUserId) {
          throw new Error("Crabline Matrix whoami probe returned an unexpected user.");
        }
        return payload;
      },
      createBinding() {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          channel: "matrix",
          createChannelDriverSmokeEnv: (env) => ({ ...env, ...matrix.env }),
          createGatewayConfig: (openclawConfig = {}) => {
            const channels = isRecord(openclawConfig.channels) ? openclawConfig.channels : {};
            const matrixConfig = isRecord(channels.matrix) ? channels.matrix : {};
            const dmConfig = isRecord(matrixConfig.dm) ? matrixConfig.dm : {};
            return {
              ...openclawConfig,
              channels: {
                ...channels,
                matrix: {
                  ...matrixConfig,
                  accessToken: matrix.accessToken,
                  blockStreaming: false,
                  dm: {
                    ...dmConfig,
                    allowFrom: ["*"],
                    policy: "open",
                  },
                  enabled: true,
                  encryption: false,
                  groupAllowFrom: ["*"],
                  groupPolicy: "open",
                  homeserver: matrix.baseUrl,
                  network: { dangerouslyAllowPrivateNetwork: true },
                  streaming: "off",
                  userId: matrix.botUserId,
                },
              },
            };
          },
          requiredPluginIds: ["matrix"],
        };
      },
      createAgentDelivery(parsed) {
        if (parsed.threadId) {
          throw new Error("Matrix thread targets require OpenClaw QA thread forwarding.");
        }
        const roomId = matrixRoomId(parsed.id);
        const to = `room:${roomId}`;
        return {
          channel: "matrix",
          replyChannel: "matrix",
          replyTo: to,
          to,
        };
      },
      createInbound(input) {
        const roomId = matrixRoomId(canonicalConversationIdForInbound(input));
        const threadId = input.threadId?.trim() || undefined;
        const direct = input.conversation.kind === "direct";
        return {
          ...createAdminInboundRequest(matrix),
          providerBody: {
            roomId,
            direct,
            senderId: input.senderId,
            ...(input.senderName ? { senderName: input.senderName } : {}),
            text: input.text,
            ...(threadId ? { threadId } : {}),
          },
          providerTargetKey: targetKey(roomId, threadId),
          qaTarget: qaTargetForInbound(input),
          stateConversation: {
            id: roomId,
            kind: direct ? "direct" : "group",
          },
          ...(threadId ? { threadId } : {}),
        };
      },
      createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
        if (
          !isRecord(event) ||
          event.type !== "api" ||
          event.method !== "PUT" ||
          event.replayed === true ||
          !isRecord(event.body)
        ) {
          return null;
        }
        const match =
          /^\/_matrix\/client\/(?:v3|r0)\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/u.exec(
            readString(event.path) ?? "",
          );
        if (!match) {
          return null;
        }
        let roomId: string;
        let eventType: string;
        let transactionId: string;
        try {
          roomId = decodeURIComponent(match[1]!);
          eventType = decodeURIComponent(match[2]!);
          transactionId = decodeURIComponent(match[3]!);
        } catch {
          return null;
        }
        if (eventType !== "m.room.message") {
          return null;
        }
        const text = readNonBlankString(event.body.body);
        if (!text) {
          return null;
        }
        const transactionKey = JSON.stringify([roomId, eventType, transactionId]);
        if (deliveredTransactions.has(transactionKey)) {
          return null;
        }
        const threadId = eventThreadId(event.body);
        deliveredTransactions.add(transactionKey);
        if (deliveredTransactions.size > MAX_DELIVERED_MATRIX_TRANSACTIONS) {
          deliveredTransactions.delete(deliveredTransactions.values().next().value!);
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: matrix.botUserId,
          senderName: "OpenClaw QA",
          text,
          to: targetByProviderTarget.get(targetKey(roomId, threadId)) ?? roomId,
        };
      },
    };
  },
});
