import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

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
      codec: createGenericLocalMockTargetCodec("msteams"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/msteams/webhook", port: 8791 },
        endpointLabel: "webhook endpoint",
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
