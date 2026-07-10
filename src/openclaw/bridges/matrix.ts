import { createHash } from "node:crypto";
import {
  createAdminInboundRequest,
  createOpenClawCrablineProviderBridge,
  DEFAULT_ACCOUNT_ID,
  isRecord,
  qaTargetForInbound,
  readString,
} from "../shared.js";

function matrixServerName(botUserId: string): string {
  const separator = botUserId.lastIndexOf(":");
  if (separator <= 1 || separator === botUserId.length - 1) {
    throw new Error("Crabline Matrix bot user id must include a server name.");
  }
  return botUserId.slice(separator + 1);
}

function matrixRoomId(value: string, botUserId: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("!") && trimmed.includes(":")) {
    return trimmed;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `!${digest}:${matrixServerName(botUserId)}`;
}

function matrixUserId(value: string, botUserId: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("@") && trimmed.includes(":")) {
    return trimmed;
  }
  const normalized = trimmed.toLowerCase();
  const localpart = /^[a-z0-9._=/-]+$/u.test(normalized)
    ? normalized
    : createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `@${localpart}:${matrixServerName(botUserId)}`;
}

function targetKey(roomId: string, threadId?: string): string {
  return threadId ? `${roomId}:thread:${threadId}` : roomId;
}

function eventThreadId(content: Record<string, unknown>): string | undefined {
  const relation = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : undefined;
  return relation?.rel_type === "m.thread" ? readString(relation.event_id) : undefined;
}

export const MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE = createOpenClawCrablineProviderBridge({
  provider: "matrix",
  createAdapter(matrix) {
    return {
      async probe() {
        const response = await fetch(`${matrix.endpoints.clientApiRoot}/account/whoami`, {
          headers: { authorization: `Bearer ${matrix.accessToken}` },
        });
        if (!response.ok) {
          throw new Error(`Crabline Matrix probe failed with HTTP ${response.status}.`);
        }
        return await response.json();
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
        const roomId = matrixRoomId(parsed.id, matrix.botUserId);
        const to = `room:${roomId}`;
        return {
          channel: "matrix",
          providerTargetKey: roomId,
          replyChannel: "matrix",
          replyTo: to,
          to,
        };
      },
      createInbound(input) {
        const roomId = matrixRoomId(input.conversation.id, matrix.botUserId);
        const threadId = input.threadId?.trim() || undefined;
        const direct = input.conversation.kind === "direct";
        return {
          ...createAdminInboundRequest(matrix),
          providerBody: {
            roomId,
            direct,
            senderId: matrixUserId(input.senderId, matrix.botUserId),
            ...(input.senderName ? { senderName: input.senderName } : {}),
            text: input.text.replace(/@openclaw(?!:)/gu, matrix.botUserId),
            ...(threadId ? { threadId } : {}),
          },
          providerTargetKey: targetKey(roomId, threadId),
          qaTarget: qaTargetForInbound(input),
          stateConversation: {
            id: input.conversation.id,
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
          !isRecord(event.body)
        ) {
          return null;
        }
        const match = /^\/_matrix\/client\/(?:v3|r0)\/rooms\/([^/]+)\/send\/([^/]+)\/[^/]+$/u.exec(
          readString(event.path) ?? "",
        );
        if (!match) {
          return null;
        }
        const roomId = decodeURIComponent(match[1]!);
        const eventType = decodeURIComponent(match[2]!);
        if (eventType !== "m.room.message") {
          return null;
        }
        const text = readString(event.body.body);
        if (!text) {
          return null;
        }
        const threadId = eventThreadId(event.body);
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
