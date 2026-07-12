import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
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
  requireNativeInboundId,
} from "./native-local-mock.js";

export function resolveMatrixAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    auth: config.matrix?.auth ?? {
      accessToken: env.MATRIX_ACCESS_TOKEN ?? "local-mock-matrix-token",
      type: "accessToken" as const,
      userID: `@${userName}:matrix.local`,
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
    target.channelId && MATRIX_EVENT_ID_RULE.pattern.test(expectedThreadId)
      ? matrixThreadKey(target.channelId, expectedThreadId)
      : expectedThreadId;
  return (
    candidateThreadId === expectedThreadId ||
    candidateThreadId === scopedExpected ||
    (MATRIX_ROOM_ID_RULE.pattern.test(scopedExpected) &&
      candidateThreadId.startsWith(`${scopedExpected}:thread:`))
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
  const senderId = optionalString(payload, "sender");
  const text = content ? optionalString(content, "body") : undefined;
  if (!roomId || !text) {
    throw new CrablineError("Matrix event payload requires room_id and content.body", {
      kind: "inbound",
    });
  }

  const relation = content ? optionalRecord(content, "m.relates_to") : undefined;
  const threadRootId =
    relation && optionalString(relation, "rel_type") === "m.thread"
      ? optionalString(relation, "event_id")
      : undefined;

  return {
    author: authorFromBotFlag(senderId !== undefined && senderId === botUserId),
    ...(eventId
      ? { id: requireNativeInboundId(eventId, MATRIX_EVENT_ID_RULE, "Matrix event_id") }
      : {}),
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
