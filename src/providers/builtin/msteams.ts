import { createPublicKey, type JsonWebKey } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import { readBearerToken, verifySignedJwt } from "../signed-jwt.js";
import { getBuiltinTargetCodec, MSTEAMS_CONVERSATION_ID_RULE } from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";

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
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
};

export function createMsTeamsWebhookAuthenticator(
  config: ProviderConfig,
  runtime: MsTeamsAuthRuntime = {},
) {
  const appId = config.msteams?.appId ?? process.env.TEAMS_APP_ID;
  if (!appId) {
    return undefined;
  }
  const fetchImpl = runtime.fetch ?? fetch;
  let cachedKeys:
    | {
        expiresAt: number;
        values: Array<JsonWebKey & { endorsements?: string[] | undefined; kid?: string }>;
      }
    | undefined;
  return async (request: Request, rawBody: string): Promise<Response | undefined> => {
    const token = readBearerToken(request);
    if (!token) {
      return new Response("unauthorized", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }
    try {
      let channelId: string | undefined;
      try {
        const payload: unknown = JSON.parse(rawBody);
        channelId = isRecord(payload) ? optionalString(payload, "channelId") : undefined;
      } catch {
        // Authentication does not depend on the activity body.
      }
      await verifySignedJwt({
        audience: appId,
        issuers: [BOT_CONNECTOR_ISSUER],
        now: runtime.now,
        async resolveKey(header) {
          const now = runtime.now?.() ?? Date.now();
          if (!cachedKeys || cachedKeys.expiresAt <= now) {
            const metadataResponse = await fetchImpl(BOT_CONNECTOR_OPENID_URL);
            if (!metadataResponse.ok) {
              throw new Error(
                `Bot Connector metadata fetch failed with HTTP ${metadataResponse.status}.`,
              );
            }
            const metadata = (await metadataResponse.json()) as { jwks_uri?: unknown };
            if (typeof metadata.jwks_uri !== "string") {
              throw new Error("Bot Connector metadata omitted jwks_uri.");
            }
            const keysResponse = await fetchImpl(metadata.jwks_uri);
            if (!keysResponse.ok) {
              throw new Error(`Bot Connector key fetch failed with HTTP ${keysResponse.status}.`);
            }
            const keys = (await keysResponse.json()) as { keys?: unknown };
            if (!Array.isArray(keys.keys)) {
              throw new Error("Bot Connector key response omitted keys.");
            }
            cachedKeys = {
              expiresAt: now + 60 * 60 * 1000,
              values: keys.keys as Array<
                JsonWebKey & { endorsements?: string[] | undefined; kid?: string }
              >,
            };
          }
          const key = cachedKeys.values.find((candidate) => candidate.kid === header.kid);
          if (!key) {
            throw new Error("Bot Connector JWT signing key is unknown.");
          }
          if (
            channelId &&
            key.endorsements &&
            key.endorsements.length > 0 &&
            !key.endorsements.includes(channelId)
          ) {
            throw new Error("Bot Connector JWT key does not endorse the activity channel.");
          }
          return createPublicKey({ format: "jwk", key });
        },
        token,
      });
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
    const authenticateWebhookRequest = createMsTeamsWebhookAuthenticator(
      config,
      (runtime as MsTeamsAuthRuntime | undefined) ?? {},
    );
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
  const conversationId = conversation ? optionalString(conversation, "id") : undefined;
  const text = optionalString(payload, "text");
  if (!conversationId || !text) {
    throw new CrablineError("Microsoft Teams activity payload requires conversation.id and text", {
      kind: "inbound",
    });
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
