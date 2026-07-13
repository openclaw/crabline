import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  getBuiltinTargetCodec,
  isMatrixEventId,
  isMatrixRoomId,
  MATRIX_EVENT_ID_RULE,
  MATRIX_ROOM_ID_RULE,
} from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

const DEFAULT_MATRIX_ACCESS = "local-mock-matrix-token";

export function resolveMatrixAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const fallbackUserId = env.MATRIX_USER_ID?.trim() || `@${userName}:matrix.local`;
  return {
    auth: {
      ...(config.matrix?.auth ?? {
        accessToken: env.MATRIX_ACCESS_TOKEN ?? DEFAULT_MATRIX_ACCESS,
        type: "accessToken" as const,
      }),
      userID: config.matrix?.auth?.userID?.trim() || fallbackUserId,
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
  const scopedExpected =
    target.channelId && isMatrixEventId(expectedThreadId)
      ? matrixThreadKey(target.channelId, expectedThreadId)
      : expectedThreadId;
  return (
    candidateThreadId === expectedThreadId ||
    candidateThreadId === scopedExpected ||
    (isMatrixRoomId(scopedExpected) && candidateThreadId.startsWith(`${scopedExpected}:thread:`))
  );
}

export function normalizeMatrixWebhookPayload(payload: unknown, botUserId?: string) {
  if (!isRecord(payload)) {
    throw new CrablineError("Matrix webhook payload must be an object", { kind: "inbound" });
  }

  if (optionalRecord(payload, "message")) {
    return genericMockPayloadWithNativeThread({
      channelRule: MATRIX_ROOM_ID_RULE,
      payload,
      threadRule: MATRIX_EVENT_ID_RULE,
    });
  }

  const content = optionalRecord(payload, "content");
  const roomId = optionalString(payload, "room_id");
  const eventId = optionalString(payload, "event_id");
  const eventType = optionalString(payload, "type");
  const senderId = optionalString(payload, "sender");
  const text = content ? optionalString(content, "body") : undefined;
  if (eventType !== "m.room.message") {
    throw new CrablineError("Matrix event payload requires type=m.room.message", {
      kind: "inbound",
    });
  }
  if (!roomId || !eventId || !text) {
    throw new CrablineError("Matrix event payload requires room_id, event_id, and content.body", {
      kind: "inbound",
    });
  }

  const relation = content ? optionalRecord(content, "m.relates_to") : undefined;
  const isThread = relation && optionalString(relation, "rel_type") === "m.thread";
  const threadRootId = isThread ? optionalString(relation, "event_id") : undefined;
  if (isThread && !threadRootId) {
    throw new CrablineError("Matrix m.thread relation requires event_id", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(senderId !== undefined && senderId === botUserId),
    id: requireNativeInboundId(eventId, MATRIX_EVENT_ID_RULE, "Matrix event_id"),
    raw: payload,
    text,
    threadId: threadRootId
      ? matrixThreadKey(
          requireNativeInboundId(roomId, MATRIX_ROOM_ID_RULE, "Matrix room_id"),
          requireNativeInboundId(threadRootId, MATRIX_EVENT_ID_RULE, "Matrix thread root event_id"),
        )
      : requireNativeInboundId(roomId, MATRIX_ROOM_ID_RULE, "Matrix room_id"),
  };
}
