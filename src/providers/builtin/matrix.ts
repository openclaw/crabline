import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  authorFromBotFlag,
  createNativeTargetCodec,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
  type NativeIdRule,
} from "./native-local-mock.js";

const MATRIX_ROOM_ID_RULE: NativeIdRule = {
  example: "!abcdef:matrix.org",
  name: "Matrix room id",
  pattern: /^![^:\s]+:[^\s]+$/u,
};

const MATRIX_EVENT_ID_RULE: NativeIdRule = {
  example: "$eventid:matrix.org",
  name: "Matrix event id",
  pattern: /^\$[^\s]+(?::[^\s]+)?$/u,
};

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
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: MATRIX_ROOM_ID_RULE,
        channelLabel: "Matrix room_id",
        thread: MATRIX_EVENT_ID_RULE,
        threadLabel: "Matrix event_id",
      }),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/matrix/webhook", port: 8797 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeMatrixWebhookPayload,
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

function normalizeMatrixWebhookPayload(payload: unknown) {
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
  const text = content ? optionalString(content, "body") : undefined;
  if (!roomId || !text) {
    throw new CrablineError("Matrix event payload requires room_id and content.body", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(false),
    ...(eventId
      ? { id: requireNativeInboundId(eventId, MATRIX_EVENT_ID_RULE, "Matrix event_id") }
      : {}),
    raw: payload,
    text,
    threadId: eventId
      ? requireNativeInboundId(eventId, MATRIX_EVENT_ID_RULE, "Matrix event_id")
      : requireNativeInboundId(roomId, MATRIX_ROOM_ID_RULE, "Matrix room_id"),
  };
}
