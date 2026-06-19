import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

export function resolveMattermostAdapterConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    baseUrl: config.mattermost?.baseUrl ?? env.MATTERMOST_BASE_URL ?? "http://mattermost.local",
    botToken: config.mattermost?.botToken ?? env.MATTERMOST_BOT_TOKEN ?? "local-mock-token",
    userName: config.mattermost?.userName,
  };
}

export class MattermostProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("mattermost"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/mattermost/webhook", port: 8793 },
        endpointLabel: "webhook endpoint",
        platform: "mattermost",
        publicUrl: config.mattermost?.webhook.publicUrl,
        recorderPath: config.mattermost?.recorder.path
          ? path.resolve(config.mattermost.recorder.path)
          : undefined,
        webhook: config.mattermost?.webhook,
      },
    });
  }
}
