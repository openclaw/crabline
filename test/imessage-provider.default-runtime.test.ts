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

describe("imessage provider default runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps remote gateway metadata optional for the local mock", () => {
    vi.stubEnv("IMESSAGE_API_KEY", "ambient-api-key");
    vi.stubEnv("IMESSAGE_SERVER_URL", "https://ambient-imessage.example.com");

    expect(resolveIMessageAdapterConfig(createConfig())).toEqual({
      apiKey: "local-mock-imessage-api-key",
      local: true,
      serverUrl: undefined,
    });
  });

  it("accepts an explicitly isolated environment", () => {
    expect(
      resolveIMessageAdapterConfig(createConfig(), {
        IMESSAGE_API_KEY: "isolated-api-key",
        IMESSAGE_SERVER_URL: "https://isolated-imessage.example.com",
      }),
    ).toEqual({
      apiKey: "isolated-api-key",
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
});
