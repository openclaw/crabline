import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

export function resolveFeishuAdapterConfig(
  config: ProviderConfig,
  _env: NodeJS.ProcessEnv = process.env,
) {
  return {
    appId: config.feishu?.appId ?? "local-mock-feishu-app",
    userName: config.feishu?.userName,
  };
}

export class FeishuProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("feishu"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/feishu/webhook", port: 8795 },
        endpointLabel: "webhook endpoint",
        platform: "feishu",
        publicUrl: config.feishu?.webhook.publicUrl,
        recorderPath: config.feishu?.recorder.path
          ? path.resolve(config.feishu.recorder.path)
          : undefined,
        webhook: config.feishu?.webhook,
      },
    });
  }
}
