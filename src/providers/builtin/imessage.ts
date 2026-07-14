import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
import { getBuiltinTargetCodec, IMESSAGE_THREAD_RULE } from "../target-normalizers.js";
import {
  authorFromBotFlag,
  genericMockPayloadWithNativeThread,
  isRecord,
  optionalRecord,
  optionalString,
  requireNativeInboundId,
} from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";

export function resolveIMessageAdapterConfig(config: ProviderConfig, env?: NodeJS.ProcessEnv) {
  const local = config.imessage?.local ?? true;
  const resolvedEnv = env ?? (local ? {} : process.env);
  return {
    apiKey:
      config.imessage?.apiKey ?? resolvedEnv.IMESSAGE_API_KEY ?? "local-mock-imessage-api-key",
    local,
    serverUrl: config.imessage?.serverUrl ?? resolvedEnv.IMESSAGE_SERVER_URL,
  };
}

function isNativeIMessageData(data: Record<string, unknown>): boolean {
  return [
    "chat_guid",
    "chat_identifier",
    "chatGuid",
    "chatIdentifier",
    "guid",
    "is_from_me",
    "isFromMe",
  ].some((key) => key in data);
}

function iMessageNativeData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = optionalRecord(payload, "data") ?? payload;
  const message = optionalRecord(data, "message");
  if (message && isNativeIMessageData(message)) {
    return message;
  }
  return data;
}

function iMessageThreadIdentifiers(data: Record<string, unknown>): string[] {
  return [
    optionalString(data, "chatGuid"),
    optionalString(data, "chatIdentifier"),
    optionalString(data, "chat_guid"),
    optionalString(data, "chat_identifier"),
  ].filter((value): value is string => value !== undefined);
}

export class IMessageProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    requireExternalWebhookAuthentication({
      authenticated: false,
      provider: "iMessage",
      requirement:
        "a provider-native authenticated ingress mode, which this adapter does not support",
      webhook: config.imessage?.webhook,
    });
    super({
      codec: getBuiltinTargetCodec("imessage"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/imessage/webhook", port: 8796 },
        endpointLabel: "webhook endpoint",
        matchesThread: matchesIMessageThread,
        normalizeWebhookPayload: normalizeIMessageWebhookPayload,
        platform: "imessage",
        publicUrl: config.imessage?.webhook.publicUrl,
        recorderPath: config.imessage?.recorder.path
          ? path.resolve(config.imessage.recorder.path)
          : undefined,
        webhook: config.imessage?.webhook,
      },
    });
  }
}

export function matchesIMessageThread(
  candidateThreadId: string,
  expectedThreadId: string | undefined,
  target: { channelId?: string | undefined; id: string },
  raw?: unknown,
): boolean {
  const rawPayload = isRecord(raw) ? raw : undefined;
  const data = rawPayload ? iMessageNativeData(rawPayload) : undefined;
  const aliases = data ? iMessageThreadIdentifiers(data) : [];
  const expectedIdentifiers = new Set([target.channelId ?? target.id]);
  if (expectedThreadId !== undefined) {
    expectedIdentifiers.add(expectedThreadId);
  }
  return (
    expectedIdentifiers.has(candidateThreadId) ||
    aliases.some((alias) => expectedIdentifiers.has(alias))
  );
}

function normalizeIMessageWebhookPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw new CrablineError("iMessage webhook payload must be an object", { kind: "inbound" });
  }

  const message = optionalRecord(payload, "message");
  if (message && !isNativeIMessageData(message)) {
    return genericMockPayloadWithNativeThread({
      channelRule: IMESSAGE_THREAD_RULE,
      payload,
      threadRule: IMESSAGE_THREAD_RULE,
    });
  }

  const data = iMessageNativeData(payload);
  const threadId = iMessageThreadIdentifiers(data)[0];
  const text = optionalString(data, "text") ?? optionalString(data, "message");
  if (!threadId || !text) {
    throw new CrablineError(
      "iMessage webhook payload requires chatGuid or chatIdentifier (including native snake_case aliases) and text",
      {
        kind: "inbound",
      },
    );
  }

  return {
    author: authorFromBotFlag(data.isFromMe === true || data.is_from_me === true),
    ...(optionalString(data, "guid") ? { id: optionalString(data, "guid") } : {}),
    raw: payload,
    text,
    threadId: requireNativeInboundId(threadId, IMESSAGE_THREAD_RULE, "iMessage chatGuid"),
  };
}
