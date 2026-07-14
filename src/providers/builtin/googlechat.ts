import { createPublicKey, type KeyObject, X509Certificate } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  createCachedJwtKeyResolver,
  JwtKeyInfrastructureError,
  readBearerToken,
  resolveHttpCacheExpiry,
  verifySignedJwt,
} from "../signed-jwt.js";
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
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

export function resolveGoogleChatAdapterConfig(
  config: ProviderConfig,
  _env: NodeJS.ProcessEnv = process.env,
) {
  return {
    endpointUrl: config.googlechat?.endpointUrl,
    projectNumber: config.googlechat?.googleChatProjectNumber ?? "local-mock-googlechat",
    pubsubServiceAccountEmail:
      config.googlechat?.pubsubServiceAccountEmail ?? config.googlechat?.credentials?.client_email,
    userName: config.googlechat?.userName,
  };
}

const GOOGLE_CHAT_SERVICE_ACCOUNT = "chat@system.gserviceaccount.com";
const GOOGLE_OAUTH_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
const GOOGLE_CHAT_MESSAGE_NAME_PATTERN = /^spaces\/[A-Za-z0-9_-]+\/messages\/[^/\s]+$/u;

type GoogleChatAuthRuntime = {
  fetch?: typeof fetch | undefined;
  keyFetchTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  unknownKeyCooldownMs?: number | undefined;
};

type GoogleCertificate = {
  kid: string;
  key: KeyObject;
};

export function createGoogleChatWebhookAuthenticator(
  config: ProviderConfig,
  runtime: GoogleChatAuthRuntime = {},
) {
  if (config.googlechat?.disableSignatureVerification) {
    return undefined;
  }
  const endpointAudience = config.googlechat?.endpointUrl ?? config.googlechat?.webhook.publicUrl;
  const projectAudience = config.googlechat?.googleChatProjectNumber;
  const pubsubAudience = config.googlechat?.pubsubAudience ?? endpointAudience;
  const pubsubServiceAccount =
    config.googlechat?.pubsubServiceAccountEmail ?? config.googlechat?.credentials?.client_email;
  if (!(endpointAudience || projectAudience || pubsubAudience)) {
    return undefined;
  }

  const fetchImpl = runtime.fetch ?? fetch;
  const createCertificateResolver = (certificateUrl: string) => {
    return createCachedJwtKeyResolver<GoogleCertificate>({
      async fetchKeys(signal) {
        try {
          const requestedAt = runtime.now?.() ?? Date.now();
          const response = await fetchImpl(certificateUrl, { signal });
          if (!response.ok) {
            throw new Error(`Google certificate fetch failed with HTTP ${response.status}.`);
          }
          const body: unknown = await response.json();
          if (!isRecord(body)) {
            throw new Error("Google certificate response must be an object.");
          }
          const values = Object.entries(body).map(([kid, certificate]) => {
            if (typeof certificate !== "string") {
              throw new Error("Google certificate response values must be strings.");
            }
            const certificateLabel = ["-----BEGIN", "CERTIFICATE-----"].join(" ");
            const key = certificate.includes(certificateLabel)
              ? new X509Certificate(certificate).publicKey
              : createPublicKey(certificate);
            if (key.asymmetricKeyType !== "rsa") {
              throw new Error("Google certificate response keys must use RSA.");
            }
            return { kid, key };
          });
          if (values.length === 0) {
            throw new Error("Google certificate response must include signing keys.");
          }
          return {
            expiresAt: resolveHttpCacheExpiry(response, requestedAt),
            values,
          };
        } catch (error) {
          throw error instanceof JwtKeyInfrastructureError
            ? error
            : new JwtKeyInfrastructureError(
                error instanceof Error ? error.message : "Google certificate fetch failed.",
                { cause: error },
              );
        }
      },
      keyId: (value) => value.kid,
      now: runtime.now,
      refreshCooldownMs: runtime.unknownKeyCooldownMs,
      timeoutMs: runtime.keyFetchTimeoutMs,
      unknownKeyMessage: "Google JWT signing key is unknown.",
    });
  };
  const resolveGoogleIdentityCertificate = createCertificateResolver(GOOGLE_OAUTH_CERTS_URL);
  const resolveGoogleChatCertificate = createCertificateResolver(GOOGLE_CHAT_CERTS_URL);
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
        return new Response("unauthorized", {
          headers: { "www-authenticate": "Bearer" },
          status: 401,
        });
      }
      const isPubsub =
        isRecord(payload) &&
        isRecord(payload.message) &&
        typeof payload.message.data === "string" &&
        typeof payload.subscription === "string";
      const audience = isPubsub ? pubsubAudience : (projectAudience ?? endpointAudience);
      if (!audience) {
        throw new Error("Google Chat verification is not configured for this transport.");
      }
      const usesGoogleIdentityToken =
        isPubsub || (projectAudience === undefined && endpointAudience !== undefined);
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
          const certificate = await (certificateUrl === GOOGLE_OAUTH_CERTS_URL
            ? resolveGoogleIdentityCertificate(header)
            : resolveGoogleChatCertificate(header));
          return certificate.key;
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
        usesGoogleIdentityToken &&
        (claims.email !== GOOGLE_CHAT_SERVICE_ACCOUNT || claims.email_verified !== true)
      ) {
        throw new Error("Google Chat ID token identity is invalid.");
      }
      return undefined;
    } catch (error) {
      return googleAuthenticationResponse(error instanceof JwtKeyInfrastructureError ? 503 : 401);
    }
  };
}

