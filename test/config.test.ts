import { describe, expect, it } from "vitest";
import { ManifestSchema } from "../src/config/schema.js";

describe("manifest schema", () => {
  it("rejects fixture ids that cannot be embedded in nonces", () => {
    for (const id of ["foo_bar", "foo.bar", "foo bar"]) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [
            {
              id,
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
        }),
      ).toThrow(/fixture id must contain only letters, numbers, and hyphens/u);
    }
  });

  it("rejects duplicate fixture ids", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "duplicate",
            mode: "send",
            provider: "local",
            target: { id: "first" },
          },
          {
            id: "duplicate",
            mode: "send",
            provider: "local",
            target: { id: "second" },
          },
        ],
        providers: {
          local: {
            adapter: "loopback",
            platform: "loopback",
          },
        },
      }),
    ).toThrow(/duplicate fixture id: duplicate/u);
  });

  it("rejects fixtures that reference unknown providers", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "missing-provider",
            mode: "send",
            provider: "missing",
            target: { id: "sink" },
          },
        ],
        providers: {},
      }),
    ).toThrow(/fixture missing-provider references unknown provider missing/u);
  });

  it("rejects fixture modes outside provider capabilities", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "unsupported-roundtrip",
            mode: "roundtrip",
            provider: "local",
            target: { id: "echo-bot" },
          },
        ],
        providers: {
          local: {
            adapter: "loopback",
            capabilities: ["probe", "send"],
          },
        },
      }),
    ).toThrow(
      /fixture unsupported-roundtrip uses mode roundtrip, but provider local declares capabilities probe, send/u,
    );
  });

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

  it("rejects unknown keys throughout user-authored config", () => {
    const base = {
      configVersion: 1,
      fixtures: [
        {
          id: "loopback-send",
          mode: "send",
          provider: "local",
          target: { id: "sink-bot" },
        },
      ],
      providers: {
        local: {
          adapter: "loopback",
          loopback: {},
        },
      },
    };
    const candidates = [
      { ...base, typo: true },
      {
        ...base,
        providers: {
          local: {
            ...base.providers.local,
            typo: true,
          },
        },
      },
      {
        ...base,
        fixtures: [
          {
            ...base.fixtures[0],
            target: {
              ...base.fixtures[0]!.target,
              typo: true,
            },
          },
        ],
      },
    ];

    const issueCodes = candidates.map((candidate) => {
      const result = ManifestSchema.safeParse(candidate);
      return result.success ? [] : result.error.issues.map((issue) => issue.code);
    });
    expect(issueCodes).toEqual([
      ["unrecognized_keys"],
      ["unrecognized_keys"],
      ["unrecognized_keys"],
    ]);
  });

  it("allows provider-defined fields in Google credential payloads", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [],
      providers: {
        googlechat: {
          adapter: "googlechat",
          googlechat: {
            credentials: {
              client_email: "bot@example.com",
              private_key: "secret",
              private_key_id: "provider-defined",
            },
          },
        },
      },
    });

    expect(manifest.providers.googlechat?.googlechat?.credentials).toMatchObject({
      private_key_id: "provider-defined",
    });
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

  it("rejects active script providers without commands for their capabilities", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "script",
            platform: "slack",
            script: {
              commands: {},
            },
          },
        },
      }),
    ).toThrow(/script\.commands\.probe/u);
  });

  it("accepts active script providers with commands for their capabilities", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [],
      providers: {
        slack: {
          adapter: "script",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          platform: "slack",
          script: {
            commands: {
              probe: "probe",
              send: "send",
              waitForInbound: "wait",
            },
          },
        },
      },
    });

    expect(manifest.providers.slack?.script?.commands.waitForInbound).toBe("wait");
  });

  it("rejects adapter config blocks for a different built-in adapter", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "slack",
            telegram: {},
          },
        },
      }),
    ).toThrow(/telegram configuration requires adapter=telegram, got adapter=slack/u);
  });

  it("keeps script adapter configuration behind script commands", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "script",
            capabilities: ["probe"],
            platform: "slack",
            script: {
              commands: {
                probe: "probe",
              },
            },
            slack: {},
          },
        },
      }),
    ).toThrow(
      /script adapter cannot use slack configuration; configure provider behavior through script\.commands/u,
    );

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "slack",
            script: {
              commands: {
                probe: "probe",
              },
            },
          },
        },
      }),
    ).toThrow(/script configuration requires adapter=script, got adapter=slack/u);
  });

  it("parses a built-in slack provider with webhook defaults", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [
        {
          id: "slack-agent",
          mode: "agent",
          provider: "slack",
          target: {
            channelId: "C1234567890",
            id: "C1234567890",
          },
        },
      ],
      providers: {
        slack: {
          adapter: "slack",
          slack: {},
        },
      },
    });

    expect(manifest.providers["slack"]?.platform).toBe("slack");
    expect(manifest.providers["slack"]?.slack?.webhook.port).toBe(8787);
    expect(manifest.providers["slack"]?.slack?.webhook.path).toBe("/slack/events");
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

  it("parses built-in telegram, whatsapp, feishu, googlechat, mattermost, msteams, and zalo provider config", () => {
    const manifest = ManifestSchema.parse({
      configVersion: 1,
      fixtures: [
        {
          id: "telegram-dm",
          mode: "roundtrip",
          provider: "telegram",
          target: { id: "user-123" },
        },
        {
          id: "whatsapp-dm",
          mode: "roundtrip",
          provider: "whatsapp",
          target: { id: "15551234567" },
        },
        {
          id: "feishu-chat",
          mode: "roundtrip",
          provider: "feishu",
          target: { id: "oc_123" },
        },
        {
          id: "googlechat-space",
          mode: "roundtrip",
          provider: "googlechat",
          target: { id: "spaces/AAAA1234567" },
        },
        {
          id: "mattermost-channel",
          mode: "roundtrip",
          provider: "mattermost",
          target: { id: "channel-id" },
        },
        {
          id: "msteams-channel",
          mode: "roundtrip",
          provider: "msteams",
          target: {
            id: "19:conversation@thread.v2",
            metadata: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
          },
        },
        {
          id: "zalo-chat",
          mode: "roundtrip",
          provider: "zalo",
          target: { id: "chat-123" },
        },
      ],
      providers: {
        feishu: {
          adapter: "feishu",
          feishu: {
            appId: "feishu-app",
          },
        },
        googlechat: {
          adapter: "googlechat",
          googlechat: {
            disableSignatureVerification: true,
          },
        },
        mattermost: {
          adapter: "mattermost",
          mattermost: {
            baseUrl: "https://mattermost.example.com",
          },
        },
        msteams: {
          adapter: "msteams",
          msteams: {
            appId: "teams-app",
          },
        },
        telegram: {
          adapter: "telegram",
          telegram: {
            mode: "polling",
          },
        },
        whatsapp: {
          adapter: "whatsapp",
          whatsapp: {
            phoneNumberId: "1234567890",
          },
        },
        zalo: {
          adapter: "zalo",
          zalo: {
            botToken: "zalo-token",
          },
        },
      },
    });

    expect(manifest.providers["feishu"]?.feishu?.recorder).toEqual({});
    expect(manifest.providers["feishu"]?.platform).toBe("feishu");
    expect(manifest.providers["googlechat"]?.googlechat?.webhook.port).toBe(8792);
    expect(manifest.providers["googlechat"]?.platform).toBe("googlechat");
    expect(manifest.providers["mattermost"]?.mattermost?.webhook.path).toBe("/mattermost/webhook");
    expect(manifest.providers["mattermost"]?.platform).toBe("mattermost");
    expect(manifest.providers["msteams"]?.msteams?.webhook.path).toBe("/msteams/webhook");
    expect(manifest.providers["msteams"]?.platform).toBe("msteams");
    expect(manifest.providers["telegram"]?.telegram?.webhook.port).toBe(8790);
    expect(manifest.providers["telegram"]?.telegram?.mode).toBe("polling");
    expect(manifest.providers["telegram"]?.platform).toBe("telegram");
    expect(manifest.providers["whatsapp"]?.whatsapp?.webhook.path).toBe("/whatsapp/webhook");
    expect(manifest.providers["whatsapp"]?.platform).toBe("whatsapp");
    expect(manifest.providers["zalo"]?.zalo?.webhook.port).toBe(8794);
    expect(manifest.providers["zalo"]?.platform).toBe("zalo");
  });

  it("rejects built-in telegram, whatsapp, feishu, googlechat, mattermost, msteams, and zalo adapters on the wrong platform", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          feishu: {
            adapter: "feishu",
            platform: "zalo",
          },
        },
      }),
    ).toThrow(/feishu adapter must use platform=feishu/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          googlechat: {
            adapter: "googlechat",
            platform: "msteams",
          },
        },
      }),
    ).toThrow(/googlechat adapter must use platform=googlechat/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          mattermost: {
            adapter: "mattermost",
            platform: "feishu",
          },
        },
      }),
    ).toThrow(/mattermost adapter must use platform=mattermost/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          msteams: {
            adapter: "msteams",
            platform: "googlechat",
          },
        },
      }),
    ).toThrow(/msteams adapter must use platform=msteams/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          telegram: {
            adapter: "telegram",
            platform: "discord",
          },
        },
      }),
    ).toThrow(/telegram adapter must use platform=telegram/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          whatsapp: {
            adapter: "whatsapp",
            platform: "telegram",
          },
        },
      }),
    ).toThrow(/whatsapp adapter must use platform=whatsapp/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          zalo: {
            adapter: "zalo",
            platform: "zalouser",
          },
        },
      }),
    ).toThrow(/zalo adapter must use platform=zalo/u);
  });

  it("requires platform only for script providers", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "script",
            script: {
              commands: {},
            },
          },
        },
      }),
    ).toThrow(/script adapter requires platform/u);
  });
});
