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

type FeishuEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "FEISHU_ENCRYPT_KEY" | "FEISHU_VERIFICATION_TOKEN">
>;

export function resolveFeishuAdapterConfig(
  config: ProviderConfig,
  env: FeishuEnvironment = process.env,
) {
  return {
    appId: config.feishu?.appId ?? "local-mock-feishu-app",
    encryptKey: config.feishu?.encryptKey ?? env.FEISHU_ENCRYPT_KEY,
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
    const text = parseFeishuText(optionalString(message, "content"));
    if (messageType !== "text" || !text) {
      return new Response(null, { status: 200 });
    }
  }
  return undefined;
}

export function createFeishuWebhookAuthenticator(
  config: ProviderConfig,
  env: FeishuEnvironment = process.env,
) {
  const resolved = resolveFeishuAdapterConfig(config, env);
  const verifyToken = resolved.verificationToken
    ? createSecretVerifier(resolved.verificationToken)
    : undefined;
  if (!(resolved.encryptKey || verifyToken)) {
    return undefined;
  }

  return async (request: Request, rawBody: string): Promise<Response | undefined> => {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(payload)) {
      return unauthorizedFeishuWebhook();
    }

    const encrypted = typeof payload.encrypt === "string";
    if (encrypted) {
      if (!resolved.encryptKey || !verifyFeishuSignature(request, rawBody, resolved.encryptKey)) {
        return unauthorizedFeishuWebhook();
      }
      try {
        payload = decryptFeishuWebhookPayload(payload, resolved.encryptKey);
      } catch {
        return unauthorizedFeishuWebhook();
      }
    } else if (resolved.encryptKey && !verifyToken) {
      return unauthorizedFeishuWebhook();
    }

    if (verifyToken && !verifyToken(readFeishuVerificationToken(payload))) {
      return unauthorizedFeishuWebhook();
    }
    return undefined;
  };
}

export class FeishuProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const env = (runtime as { env?: FeishuEnvironment } | undefined)?.env ?? process.env;
    const resolved = resolveFeishuAdapterConfig(config, env);
    const authenticateWebhookRequest = createFeishuWebhookAuthenticator(config, env);
    const decodePayload = (payload: unknown) =>
      resolved.encryptKey ? decryptFeishuWebhookPayload(payload, resolved.encryptKey) : payload;
    super({
      codec: getBuiltinTargetCodec("feishu"),
      config,
      id,
      options: {
        ...(authenticateWebhookRequest ? { authenticateWebhookRequest } : {}),
        defaultWebhook: { host: "127.0.0.1", path: "/feishu/webhook", port: 8795 },
        endpointLabel: "webhook endpoint",
        handleWebhookPayload: (payload) => handleFeishuWebhookPayload(decodePayload(payload)),
        normalizeWebhookPayload: (payload) => normalizeFeishuWebhookPayload(decodePayload(payload)),
        platform: "feishu",
        publicUrl: config.feishu?.webhook.publicUrl,
        recorderPath: config.feishu?.recorder.path
          ? path.resolve(config.feishu.recorder.path)
          : undefined,
        webhook: config.feishu?.webhook,
      },
    });
  }
}

export function normalizeFeishuWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Feishu webhook payload must be an object", { kind: "inbound" });
  }

  const event = optionalRecord(payload, "event");
  const message = event ? optionalRecord(event, "message") : undefined;
  if (!message) {
    return genericMockPayloadWithNativeThread({
      channelRule: FEISHU_CHAT_ID_RULE,
      payload,
      threadRule: FEISHU_MESSAGE_ID_RULE,
    });
  }

  const chatId = optionalString(message, "chat_id");
  const messageType = optionalString(message, "message_type");
  const messageId = optionalString(message, "message_id");
  const rootId = optionalString(message, "root_id");
  const rawContent = optionalString(message, "content");
  const text = parseFeishuText(rawContent);
  if (messageType !== "text") {
    throw new CrablineError("Feishu event payload requires message.message_type=text", {
      kind: "inbound",
    });
  }
  if (!chatId || !text) {
    throw new CrablineError("Feishu event payload requires message.chat_id and message.content", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(
      event
        ? ["app", "bot"].includes(
            optionalString(optionalRecord(event, "sender") ?? {}, "sender_type") ?? "",
          )
        : false,
    ),
    ...(messageId
      ? { id: requireNativeInboundId(messageId, FEISHU_MESSAGE_ID_RULE, "Feishu message_id") }
      : {}),
    raw: payload,
    text,
    threadId: rootId
      ? requireNativeInboundId(rootId, FEISHU_MESSAGE_ID_RULE, "Feishu root_id")
      : requireNativeInboundId(chatId, FEISHU_CHAT_ID_RULE, "Feishu chat_id"),
  };
}

function parseFeishuText(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    return content;
  }
  return content;
}

export function decryptFeishuWebhookPayload(payload: unknown, encryptKey: string): unknown {
  if (!isRecord(payload) || typeof payload.encrypt !== "string") {
    return payload;
  }
  const encrypted = Buffer.from(payload.encrypt, "base64");
  if (encrypted.length <= 16) {
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

function verifyFeishuSignature(request: Request, rawBody: string, encryptKey: string): boolean {
  const timestamp = request.headers.get("x-lark-request-timestamp");
  const nonce = request.headers.get("x-lark-request-nonce");
  const signature = request.headers.get("x-lark-signature");
  if (!timestamp || !nonce || !signature || !/^[0-9a-f]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = createHash("sha256")
    .update(timestamp + nonce + encryptKey + rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function unauthorizedFeishuWebhook(): Response {
  return new Response("unauthorized", { status: 401 });
}
