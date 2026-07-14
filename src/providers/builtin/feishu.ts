import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  FEISHU_CHAT_ID_RULE,
  FEISHU_MESSAGE_ID_RULE,
  getBuiltinTargetCodec,
} from "../target-normalizers.js";
import {
  authorFromBotFlag,
  createSecretVerifier,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

type FeishuEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "FEISHU_ENCRYPT_KEY" | "FEISHU_VERIFICATION_TOKEN">
>;

type FeishuAuthRuntime = {
  now?: (() => number) | undefined;
  replayCacheLimit?: number | undefined;
};

type FeishuReplayReservation = {
  expiresAt: number;
  keys: Set<string>;
  promise: Promise<boolean>;
  resolve: (accepted: boolean) => void;
};

type FeishuReplayState = {
  accepted: Map<string, number>;
  inFlight: Map<string, FeishuReplayReservation>;
};

const FEISHU_MAX_CALLBACK_AGE_MS = 5 * 60_000;
const FEISHU_MAX_ENCRYPTED_PAYLOAD_BYTES = 1024 * 1024;
const FEISHU_MAX_ENCRYPTED_PAYLOAD_BASE64_LENGTH =
  Math.ceil(FEISHU_MAX_ENCRYPTED_PAYLOAD_BYTES / 3) * 4;
const FEISHU_REPLAY_CACHE_LIMIT = 2_048;
const FEISHU_MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export function resolveFeishuAdapterConfig(
  config: ProviderConfig,
  env: FeishuEnvironment = process.env,
) {
  const configuredEncryptKey = config.feishu?.encryptKey;
  const encryptKey = configuredEncryptKey ?? env.FEISHU_ENCRYPT_KEY;
  if (encryptKey !== undefined && !encryptKey.trim()) {
    throw new CrablineError(
      configuredEncryptKey === undefined
        ? "FEISHU_ENCRYPT_KEY must not be empty or whitespace-only."
        : "Feishu encryptKey must not be empty or whitespace-only.",
      { kind: "config" },
    );
  }
  return {
    appId: config.feishu?.appId ?? "local-mock-feishu-app",
    encryptKey,
    userName: config.feishu?.userName,
    verificationToken: config.feishu?.verificationToken ?? env.FEISHU_VERIFICATION_TOKEN,
  };
}

export function handleFeishuWebhookPayload(payload: unknown): Response | undefined {
  if (
    isRecord(payload) &&
    payload.type === "url_verification" &&
    typeof payload.challenge === "string"
  ) {
    return Response.json({ challenge: payload.challenge });
  }
  if (isRecord(payload) && isRecord(payload.event)) {
    const message = optionalRecord(payload.event, "message");
    if (!message) {
      return new Response(null, { status: 200 });
    }
    const messageType = optionalString(message, "message_type");
    if (messageType !== "text") {
      return new Response(null, { status: 200 });
    }
    const text = parseFeishuText(optionalString(message, "content"));
    if (typeof text !== "string") {
      return undefined;
    }
    if (!text) {
      return new Response(null, { status: 200 });
    }
  }
  return undefined;
}

export function createFeishuWebhookAuthenticator(
  config: ProviderConfig,
  env: FeishuEnvironment = process.env,
  runtime: FeishuAuthRuntime = {},
) {
  return createFeishuWebhookAuthenticatorWithReplay(config, env, runtime);
}

function createFeishuWebhookAuthenticatorWithReplay(
  config: ProviderConfig,
  env: FeishuEnvironment,
  runtime: FeishuAuthRuntime,
  replayState?: FeishuReplayState,
) {
  const resolved = resolveFeishuAdapterConfig(config, env);
  const validateCallback = resolved.verificationToken
    ? createSecretVerifier(resolved.verificationToken)
    : undefined;
  if (!(resolved.encryptKey || validateCallback)) {
    return undefined;
  }
  return async (request: Request, rawBody: string): Promise<Response | undefined> => {
    if (!isFeishuWebhookBodyWithinLimit(rawBody)) {
      return unauthorizedFeishuWebhook();
    }
    const signaturePresent = request.headers.has("x-lark-signature");
    let signedRequest = false;
    if (signaturePresent) {
      if (!resolved.encryptKey || !verifyFeishuSignature(request, rawBody, resolved.encryptKey)) {
        return unauthorizedFeishuWebhook();
      }
      signedRequest = true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(payload)) {
      return unauthorizedFeishuWebhook();
    }
    const encryptedEnvelope = payload;

    const encrypted = typeof payload.encrypt === "string";
    if (encrypted) {
      if (!resolved.encryptKey) {
        return unauthorizedFeishuWebhook();
      }
      try {
        payload = decryptFeishuWebhookPayload(payload, resolved.encryptKey);
      } catch {
        return unauthorizedFeishuWebhook();
      }
      if (!signedRequest && !(isFeishuUrlVerification(payload) && validateCallback)) {
        return unauthorizedFeishuWebhook();
      }
    } else if (resolved.encryptKey) {
      return unauthorizedFeishuWebhook();
    }

    if (validateCallback && !validateCallback(readFeishuVerificationToken(payload))) {
      return unauthorizedFeishuWebhook();
    }
    const now = runtime.now?.() ?? Date.now();
    const callbackTimestamp = readFeishuCallbackTimestamp(request, payload, signedRequest);
    if (callbackTimestamp === null) {
      return unauthorizedFeishuWebhook();
    }
    if (
      callbackTimestamp !== undefined &&
      Math.abs(now - callbackTimestamp) > FEISHU_MAX_CALLBACK_AGE_MS
    ) {
      return unauthorizedFeishuWebhook();
    }
    const callbackKeys = readFeishuCallbackKeys(payload, encryptedEnvelope);
    if (!replayState) {
      return undefined;
    }
    const callbackExpiresAt = (callbackTimestamp ?? now) + FEISHU_MAX_CALLBACK_AGE_MS;
    pruneFeishuReplayCache(replayState.accepted, now);
    while (callbackKeys.length > 0) {
      if (callbackKeys.some((key) => replayState.accepted.has(key))) {
        return new Response(null, { status: 200 });
      }
      const reservation = callbackKeys
        .map((key) => replayState.inFlight.get(key))
        .find((candidate) => candidate !== undefined);
      if (!reservation) {
        if (
          !reserveFeishuCallback(
            replayState,
            callbackKeys,
            callbackExpiresAt,
            runtime.replayCacheLimit ?? FEISHU_REPLAY_CACHE_LIMIT,
          )
        ) {
          return feishuReplayCapacityResponse();
        }
        break;
      }
      if (await reservation.promise) {
        return new Response(null, { status: 200 });
      }
    }
    return undefined;
  };
}

export class FeishuProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const authRuntime =
      (runtime as (FeishuAuthRuntime & { env?: FeishuEnvironment }) | undefined) ?? {};
    const env = authRuntime.env ?? process.env;
    const resolved = resolveFeishuAdapterConfig(config, env);
    requireExternalWebhookAuthentication({
      authenticated: Boolean(resolved.encryptKey),
      provider: "Feishu",
      requirement: "feishu.encryptKey or FEISHU_ENCRYPT_KEY for X-Lark-Signature verification",
      webhook: config.feishu?.webhook,
    });
    const replayState: FeishuReplayState = {
      accepted: new Map(),
      inFlight: new Map(),
    };
    const authenticateWebhookRequest = createFeishuWebhookAuthenticatorWithReplay(
      config,
      env,
      authRuntime,
      replayState,
    );
    const decodePayload = (payload: unknown) =>
      resolved.encryptKey ? decryptFeishuWebhookPayload(payload, resolved.encryptKey) : payload;
    super({
      codec: getBuiltinTargetCodec("feishu"),
      config,
      id,
      options: {
        ...(authenticateWebhookRequest ? { authenticateWebhookRequest } : {}),
        createWebhookSuccessResponse(payload, responseId) {
          return new Response(JSON.stringify({ id: responseId, ok: true }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
        defaultWebhook: { host: "127.0.0.1", path: "/feishu/webhook", port: 8795 },
        endpointLabel: "webhook endpoint",
        handleWebhookPayload: (payload) => handleFeishuWebhookPayload(decodePayload(payload)),
        normalizeWebhookPayload: (payload) => normalizeFeishuWebhookPayload(decodePayload(payload)),
        platform: "feishu",
        publicUrl: config.feishu?.webhook.publicUrl,
        recorderPath: config.feishu?.recorder.path
          ? path.resolve(config.feishu.recorder.path)
          : undefined,
        settleWebhookRequest({ accepted, payload, rawBody }) {
          const encryptedEnvelope = readFeishuSettledEnvelope(payload, rawBody);
          const decodedPayload = decodePayload(encryptedEnvelope);
          if (accepted) {
            acceptFeishuCallback(
              replayState,
              decodedPayload,
              encryptedEnvelope,
              authRuntime.now?.() ?? Date.now(),
            );
          } else {
            rejectFeishuCallback(replayState, decodedPayload, encryptedEnvelope);
          }
        },
        webhook: config.feishu?.webhook,
      },
    });
  }
}

export function normalizeFeishuWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Feishu webhook payload must be an object", { kind: "inbound" });
  }

  const recordedPayload = redactFeishuVerificationTokens(payload);
  const event = optionalRecord(payload, "event");
  const message = event ? optionalRecord(event, "message") : undefined;
  if (!message) {
    return genericMockPayloadWithNativeThread({
      channelRule: FEISHU_CHAT_ID_RULE,
      payload: recordedPayload,
      threadRule: FEISHU_MESSAGE_ID_RULE,
    });
  }

  const chatId = optionalString(message, "chat_id");
  const messageType = optionalString(message, "message_type");
  const messageId = optionalString(message, "message_id");
  const rootId = optionalString(message, "root_id");
  const rawContent = optionalString(message, "content");
  const text = parseFeishuText(rawContent);
  if (text === null) {
    throw new CrablineError("Feishu message.content must be valid JSON", {
      kind: "inbound",
    });
  }
  if (messageType !== "text") {
    throw new CrablineError("Feishu event payload requires message.message_type=text", {
      kind: "inbound",
    });
  }
  if (!chatId || !messageId || !text) {
    throw new CrablineError(
      "Feishu event payload requires message.chat_id, message.message_id, and message.content",
      {
        kind: "inbound",
      },
    );
  }

  return {
    author: authorFromBotFlag(
      event
        ? ["app", "bot"].includes(
            optionalString(optionalRecord(event, "sender") ?? {}, "sender_type") ?? "",
          )
        : false,
    ),
    id: requireNativeInboundId(messageId, FEISHU_MESSAGE_ID_RULE, "Feishu message_id"),
    raw: recordedPayload,
    text,
    threadId: rootId
      ? requireNativeInboundId(rootId, FEISHU_MESSAGE_ID_RULE, "Feishu root_id")
      : requireNativeInboundId(chatId, FEISHU_CHAT_ID_RULE, "Feishu chat_id"),
  };
}

