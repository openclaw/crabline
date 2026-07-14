import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageAdapterConfig } from "../src/providers/builtin/imessage.js";
import type { ProviderConfig } from "../src/config/schema.js";

function createConfig(imessage?: Partial<NonNullable<ProviderConfig["imessage"]>>): ProviderConfig {
  return {
    adapter: "imessage",
    capabilities: ["probe"],
    env: [],
    imessage: {
      gatewayDurationMs: 60_000,
      recorder: {},
      webhook: {
        host: "127.0.0.1",
        path: "/imessage/webhook",
        port: 8796,
      },
      ...imessage,
    },
    platform: "imessage",
    status: "active",
  };
}

function createEnvironment(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (apiKey !== undefined) {
    env.IMESSAGE_API_KEY = apiKey;
  }
  return env;
}

describe("imessage provider default runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps remote gateway metadata optional for the local mock", () => {
    vi.stubEnv("IMESSAGE_API_KEY", "sample");
    vi.stubEnv("IMESSAGE_SERVER_URL", "https://ambient-imessage.example.com");

    expect(resolveIMessageAdapterConfig(createConfig())).toEqual({
      apiKey: "local-mock-imessage-api-key",
      local: true,
      serverUrl: undefined,
    });
  });

  it.each([undefined, "", "   "])(
    "uses the mock key for empty local API key values: %j",
    (apiKey) => {
      expect(resolveIMessageAdapterConfig(createConfig(), createEnvironment(apiKey))).toEqual({
        apiKey: "local-mock-imessage-api-key",
        local: true,
        serverUrl: undefined,
      });
    },
  );

  it("accepts an explicitly isolated environment", () => {
    expect(
      resolveIMessageAdapterConfig(createConfig(), {
        IMESSAGE_API_KEY: "test-token-placeholder",
        IMESSAGE_SERVER_URL: "https://isolated-imessage.example.com",
      }),
    ).toEqual({
      apiKey: "test-token-placeholder",
      local: true,
      serverUrl: "https://isolated-imessage.example.com",
    });
  });

  it("preserves configured gateway metadata when provided", () => {
    expect(
      resolveIMessageAdapterConfig(
        createConfig({
          apiKey: "config-api-key",
          local: false,
          serverUrl: "https://imessage.example.com",
        }),
      ),
    ).toEqual({
      apiKey: "config-api-key",
      local: false,
      serverUrl: "https://imessage.example.com",
    });
  });

  it("uses ambient gateway metadata for remote mode", () => {
    vi.stubEnv("IMESSAGE_API_KEY", "sample");
    vi.stubEnv("IMESSAGE_SERVER_URL", "https://ambient-imessage.example.com");

    expect(resolveIMessageAdapterConfig(createConfig({ local: false }))).toEqual({
      apiKey: "sample",
      local: false,
      serverUrl: "https://ambient-imessage.example.com",
    });
  });

  it.each(["", "   "])(
    "falls back to a non-empty environment key when the configured key is blank: %j",
    (apiKey) => {
      expect(
        resolveIMessageAdapterConfig(createConfig({ apiKey, local: false }), {
          IMESSAGE_API_KEY: "test-token-placeholder",
        }),
      ).toEqual({
        apiKey: "test-token-placeholder",
        local: false,
        serverUrl: undefined,
      });
    },
  );

  it("prefers a non-empty configured key over the environment", () => {
    expect(
      resolveIMessageAdapterConfig(createConfig({ apiKey: "sample", local: false }), {
        IMESSAGE_API_KEY: "test-token-placeholder",
      }),
    ).toEqual({
      apiKey: "sample",
      local: false,
      serverUrl: undefined,
    });
  });

  it.each([undefined, "", "   "])(
    "rejects remote mode without a non-empty API key: %j",
    (apiKey) => {
      expect(() =>
        resolveIMessageAdapterConfig(createConfig({ local: false }), createEnvironment(apiKey)),
      ).toThrow(
        expect.objectContaining({
          kind: "config",
          message:
            "Remote iMessage mode requires imessage.apiKey or IMESSAGE_API_KEY to be non-empty.",
        }),
      );
    },
  );
});
