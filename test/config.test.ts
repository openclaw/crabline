import { describe, expect, it } from "vitest";
import { ManifestSchema } from "../src/config/schema.js";

describe("manifest schema", () => {
  it("parses a valid loopback fixture", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [
        {
          id: "loopback-roundtrip",
          mode: "roundtrip",
          provider: "local",
          target: { id: "echo-bot" },
        },
      ],
      providers: {
        local: {
          adapter: "loopback",
          platform: "loopback",
        },
      },
    });

    expect(manifest.fixtures[0]?.timeoutMs).toBe(30_000);
    expect(manifest.fixtures[0]?.inboundMatch.author).toBe("assistant");
  });

  it("rejects script providers without script config", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "script",
            platform: "slack",
          },
        },
      }),
    ).toThrow(/script adapter requires a script configuration/);
  });

  it("parses a native slack provider with webhook defaults", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [
        {
          id: "slack-agent",
          mode: "agent",
          provider: "slack-native",
          target: {
            channelId: "C1234567890",
            id: "C1234567890",
          },
        },
      ],
      providers: {
        "slack-native": {
          adapter: "slack",
          platform: "slack",
          slack: {},
        },
      },
    });

    expect(manifest.providers["slack-native"]?.slack?.webhook.port).toBe(8787);
    expect(manifest.providers["slack-native"]?.slack?.webhook.path).toBe("/slack/events");
  });

  it("rejects slack providers on the wrong platform", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "slack",
            platform: "discord",
          },
        },
      }),
    ).toThrow(/slack adapter must use platform=slack/);
  });

  it("parses discord, matrix, and imessage provider config", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [],
      providers: {
        discord: {
          adapter: "discord",
          discord: {
            applicationId: "123456789012345678",
            gatewayDurationMs: 60_000,
            publicKey: "a".repeat(64),
            webhook: {
              path: "/discord/interactions",
              port: 8788,
            },
          },
          platform: "discord",
        },
        imessage: {
          adapter: "imessage",
          imessage: {
            gatewayDurationMs: 60_000,
            local: false,
            serverUrl: "https://example.com",
          },
          platform: "imessage",
        },
        matrix: {
          adapter: "matrix",
          matrix: {
            auth: {
              accessToken: "token",
              type: "accessToken",
            },
            baseURL: "https://matrix.example.com",
          },
          platform: "matrix",
        },
      },
    });

    expect(manifest.providers.discord?.discord?.gatewayDurationMs).toBe(60_000);
    expect(manifest.providers.matrix?.matrix?.baseURL).toBe("https://matrix.example.com");
    expect(manifest.providers.imessage?.imessage?.gatewayDurationMs).toBe(60_000);
  });

  it("rejects partial matrix auth config", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          matrix: {
            adapter: "matrix",
            matrix: {
              auth: {
                type: "password",
                username: "bot",
              },
              baseURL: "https://matrix.example.com",
            },
            platform: "matrix",
          },
        },
      }),
    ).toThrow(/password/u);
  });

  it("rejects discord adapter on a non-discord platform", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          discord: {
            adapter: "discord",
            platform: "slack",
          },
        },
      }),
    ).toThrow(/discord adapter must use platform=discord/u);
  });

  it("parses the local Telegram channel config", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [
        {
          id: "telegram-local-dm",
          mode: "roundtrip",
          provider: "telegram-local",
          target: { id: "user-123" },
        },
      ],
      providers: {
        "telegram-local": {
          adapter: "channel",
          channel: {
            qaResponse: { mode: "ack" },
          },
          platform: "telegram",
        },
      },
    });

    expect(manifest.providers["telegram-local"]?.platform).toBe("telegram");
    expect(manifest.providers["telegram-local"]?.channel?.qaResponse.mode).toBe("ack");
  });

  it("parses the local WhatsApp channel config", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [
        {
          id: "whatsapp-local-dm",
          mode: "roundtrip",
          provider: "whatsapp-local",
          target: { id: "15551230001" },
        },
      ],
      providers: {
        "whatsapp-local": {
          adapter: "channel",
          channel: {
            qaResponse: { mode: "ack" },
          },
          platform: "whatsapp",
        },
      },
    });

    expect(manifest.providers["whatsapp-local"]?.platform).toBe("whatsapp");
    expect(manifest.providers["whatsapp-local"]?.channel?.qaResponse.mode).toBe("ack");
  });

  it("rejects channel adapters on platforms without a local driver", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          discord: {
            adapter: "channel",
            platform: "discord",
          },
        },
      }),
    ).toThrow(/channel adapter currently supports platform=telegram or platform=whatsapp/u);
  });
});