function redactFeishuVerificationTokens(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...payload };
  delete redacted.token;
  const header = optionalRecord(payload, "header");
  if (header) {
    const redactedHeader = { ...header };
    delete redactedHeader.token;
    redacted.header = redactedHeader;
  }
  return redacted;
}

function parseFeishuText(content: string | undefined): string | null | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
    return undefined;
  } catch {
    return null;
  }
}

function readFeishuSettledEnvelope(payload: unknown, rawBody: string): unknown {
  if (isRecord(payload)) {
    return payload;
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return payload;
  }
}

export function decryptFeishuWebhookPayload(payload: unknown, encryptKey: string): unknown {
  if (!isRecord(payload) || typeof payload.encrypt !== "string") {
    return payload;
  }
  if (payload.encrypt.length > FEISHU_MAX_ENCRYPTED_PAYLOAD_BASE64_LENGTH) {
    throw new Error("Feishu encrypted payload is too large.");
  }
  const encrypted = Buffer.from(payload.encrypt, "base64");
  if (encrypted.length > FEISHU_MAX_ENCRYPTED_PAYLOAD_BYTES) {
    throw new Error("Feishu encrypted payload is too large.");
  }
  if (encrypted.length <= 16 || (encrypted.length - 16) % 16 !== 0) {
    throw new Error("Feishu encrypted payload is truncated.");
  }
  const key = createHash("sha256").update(encryptKey).digest();
  const decipher = createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
  const decrypted = Buffer.concat([
    decipher.update(encrypted.subarray(16)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decrypted) as unknown;
}

function readFeishuVerificationToken(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const header = optionalRecord(payload, "header");
  return (
    optionalString(payload, "token") ?? (header ? optionalString(header, "token") : null) ?? null
  );
}

function isFeishuUrlVerification(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    payload.type === "url_verification" &&
    typeof payload.challenge === "string" &&
    payload.challenge.length > 0
  );
}

function isFeishuWebhookBodyWithinLimit(rawBody: string): boolean {
  return (
    rawBody.length <= FEISHU_MAX_WEBHOOK_BODY_BYTES &&
    Buffer.byteLength(rawBody, "utf8") <= FEISHU_MAX_WEBHOOK_BODY_BYTES
  );
}

function verifyFeishuSignature(request: Request, rawBody: string, encryptKey: string): boolean {
  const timestamp = request.headers.get("x-lark-request-timestamp");
  const nonce = request.headers.get("x-lark-request-nonce");
  const signature = request.headers.get("x-lark-signature");
  if (!timestamp || !nonce || !signature || !/^[0-9a-f]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = createHash("sha256")
    .update(timestamp)
    .update(nonce)
    .update(encryptKey)
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function readFeishuCallbackTimestamp(
  request: Request,
  payload: unknown,
  signedRequest: boolean,
): number | null | undefined {
  const requestTimestamp = signedRequest
    ? request.headers.get("x-lark-request-timestamp")
    : undefined;
  const header = isRecord(payload) ? optionalRecord(payload, "header") : undefined;
  const headerTimestamp = header ? optionalString(header, "create_time") : undefined;
  const value = requestTimestamp ?? headerTimestamp;
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    return null;
  }
  if (timestamp >= 100_000_000_000_000) {
    return Math.floor(timestamp / 1_000);
  }
  if (timestamp >= 100_000_000_000) {
    return timestamp;
  }
  return timestamp * 1_000;
}

function readFeishuCallbackKeys(payload: unknown, encryptedEnvelope: unknown): string[] {
  if (!isRecord(payload) || isFeishuUrlVerification(payload)) {
    return [];
  }
  const event = optionalRecord(payload, "event");
  const message = event ? optionalRecord(event, "message") : undefined;
  const header = optionalRecord(payload, "header");
  const messageId = message ? optionalString(message, "message_id") : undefined;
  const eventId = header ? optionalString(header, "event_id") : undefined;
  const encrypted = isRecord(encryptedEnvelope)
    ? optionalString(encryptedEnvelope, "encrypt")
    : undefined;
  if (eventId) {
    return [`event:${eventId}`];
  }
  if (messageId) {
    return [`message:${messageId}`];
  }
  return encrypted ? [`encrypted:${createHash("sha256").update(encrypted).digest("hex")}`] : [];
}

function reserveFeishuCallback(
  replayState: FeishuReplayState,
  callbackKeys: string[],
  expiresAt: number,
  cacheLimit: number,
): boolean {
  const occupiedKeys = new Set([...replayState.accepted.keys(), ...replayState.inFlight.keys()]);
  const newKeys = new Set(callbackKeys.filter((key) => !occupiedKeys.has(key)));
  if (occupiedKeys.size + newKeys.size > cacheLimit) {
    return false;
  }
  let resolveReservation!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveReservation = resolve;
  });
  const reservation: FeishuReplayReservation = {
    expiresAt,
    keys: new Set(callbackKeys),
    promise,
    resolve: resolveReservation,
  };
  for (const key of callbackKeys) {
    replayState.inFlight.set(key, reservation);
  }
  return true;
}

