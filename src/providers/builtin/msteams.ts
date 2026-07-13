import { createPublicKey, type JsonWebKey } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import {
  createCachedJwtKeyResolver,
  readBearerToken,
  resolveHttpCacheExpiry,
  verifySignedJwt,
} from "../signed-jwt.js";
import { getBuiltinTargetCodec, MSTEAMS_CONVERSATION_ID_RULE } from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

export function resolveMsTeamsAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    appId: config.msteams?.appId ?? env.TEAMS_APP_ID ?? "local-mock-teams-app",
    appPassword: config.msteams?.appPassword ?? env.TEAMS_APP_PASSWORD ?? "local-mock-secret",
    appTenantId: config.msteams?.appTenantId,
    appType: config.msteams?.appType,
    userName: config.msteams?.userName,
  };
}

const BOT_CONNECTOR_ISSUER = "https://api.botframework.com";
const BOT_CONNECTOR_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

type MsTeamsAuthRuntime = {
  env?: NodeJS.ProcessEnv | undefined;
  fetch?: typeof fetch | undefined;
  keyFetchTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  unknownKeyCooldownMs?: number | undefined;
};

type BotConnectorKey = JsonWebKey & {
  endorsements?: string[] | undefined;
  kid?: string | undefined;
};

export function createMsTeamsWebhookAuthenticator(
  config: ProviderConfig,
  runtime: MsTeamsAuthRuntime = {},
) {
  const appId = config.msteams?.appId ?? (runtime.env ?? process.env).TEAMS_APP_ID;
  if (!appId) {
    return undefined;
  }
  const fetchImpl = runtime.fetch ?? fetch;
  const resolveSigningKey = createCachedJwtKeyResolver<BotConnectorKey>({
    async fetchKeys(signal) {
      const fetchedAt = runtime.now?.() ?? Date.now();
      const metadataResponse = await fetchImpl(BOT_CONNECTOR_OPENID_URL, { signal });
      if (!metadataResponse.ok) {
        throw new Error(
          `Bot Connector metadata fetch failed with HTTP ${metadataResponse.status}.`,
        );
      }
      const metadataExpiry = resolveHttpCacheExpiry(metadataResponse, fetchedAt);
      const metadata = (await metadataResponse.json()) as { jwks_uri?: unknown };
      if (typeof metadata.jwks_uri !== "string") {
        throw new Error("Bot Connector metadata omitted jwks_uri.");
      }
      const keysResponse = await fetchImpl(metadata.jwks_uri, { signal });
      if (!keysResponse.ok) {
        throw new Error(`Bot Connector key fetch failed with HTTP ${keysResponse.status}.`);
      }
      const keyExpiry = resolveHttpCacheExpiry(keysResponse, fetchedAt);
      const keys = (await keysResponse.json()) as { keys?: unknown };
      if (!Array.isArray(keys.keys)) {
        throw new Error("Bot Connector key response omitted keys.");
      }
      return {
        expiresAt: Math.min(metadataExpiry, keyExpiry),
        values: keys.keys as BotConnectorKey[],
      };
    },
    keyId: (value) => value.kid,
    now: runtime.now,
    refreshCooldownMs: runtime.unknownKeyCooldownMs,
    timeoutMs: runtime.keyFetchTimeoutMs,
    unknownKeyMessage: "Bot Connector JWT signing key is unknown.",
  });
  return async (request: Request, rawBody: string): Promise<Response | undefined> => {
    const token = readBearerToken(request);
    if (!token) {
      return new Response("unauthorized", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }
    try {
      const payload: unknown = JSON.parse(rawBody);
      if (!isRecord(payload)) {
        throw new Error("Bot Connector activity must be an object.");
      }
      const channelId = optionalString(payload, "channelId");
      const serviceUrl = optionalString(payload, "serviceUrl");
      if (channelId !== "msteams" || !serviceUrl) {
        throw new Error("Bot Connector activity requires channelId=msteams and serviceUrl.");
      }
      const claims = await verifySignedJwt({
        audience: appId,
        issuers: [BOT_CONNECTOR_ISSUER],
        now: runtime.now,
        async resolveKey(header) {
          const key = await resolveSigningKey(header);
          if (key.endorsements && !key.endorsements.includes(channelId)) {
            throw new Error("Bot Connector JWT key does not endorse the activity channel.");
          }
          return createPublicKey({ format: "jwk", key });
        },
        token,
      });
      if (claims.serviceurl !== serviceUrl) {
        throw new Error("Bot Connector serviceurl claim does not match the activity.");
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

export class MsTeamsProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown) {
    const authRuntime = (runtime as MsTeamsAuthRuntime | undefined) ?? {};
    requireExternalMsTeamsWebhookAuthentication(config, authRuntime.env ?? process.env);
    const authenticateWebhookRequest = createMsTeamsWebhookAuthenticator(config, authRuntime);
    super({
      codec: getBuiltinTargetCodec("msteams"),
      config,
      id,
      options: {
        ...(authenticateWebhookRequest ? { authenticateWebhookRequest } : {}),
        defaultWebhook: { host: "127.0.0.1", path: "/msteams/webhook", port: 8791 },
        endpointLabel: "webhook endpoint",
        normalizeWebhookPayload: normalizeMsTeamsWebhookPayload,
        platform: "msteams",
        publicUrl: config.msteams?.webhook.publicUrl,
        recorderPath: config.msteams?.recorder.path
          ? path.resolve(config.msteams.recorder.path)
          : undefined,
        webhook: config.msteams?.webhook,
      },
    });
  }
}

function requireExternalMsTeamsWebhookAuthentication(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
): void {
  const appId = config.msteams?.appId ?? env.TEAMS_APP_ID;
  requireExternalWebhookAuthentication({
    authenticated: Boolean(appId),
    provider: "Microsoft Teams",
    requirement: "msteams.appId or TEAMS_APP_ID",
    webhook: config.msteams?.webhook,
  });
}

export function normalizeMsTeamsWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("Microsoft Teams webhook payload must be an object", {
      kind: "inbound",
    });
  }

  if (optionalRecord(payload, "message")) {
    return genericMockPayloadWithNativeThread({
      channelRule: MSTEAMS_CONVERSATION_ID_RULE,
      payload,
      threadRule: MSTEAMS_CONVERSATION_ID_RULE,
    });
  }

  if (optionalString(payload, "type") !== "message") {
    throw new CrablineError("Microsoft Teams activity payload requires type=message", {
      kind: "inbound",
    });
  }
  const conversation = optionalRecord(payload, "conversation");
  const from = optionalRecord(payload, "from");
  const channelId = optionalString(payload, "channelId");
  const conversationId = conversation ? optionalString(conversation, "id") : undefined;
  const text = optionalString(payload, "text");
  if (channelId !== "msteams" || !conversationId || !text) {
    throw new CrablineError(
      "Microsoft Teams activity payload requires channelId=msteams, conversation.id, and text",
      {
        kind: "inbound",
      },
    );
  }

  return {
    author: authorFromBotFlag(optionalString(from ?? {}, "role") === "bot"),
    ...(optionalString(payload, "id") ? { id: optionalString(payload, "id") } : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(
      conversationId,
      MSTEAMS_CONVERSATION_ID_RULE,
      "Microsoft Teams conversation.id",
    ),
  };
}
