import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

export function resolveZaloAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    botToken: config.zalo?.botToken ?? env.ZALO_BOT_TOKEN ?? "local-mock-zalo-token",
    webhookSecret: config.zalo?.webhookSecret ?? env.ZALO_WEBHOOK_SECRET,
  };
}

export class ZaloProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("zalo"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/zalo/webhook", port: 8794 },
        endpointLabel: "webhook endpoint",
        platform: "zalo",
        publicUrl: config.zalo?.webhook.publicUrl,
        recorderPath: config.zalo?.recorder.path
          ? path.resolve(config.zalo.recorder.path)
          : undefined,
        webhook: config.zalo?.webhook,
      },
    });
  }
}
