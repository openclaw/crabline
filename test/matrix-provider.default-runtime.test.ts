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
      ...matrix,
    },
    platform: "matrix",
    status: "active",
  };
}

describe("matrix provider default runtime", () => {
  it("builds adapter config from explicit password auth", () => {
    const config = createConfig({
      auth: {
        password: "secret",
        type: "password",
        userID: "@bot:example.com",
        username: "bot",
      },
      baseURL: "https://matrix.example.com",
      commandPrefix: "!",
      recoveryKey: "recovery",
      roomAllowlist: ["!room:example.com"],
    });

    expect(resolveMatrixAdapterConfig(config, "crabline")).toEqual({
      auth: {
        password: "secret",
        type: "password",
        userID: "@bot:example.com",
        username: "bot",
      },
      baseURL: "https://matrix.example.com",
      commandPrefix: "!",
      recoveryKey: "recovery",
      roomAllowlist: ["!room:example.com"],
      userName: "crabline",
    });
  });

  it("falls back to env auth and base url", () => {
    const config = createConfig();

    expect(
      resolveMatrixAdapterConfig(config, "crabline", {
        MATRIX_ACCESS_TOKEN: "env-token",
        MATRIX_BASE_URL: "https://env-matrix.example.com",
        MATRIX_PASSWORD: undefined,
        MATRIX_RECOVERY_KEY: undefined,
        MATRIX_USERNAME: undefined,
        MATRIX_USER_ID: "@env:example.com",
      }),
    ).toEqual({
      auth: {
        accessToken: "env-token",
        type: "accessToken",
        userID: "@env:example.com",
      },
      baseURL: "https://env-matrix.example.com",
      userName: "crabline",
    });
  });

  it("fails fast when matrix base url is missing", () => {
    const config = createConfig({
      auth: {
        accessToken: "token",
        type: "accessToken",
      },
    });

    expect(() => resolveMatrixAdapterConfig(config, "crabline")).toThrow(/base URL/u);
  });

  it("fails fast when matrix auth is missing", () => {
    const config = createConfig({
      baseURL: "https://matrix.example.com",
    });

    expect(() => resolveMatrixAdapterConfig(config, "crabline")).toThrow(/auth is required/u);
  });
});