function acceptFeishuCallback(
  replayState: FeishuReplayState,
  payload: unknown,
  encryptedEnvelope: unknown,
  now: number,
): void {
  const callbackKeys = readFeishuCallbackKeys(payload, encryptedEnvelope);
  pruneFeishuReplayCache(replayState.accepted, now);
  for (const key of callbackKeys) {
    const reservation = replayState.inFlight.get(key);
    replayState.accepted.set(
      key,
      Math.max(
        replayState.accepted.get(key) ?? 0,
        reservation?.expiresAt ?? now + FEISHU_MAX_CALLBACK_AGE_MS,
      ),
    );
  }
  const reservations = new Set(
    callbackKeys
      .map((key) => replayState.inFlight.get(key))
      .filter((reservation) => reservation !== undefined),
  );
  for (const reservation of reservations) {
    releaseFeishuReservation(replayState, reservation, true);
  }
}

function rejectFeishuCallback(
  replayState: FeishuReplayState,
  payload: unknown,
  encryptedEnvelope: unknown,
): void {
  const callbackKeys = readFeishuCallbackKeys(payload, encryptedEnvelope);
  const reservations = new Set(
    callbackKeys
      .map((key) => replayState.inFlight.get(key))
      .filter((reservation) => reservation !== undefined),
  );
  for (const reservation of reservations) {
    releaseFeishuReservation(replayState, reservation, false);
  }
}

function releaseFeishuReservation(
  replayState: FeishuReplayState,
  reservation: FeishuReplayReservation,
  accepted: boolean,
): void {
  for (const key of reservation.keys) {
    if (replayState.inFlight.get(key) === reservation) {
      replayState.inFlight.delete(key);
    }
  }
  reservation.resolve(accepted);
}

function pruneFeishuReplayCache(recentCallbacks: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of recentCallbacks) {
    if (now > expiresAt) {
      recentCallbacks.delete(key);
    }
  }
}

function feishuReplayCapacityResponse(): Response {
  return new Response("service unavailable", {
    headers: { "cache-control": "no-store" },
    status: 503,
  });
}

function unauthorizedFeishuWebhook(): Response {
  return new Response("unauthorized", { status: 401 });
}
