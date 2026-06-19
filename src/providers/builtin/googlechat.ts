import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

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

export class GoogleChatProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("googlechat"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
        endpointLabel: "webhook endpoint",
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
