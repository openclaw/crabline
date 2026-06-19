import path from "node:path";
import type { ProviderConfig } from "../../config/schema.js";
import { createGenericLocalMockTargetCodec, LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";

export function resolveMatrixAdapterConfig(
  config: ProviderConfig,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    auth: config.matrix?.auth ?? {
      accessToken: env.MATRIX_ACCESS_TOKEN ?? "local-mock-matrix-token",
      type: "accessToken" as const,
      userID: `@${userName}:matrix.local`,
    },
    baseURL: config.matrix?.baseURL ?? env.MATRIX_BASE_URL ?? "http://matrix.local",
    commandPrefix: config.matrix?.commandPrefix,
    recoveryKey: config.matrix?.recoveryKey ?? env.MATRIX_RECOVERY_KEY,
  };
}

export class MatrixProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
  constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown) {
    super({
      codec: createGenericLocalMockTargetCodec("matrix"),
      config,
      id,
      options: {
        defaultWebhook: { host: "127.0.0.1", path: "/matrix/webhook", port: 8797 },
        endpointLabel: "webhook endpoint",
        platform: "matrix",
        publicUrl: config.matrix?.webhook.publicUrl,
        recorderPath: config.matrix?.recorder.path
          ? path.resolve(config.matrix.recorder.path)
          : undefined,
        webhook: config.matrix?.webhook,
      },
    });
  }
}
