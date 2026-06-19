import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

export function resolveWhatsAppAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    accessToken: config.whatsapp?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN ?? "local-mock-token",
    appSecret: config.whatsapp?.appSecret ?? env.WHATSAPP_APP_SECRET ?? "local-mock-secret",
    phoneNumberId:
      config.whatsapp?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID ?? "local-mock-phone",
    verifyToken: config.whatsapp?.verifyToken ?? env.WHATSAPP_VERIFY_TOKEN ?? "local-mock-verify",
  };
}

export class WhatsAppProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("whatsapp"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/whatsapp/webhook", port: 8789 },
        endpointLabel: "webhook endpoint",
        platform: "whatsapp",
        publicUrl: config.whatsapp?.webhook.publicUrl,
        recorderPath: config.whatsapp?.recorder.path
          ? path.resolve(config.whatsapp.recorder.path)
          : undefined,
        webhook: config.whatsapp?.webhook,
      },
    });
  }
}
