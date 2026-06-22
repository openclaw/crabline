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

const MSTEAMS_CONVERSATION_ID_RULE: NativeIdRule = {
  example: "19:meeting_abc@thread.v2",
  name: "Microsoft Teams conversation id",
  pattern: /^19:[^@]+@thread\.[A-Za-z0-9.]+$/u,
};

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

export class MsTeamsProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createNativeTargetCodec({
        channel: MSTEAMS_CONVERSATION_ID_RULE,
        channelLabel: "Microsoft Teams conversation.id",
      }),
      config,
      id,
      options: {
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

function normalizeMsTeamsWebhookPayload(payload: unknown) {
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