function googleAuthenticationResponse(status: 401 | 503): Response {
  return new Response(status === 401 ? "unauthorized" : "service unavailable", {
    headers: {
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
    status,
  });
}

export function matchesGoogleChatThread(
  candidateThreadId: string,
  expectedThreadId: string | undefined,
  target: { channelId?: string | undefined } = {},
): boolean {
  const candidateSpace = GOOGLE_CHAT_THREAD_RULE.pattern.test(candidateThreadId)
    ? candidateThreadId.slice(0, candidateThreadId.indexOf("/threads/"))
    : candidateThreadId;
  if (target.channelId && candidateSpace !== target.channelId) {
    return false;
  }
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
    const endpointAudience = config.googlechat?.endpointUrl ?? config.googlechat?.webhook.publicUrl;
    const pubsubServiceAccount =
      config.googlechat?.pubsubServiceAccountEmail ?? config.googlechat?.credentials?.client_email;
    const authenticationConfigured =
      !config.googlechat?.disableSignatureVerification &&
      Boolean(
        endpointAudience ||
        config.googlechat?.googleChatProjectNumber ||
        (config.googlechat?.pubsubAudience && pubsubServiceAccount),
      );
    requireExternalWebhookAuthentication({
      authenticated: authenticationConfigured,
      authenticatedIngressUrls: config.googlechat?.endpointUrl
        ? [config.googlechat.endpointUrl]
        : undefined,
      provider: "Google Chat",
      requirement:
        "googlechat.endpointUrl, googlechat.googleChatProjectNumber, or googlechat.pubsubAudience with a Pub/Sub service-account identity and signature verification enabled",
      webhook: config.googlechat?.webhook,
    });
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
        handleWebhookPayload: handleGoogleChatWebhookPayload,
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

export function normalizeGoogleChatWebhookPayload(payload: unknown) {
  payload = unwrapGoogleChatPubsubPayload(payload);
  if (!isRecord(payload)) {
    throw new CrablineError("Google Chat webhook payload must be an object", {
      kind: "inbound",
    });
  }

  const chat = optionalRecord(payload, "chat");
  if (chat && "messagePayload" in chat) {
    throw new CrablineError(
      "Google Workspace add-on chat.messagePayload events are unsupported without a configured deployment identity",
      { kind: "inbound" },
    );
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
  const messageName = optionalString(message, "name");
  const text = optionalString(message, "text") ?? optionalString(message, "argumentText");
  if (!spaceName || !text) {
    throw new CrablineError("Google Chat message payload requires space.name and text", {
      kind: "inbound",
    });
  }
  const validatedSpaceName = requireNativeInboundId(
    spaceName,
    GOOGLE_CHAT_SPACE_RULE,
    "Google Chat space.name",
  );
  if (messageName) {
    if (!GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test(messageName)) {
      throw new CrablineError("Google Chat message.name must be a valid message resource name", {
        kind: "inbound",
      });
    }
    if (!messageName.startsWith(`${validatedSpaceName}/messages/`)) {
      throw new CrablineError("Google Chat message.name must belong to message.space.name", {
        kind: "inbound",
      });
    }
  }
  const validatedThreadName = threadName
    ? requireNativeInboundId(threadName, GOOGLE_CHAT_THREAD_RULE, "Google Chat thread.name")
    : undefined;
  if (validatedThreadName && !validatedThreadName.startsWith(`${validatedSpaceName}/threads/`)) {
    throw new CrablineError("Google Chat thread.name must belong to message.space.name", {
      kind: "inbound",
    });
  }

  return {
    author: authorFromBotFlag(optionalString(sender ?? {}, "type") === "BOT"),
    ...(messageName ? { id: messageName } : {}),
    raw: payload,
    text,
    threadId: validatedThreadName ?? validatedSpaceName,
  };
}

export function handleGoogleChatWebhookPayload(payload: unknown): Response | undefined {
  let event: unknown;
  try {
    event = unwrapGoogleChatPubsubPayload(payload);
  } catch {
    return undefined;
  }
  if (isRecord(event) && typeof event.type === "string" && event.type !== "MESSAGE") {
    return new Response(null, { status: 200 });
  }
  return undefined;
}

function unwrapGoogleChatPubsubPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  const message = optionalRecord(payload, "message");
  const data = message ? optionalString(message, "data") : undefined;
  if (!data || typeof payload.subscription !== "string") {
    return payload;
  }

  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
      throw new Error("invalid base64");
    }
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data) {
      throw new Error("non-canonical base64");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as unknown;
  } catch {
    throw new CrablineError("Google Pub/Sub message.data must contain base64-encoded JSON.", {
      kind: "inbound",
    });
  }
}
