import { createPublicKey } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import { readBearerToken, verifySignedJwt } from "../signed-jwt.js";
import {
  getBuiltinTargetCodec,
  GOOGLE_CHAT_SPACE_RULE,
  GOOGLE_CHAT_THREAD_RULE,
} from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

export function resolveGoogleChatAdapterConfig(
  config: ProviderConfig,
  _env: NodeJS.ProcessEnv = process.env,
) {
  return {
    endpointUrl: config.googlechat?.endpointUrl,
    projectNumber: config.googlechat?.googleChatProjectNumber ?? "local-mock-googlechat",
    userName: config.googlechat?.userName,
  };
}

const GOOGLE_CHAT_SERVICE_ACCOUNT = "chat@system.gserviceaccount.com";
const GOOGLE_OAUTH_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

type GoogleChatAuthRuntime = {
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
};

export function createGoogleChatWebhookAuthenticator(
  config: ProviderConfig,
  runtime: GoogleChatAuthRuntime = {},
) {
  if (config.googlechat?.disableSignatureVerification) {
    return undefined;
  }
  const endpointAudience = config.googlechat?.endpointUrl;
  const projectAudience = config.googlechat?.googleChatProjectNumber;
  const pubsubAudience = config.googlechat?.pubsubAudience;
  const pubsubServiceAccount = config.googlechat?.credentials?.client_email;
  if (!(endpointAudience || projectAudience || pubsubAudience)) {
    return undefined;
  }

  const fetchImpl = runtime.fetch ?? fetch;
  const cachedCertificates = new Map<
    string,
    { expiresAt: number; values: Record<string, string> }
  >();
  return async (request: Request, rawBody: string): Promise<Response | undefined> => {
    const token = readBearerToken(request);
    if (!token) {
      return new Response("unauthorized", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody) as unknown;
      } catch {
        return undefined;
      }
      const isPubsub =
        isRecord(payload) &&
        isRecord(payload.message) &&
        typeof payload.message.data === "string" &&
        typeof payload.subscription === "string";
      const audience = isPubsub ? pubsubAudience : (endpointAudience ?? projectAudience);
      if (!audience) {
        throw new Error("Google Chat verification is not configured for this transport.");
      }
      const usesGoogleIdentityToken = isPubsub || endpointAudience !== undefined;
      const certificateUrl = usesGoogleIdentityToken
        ? GOOGLE_OAUTH_CERTS_URL
        : GOOGLE_CHAT_CERTS_URL;
      const claims = await verifySignedJwt({
        audience,
        issuers: usesGoogleIdentityToken
          ? ["accounts.google.com", "https://accounts.google.com"]
          : [GOOGLE_CHAT_SERVICE_ACCOUNT],
        now: runtime.now,
        async resolveKey(header) {
          const now = runtime.now?.() ?? Date.now();
          let certificates = cachedCertificates.get(certificateUrl);
          if (!certificates || certificates.expiresAt <= now) {
            const response = await fetchImpl(certificateUrl);
            if (!response.ok) {
              throw new Error(`Google certificate fetch failed with HTTP ${response.status}.`);
            }
            const values = (await response.json()) as Record<string, string>;
            certificates = { expiresAt: now + 60 * 60 * 1000, values };
            cachedCertificates.set(certificateUrl, certificates);
          }
          const certificate = certificates.values[header.kid];
          if (!certificate) {
            throw new Error("Google JWT signing key is unknown.");
          }
          return createPublicKey(certificate);
        },
        token,
      });
      if (
        isPubsub &&
        (!pubsubServiceAccount ||
          claims.email !== pubsubServiceAccount ||
          claims.email_verified !== true)
      ) {
        throw new Error("Google Pub/Sub token identity is invalid.");
      }
      if (
        !isPubsub &&
        endpointAudience &&
        (claims.email !== GOOGLE_CHAT_SERVICE_ACCOUNT || claims.email_verified !== true)
      ) {
        throw new Error("Google Chat ID token identity is invalid.");
      }
      return undefined;
    } catch {
      return new Response("unauthorized", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }
  };
}

export function matchesGoogleChatThread(
  candidateThreadId: string,
  expectedThreadId: string | undefined,
): boolean {
  if (!expectedThreadId) {
    return true;
  }
  return (
    candidateThreadId === expectedThreadId ||
    (GOOGLE_CHAT_SPACE_RULE.pattern.test(expectedThreadId) &&
      candidateThreadId.startsWith(`${expectedThreadId}/threads/`))
  );
}

export class GoogleChatProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const authenticateWebhookRequest = createGoogleChatWebhookAuthenticator(
      config,
      (runtime as GoogleChatAuthRuntime | undefined) ?? {},
    );
    super({
      codec: getBuiltinTargetCodec("googlechat"),
      config,
      id,
      options: {
        ...(authenticateWebhookRequest ? { authenticateWebhookRequest } : {}),
        defaultWebhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
        endpointLabel: "webhook endpoint",
        matchesThread: matchesGoogleChatThread,
        normalizeWebhookPayload: normalizeGoogleChatWebhookPayload,
        platform: "googlechat",
        publicUrl: config.googlechat?.webhook.publicUrl,
        recorderPath: config.googlechat?.recorder.path
          ? path.resolve(config.googlechat.recorder.path)
          : undefined,
        webhook: config.googlechat?.webhook,
      },
    });
  }
}

function normalizeGoogleChatWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Google Chat webhook payload must be an object", {
      kind: "inbound",
    });
  }

  const payloadMessage = optionalRecord(payload, "message");
  const message = payloadMessage ?? payload;
  if (payloadMessage && optionalString(payloadMessage, "threadId")) {
    return genericMockPayloadWithNativeThread({
      channelRule: GOOGLE_CHAT_SPACE_RULE,
      payload,
      threadRule: GOOGLE_CHAT_THREAD_RULE,
    });
  }

  const space = optionalRecord(message, "space");
  const thread = optionalRecord(message, "thread");
  const sender = optionalRecord(message, "sender");
  const spaceName = space ? optionalString(space, "name") : undefined;
  const threadName = thread ? optionalString(thread, "name") : undefined;
  const text = optionalString(message, "text") ?? optionalString(message, "argumentText");
  if (!spaceName || !text) {
    throw new CrablineError("Google Chat message payload requires space.name and text", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(optionalString(sender ?? {}, "type") === "BOT"),
    ...(optionalString(message, "name") ? { id: optionalString(message, "name") } : {}),
    raw: payload,
    text,
    threadId: threadName
      ? requireNativeInboundId(threadName, GOOGLE_CHAT_THREAD_RULE, "Google Chat thread.name")
      : requireNativeInboundId(spaceName, GOOGLE_CHAT_SPACE_RULE, "Google Chat space.name"),
  };
}
