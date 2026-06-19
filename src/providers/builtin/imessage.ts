import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

export function resolveIMessageAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    apiKey: config.imessage?.apiKey ?? env.IMESSAGE_API_KEY ?? "local-mock-imessage-api-key",
    local: config.imessage?.local ?? true,
    serverUrl: config.imessage?.serverUrl ?? env.IMESSAGE_SERVER_URL,
  };
}

export class IMessageProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("imessage"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/imessage/webhook", port: 8796 },
        endpointLabel: "webhook endpoint",
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
