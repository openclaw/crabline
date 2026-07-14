import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { isMatrixEventId, isMatrixRoomId } from "../../matrix-ids.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  getBuiltinTargetCodec,
  MATRIX_EVENT_ID_RULE,
  MATRIX_ROOM_ID_RULE,
} from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

export function resolveMatrixAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const fallbackUserId = env.MATRIX_USER_ID?.trim() || `@${userName}:matrix.local`;
  const configuredAuth = config.matrix?.auth
    ? {
        ...config.matrix.auth,
        userID: config.matrix.auth.userID?.trim() || fallbackUserId,
      }
    : undefined;
  return {
    auth: configuredAuth ?? {
      accessToken: env.MATRIX_ACCESS_TOKEN ?? "local-mock-matrix-token",
      type: "accessToken" as const,
      userID: fallbackUserId,
    },
    baseURL: config.matrix?.baseURL ?? env.MATRIX_BASE_URL ?? "http://matrix.local",
    commandPrefix: config.matrix?.commandPrefix,
    recoveryKey: config.matrix?.recoveryKey ?? env.MATRIX_RECOVERY_KEY,
  };
}

export class MatrixProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, userName: string, _runtime?: unknown) {
    const resolvedConfig = resolveMatrixAdapterConfig(config, userName);
    const botUserId = resolvedConfig.auth.userID;
    requireExternalWebhookAuthentication({
      authenticated: false,
      provider: "Matrix",
      requirement:
        "a provider-native authenticated ingress mode, which this adapter does not support",
      webhook: config.matrix?.webhook,
    });
    super({
      codec: getBuiltinTargetCodec("matrix"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/matrix/webhook", port: 8797 },
        endpointLabel: "webhook endpoint",
        matchesThread: matchesMatrixThread,
        normalizeWebhookPayload: (payload) => normalizeMatrixWebhookPayload(payload, botUserId),
        platform: "matrix",
        publicUrl: config.matrix?.webhook.publicUrl,
        recorderPath: config.matrix?.recorder.path
          ? path.resolve(config.matrix.recorder.path)
          : undefined,
        webhook: config.matrix?.webhook,
      },
    });
  }
}

function matrixThreadKey(roomId: string, threadId: string): string {
  return `${roomId}:thread:${threadId}`;
}

export function matchesMatrixThread(
  candidateThreadId: string,
  expectedThreadId: string | undefined,
  target: { channelId?: string | undefined },
): boolean {
  if (!expectedThreadId) {
    return true;
  }
  if (target.channelId && isMatrixEventId(expectedThreadId)) {
    return candidateThreadId === matrixThreadKey(target.channelId, expectedThreadId);
  }
  return (
    candidateThreadId === expectedThreadId ||
    (isMatrixRoomId(expectedThreadId) &&
      candidateThreadId.startsWith(`${expectedThreadId}:thread:`))
  );
}

export function normalizeMatrixWebhookPayload(payload: unknown, botUserId?: string) {
  if (!isRecord(payload)) {
    throw new CrablineError("Matrix webhook payload must be an object", { kind: "inbound" });
  }

  const message = optionalRecord(payload, "message");
  if (
    (message && ("text" in message || "threadId" in message)) ||
    "text" in payload ||
    "threadId" in payload
  ) {
    const normalized = genericMockPayloadWithNativeThread({
      channelRule: MATRIX_ROOM_ID_RULE,
      payload,
      threadRule: MATRIX_EVENT_ID_RULE,
    });
    const threadId =
      (message ? optionalString(message, "threadId") : undefined) ??
      optionalString(payload, "threadId");
    const roomId =
      (message ? optionalString(message, "channelId") : undefined) ??
      optionalString(payload, "channelId") ??
      optionalString(payload, "roomId") ??
      optionalString(payload, "room_id");
    if (
      "threadId" in normalized &&
      !isMatrixRoomId(normalized.threadId) &&
      !isMatrixEventId(normalized.threadId)
    ) {
      throw new CrablineError(
        `mock webhook threadId must be a native ${MATRIX_EVENT_ID_RULE.name} or ${MATRIX_ROOM_ID_RULE.name}.`,
        { kind: "inbound" },
      );
    }
    if (threadId && isMatrixEventId(threadId)) {
      if (!roomId || !isMatrixRoomId(roomId)) {
        throw new CrablineError(
          `Matrix generic event threadId requires a native ${MATRIX_ROOM_ID_RULE.name} channelId.`,
          { kind: "inbound" },
        );
      }
      const scopedThreadId = matrixThreadKey(roomId, threadId);
      return {
        ...normalized,
        ...("message" in normalized && isRecord(normalized.message)
          ? { message: { ...normalized.message, threadId: scopedThreadId } }
          : {}),
        threadId: scopedThreadId,
      };
    }
    if (threadId && isMatrixRoomId(threadId) && roomId && roomId !== threadId) {
      throw new CrablineError("Matrix generic room threadId must match channelId.", {
        kind: "inbound",
      });
    }
    return normalized;
  }

  const content = optionalRecord(payload, "content");
  const roomId = optionalString(payload, "room_id");
  const eventId = optionalString(payload, "event_id");
  const eventType = optionalString(payload, "type");
  const senderId = optionalString(payload, "sender");
  const msgtype = content?.msgtype;
  const text = content?.body;
  if (eventType !== "m.room.message") {
    throw new CrablineError("Matrix event payload requires type=m.room.message", {
      kind: "inbound",
    });
  }
  if (!roomId || !eventId || typeof msgtype !== "string" || typeof text !== "string") {
    throw new CrablineError(
      "Matrix event payload requires room_id, event_id, string content.msgtype, and string content.body",
      { kind: "inbound" },
    );
  }

  const relation = content ? optionalRecord(content, "m.relates_to") : undefined;
  const isThread = relation && optionalString(relation, "rel_type") === "m.thread";
  const threadRootId = isThread ? optionalString(relation, "event_id") : undefined;
  if (isThread && !threadRootId) {
    throw new CrablineError("Matrix m.thread relation requires event_id", {
      kind: "inbound",
    });
  }
  if (!isMatrixRoomId(roomId)) {
    throw new CrablineError(
      `Matrix room_id must be a native ${MATRIX_ROOM_ID_RULE.name} such as ${MATRIX_ROOM_ID_RULE.example}.`,
      { kind: "inbound" },
    );
  }
  if (!isMatrixEventId(eventId)) {
    throw new CrablineError(
      `Matrix event_id must be a native ${MATRIX_EVENT_ID_RULE.name} such as ${MATRIX_EVENT_ID_RULE.example}.`,
      { kind: "inbound" },
    );
  }
  if (threadRootId && !isMatrixEventId(threadRootId)) {
    throw new CrablineError(
      `Matrix thread root event_id must be a native ${MATRIX_EVENT_ID_RULE.name} such as ${MATRIX_EVENT_ID_RULE.example}.`,
      { kind: "inbound" },
    );
  }

  return {
    author: authorFromBotFlag(senderId !== undefined && senderId === botUserId),
    id: eventId,
    raw: payload,
    text,
    threadId: threadRootId ? matrixThreadKey(roomId, threadRootId) : roomId,
  };
}
