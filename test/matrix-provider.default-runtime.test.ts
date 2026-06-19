import { describe, expect, it } from "vitest";
import { resolveMatrixAdapterConfig } from "../src/providers/builtin/matrix.js";
import type { ProviderConfig } from "../src/config/schema.js";

function createConfig(matrix?: Partial<NonNullable<ProviderConfig["matrix"]>>): ProviderConfig {
  return {
    adapter: "matrix",
    capabilities: ["probe"],
    env: [],
    matrix: {
      recorder: {},
      webhook: {
        host: "127.0.0.1",
        path: "/matrix/webhook",
        port: 8797,
      },
      ...matrix,
    },
    platform: "matrix",
    status: "active",
  };
}

describe("matrix provider default runtime", () => {
  it("uses local mock defaults when live Matrix auth is absent", () => {
    expect(resolveMatrixAdapterConfig(createConfig(), "crabline", {})).toEqual({
      auth: {
        accessToken: "local-mock-matrix-token",
        type: "accessToken",
        userID: "@crabline:matrix.local",
      },
      baseURL: "http://matrix.local",
      commandPrefix: undefined,
      recoveryKey: undefined,
    });
  });

  it("preserves configured Matrix metadata when provided", () => {
    expect(
      resolveMatrixAdapterConfig(
        createConfig({
          auth: {
            password: "secret",
            type: "password",
            userID: "@bot:example.com",
            username: "bot",
          },
          baseURL: "https://matrix.example.com",
          commandPrefix: "!",
          recoveryKey: "recovery",
        }),
        "crabline",
      ),
    ).toEqual({
      auth: {
        password: "secret",
        type: "password",
        userID: "@bot:example.com",
        username: "bot",
      },
      baseURL: "https://matrix.example.com",
      commandPrefix: "!",
      recoveryKey: "recovery",
    });
  });
});
