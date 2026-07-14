import { isIP } from "node:net";
import { isMatrixEventId } from "../../matrix-ids.js";
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
import { throwProbeHttpError } from "./probe-response.js";

const MAX_MATRIX_IDENTIFIER_BYTES = 255;

function isMatrixIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function isMatrixServerName(value: string): boolean {
  const ipv6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  if (ipv6) {
    return isIP(ipv6[1]!) === 6;
  }
  const hostAndPort = /^([^:]+?)(?::(\d{1,5}))?$/u.exec(value);
  if (!hostAndPort) {
    return false;
  }
  const hostname = hostAndPort[1]!;
  if (isMatrixIpv4Address(hostname)) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) {
    return false;
  }
  return hostname.length <= 255 && /^[A-Za-z0-9.-]+$/u.test(hostname);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isMatrixRoomId(value: string): boolean {
  if (!value.startsWith("!") || Buffer.byteLength(value, "utf8") > MAX_MATRIX_IDENTIFIER_BYTES) {
    return false;
  }
  const separator = value.indexOf(":");
  if (separator >= 2) {
    const localpart = value.slice(1, separator);
    return (
      !localpart.includes("\0") &&
      !hasLoneSurrogate(localpart) &&
      isMatrixServerName(value.slice(separator + 1))
    );
  }
  const opaqueId = value.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(opaqueId)) {
    return false;
  }
  const decoded = Buffer.from(opaqueId, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === opaqueId;
}

function matrixRoomId(value: string): string {
  const trimmed = value.trim();
  if (!isMatrixRoomId(trimmed)) {
    throw new Error("Matrix targets must be native room IDs.");
  }
  return trimmed;
}

function targetKey(roomId: string, threadId?: string): string {
  return threadId ? `${roomId}:thread:${threadId}` : roomId;
}

function matrixThreadId(value: string): string {
  const trimmed = value.trim();
  if (!isMatrixEventId(trimmed)) {
    throw new Error("Matrix thread IDs must be native event IDs.");
  }
  return trimmed;
}

function eventThreadId(content: Record<string, unknown>): string | null | undefined {
  const relation = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : undefined;
  if (relation?.rel_type !== "m.thread") {
    return undefined;
  }
  const eventId = readString(relation.event_id);
  return eventId && isMatrixEventId(eventId) ? eventId : null;
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
          await throwProbeHttpError(
            response,
            `Crabline Matrix probe failed with HTTP ${response.status}.`,
          );
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
                  streaming: {
                    mode: "off",
                    block: { enabled: false },
                  },
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
        const rawThreadId = input.threadId?.trim();
        const threadId = rawThreadId ? matrixThreadId(rawThreadId) : undefined;
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
        if (threadId === null) {
          return null;
        }
        deliveredTransactions.add(transactionKey);
        if (deliveredTransactions.size > MAX_DELIVERED_MATRIX_TRANSACTIONS) {
          deliveredTransactions.delete(deliveredTransactions.values().next().value!);
        }
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          senderId: matrix.botUserId,
          senderName: "OpenClaw QA",
          text,
          to:
            targetByProviderTarget.get(targetKey(roomId, threadId)) ?? targetKey(roomId, threadId),
        };
      },
    };
  },
});
