import { describe, expect, it } from "vitest";
import { ManifestSchema } from "../src/config/schema.js";

const TIMER_MAX_ERROR = "timer duration must be at most 2147483647ms";
const TIMER_CONFIG_CASES = [
  {
    field: "discord.gatewayDurationMs",
    path: ["providers", "timer", "discord", "gatewayDurationMs"],
    provider: (value: number) => ({
      adapter: "discord",
      discord: { gatewayDurationMs: value },
    }),
  },
  {
    field: "imessage.gatewayDurationMs",
    path: ["providers", "timer", "imessage", "gatewayDurationMs"],
    provider: (value: number) => ({
      adapter: "imessage",
      imessage: { gatewayDurationMs: value },
    }),
  },
  {
    field: "msteams.dialogOpenTimeoutMs",
    path: ["providers", "timer", "msteams", "dialogOpenTimeoutMs"],
    provider: (value: number) => ({
      adapter: "msteams",
      msteams: { dialogOpenTimeoutMs: value },
    }),
  },
  {
    field: "telegram.longPolling.retryDelayMs",
    path: ["providers", "timer", "telegram", "longPolling", "retryDelayMs"],
    provider: (value: number) => ({
      adapter: "telegram",
      telegram: { longPolling: { retryDelayMs: value } },
    }),
  },
  {
    field: "mattermost.websocket.maxReconnectDelayMs",
    path: ["providers", "timer", "mattermost", "websocket", "maxReconnectDelayMs"],
    provider: (value: number) => ({
      adapter: "mattermost",
      mattermost: { websocket: { maxReconnectDelayMs: value } },
    }),
  },
  {
    field: "mattermost.websocket.reconnectDelayMs",
    path: ["providers", "timer", "mattermost", "websocket", "reconnectDelayMs"],
    provider: (value: number) => ({
      adapter: "mattermost",
      mattermost: { websocket: { reconnectDelayMs: value } },
    }),
  },
] as const;

describe("manifest schema", () => {
  it("rejects regex syntax unsupported by the linear-time matcher", () => {
    for (const pattern of [String.raw`^(a)\1$`, "(?=a)a"]) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [
            {
              id: "unsafe-regex",
              inboundMatch: { nonce: "ignore", pattern, strategy: "regex" },
              mode: "roundtrip",
              provider: "local",
              target: { id: "echo-bot" },
            },
          ],
          providers: { local: { adapter: "loopback", platform: "loopback" } },
        }),
      ).toThrow(/inboundMatch\.pattern/u);
    }
  });

  it("accepts linear-time alternation and repetition", () => {
    for (const pattern of [
      "^(yes|no)$",
      "^message-[0-9]+$",
      "^a{1,20}$",
      "^(a+)+$",
      `^${"(a|aa)".repeat(80)}$`,
    ]) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [
            {
              id: "safe-regex",
              inboundMatch: { nonce: "ignore", pattern, strategy: "regex" },
              mode: "roundtrip",
              provider: "local",
              target: { id: "echo-bot" },
            },
          ],
          providers: { local: { adapter: "loopback", platform: "loopback" } },
        }),
      ).not.toThrow();
    }
  });

  it("rejects exact static patterns that also require a generated nonce", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "impossible-exact-match",
            inboundMatch: {
              nonce: "contains",
              pattern: "static response",
              strategy: "exact",
            },
            mode: "roundtrip",
            provider: "local",
            target: { id: "echo-bot" },
          },
        ],
        providers: { local: { adapter: "loopback" } },
      }),
    ).toThrow(/strategy=exact requires inboundMatch\.nonce=ignore/u);
  });

  it("rejects exact static patterns for agent acknowledgements", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "impossible-agent-exact",
            inboundMatch: {
              nonce: "ignore",
              pattern: "ACK",
              strategy: "exact",
            },
            mode: "agent",
            provider: "local",
            target: { id: "agent-bot" },
          },
        ],
        providers: { local: { adapter: "loopback" } },
      }),
    ).toThrow(/agent mode cannot use inboundMatch\.strategy=exact/u);
  });

  it("accepts only HTTP(S) provider endpoint URLs", () => {
    for (const apiUrl of [
      "data:text/plain,hello",
      "file:///tmp/provider",
      "mailto:test@example.com",
    ]) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [],
          providers: {
            whatsapp: {
              adapter: "whatsapp",
              whatsapp: { apiUrl },
            },
          },
        }),
      ).toThrow(/URL must use http or https/u);
    }
  });

  it("requires slash-prefixed webhook paths", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "slack",
            slack: { webhook: { path: "slack/events" } },
          },
        },
      }),
    ).toThrow(/webhook path must start with \//u);
  });

  it.each([" ", "\t", " secret "])(
    "rejects non-canonical Zalo header credentials: %j",
    (secret) => {
      for (const field of ["botToken", "webhookSecret"] as const) {
        expect(() =>
          ManifestSchema.parse({
            configVersion: 1,
            fixtures: [],
            providers: {
              zalo: {
                adapter: "zalo",
                zalo: { [field]: secret },
              },
            },
          }),
        ).toThrow(/secret must/u);
      }
    },
  );

  it("accepts canonical Zalo header credentials", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          zalo: {
            adapter: "zalo",
            zalo: { botToken: "placeholder", webhookSecret: "placeholder" },
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    "/slack/../events",
    "/slack\\events",
    "//example.test/events",
    "/slack events",
    "/slack/events?challenge=1",
    "/slack/events#fragment",
  ])("rejects webhook paths changed by URL normalization: %s", (webhookPath) => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "slack",
            slack: { webhook: { path: webhookPath } },
          },
        },
      }),
    ).toThrow(/webhook path must be a canonical URL pathname/u);
  });

  it("requires HTTPS for public Microsoft Teams webhooks", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          msteams: {
            adapter: "msteams",
            msteams: {
              appId: "teams-app",
              webhook: { publicUrl: "http://teams.example.test/webhook" },
            },
          },
        },
      }),
    ).toThrow(/URL must use https/u);
  });

  it("rejects unsupported external ingress in strict manifests", () => {
    for (const adapter of ["matrix", "mattermost", "imessage"] as const) {
      for (const webhook of [
        { host: "0.0.0.0" },
        { publicUrl: `https://${adapter}.example.test/webhook` },
      ]) {
        expect(() =>
          ManifestSchema.parse({
            configVersion: 1,
            fixtures: [],
            providers: {
              provider: {
                adapter,
                [adapter]: {
                  webhook,
                },
              },
            },
          }),
        ).toThrow(/does not support external webhook ingress/u);
      }
    }
  });

  it("accepts equivalent IPv6 loopback hosts for local-only ingress", () => {
    for (const host of [
      "0:0:0:0:0:0:0:1",
      "[0:0:0:0:0:0:0:1]",
      "0:0:0:0:0:ffff:7f00:1",
      "localhost.",
      "fixture.localhost.",
    ]) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [],
          providers: {
            matrix: {
              adapter: "matrix",
              matrix: { webhook: { host } },
            },
          },
        }),
      ).not.toThrow();
    }
  });

  it("rejects header-invalid Zalo secrets", () => {
    for (const [field, value] of [
      ["botToken", "token\r\nx-injected: yes"],
      ["webhookSecret", `secret${String.fromCharCode(0)}`],
    ] as const) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [],
          providers: {
            zalo: {
              adapter: "zalo",
              zalo: { [field]: value },
            },
          },
        }),
      ).toThrow(/valid HTTP header value/u);
    }
  });

  it("rejects control characters in Telegram webhook secrets", () => {
    const tokenField = ["secret", "Token"].join("");
    for (const invalidValue of [
      "value\r\nx-injected: yes",
      "value\n",
      `value${String.fromCharCode(0)}`,
      `value${String.fromCharCode(1)}`,
    ]) {
      expect(() =>
        ManifestSchema.parse({
          configVersion: 1,
          fixtures: [],
          providers: {
            telegram: {
              adapter: "telegram",
              telegram: { [tokenField]: invalidValue },
            },
          },
        }),
      ).toThrow(/Telegram secretToken/u);
    }
  });

  it("caps fixture retries", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "too-many-retries",
            mode: "send",
            provider: "local",
            retries: 11,
            target: { id: "sink" },
          },
        ],
        providers: { local: { adapter: "loopback" } },
      }),
    ).toThrow(/<=10/u);
  });

  it("requires a service-account identity for Google Chat Pub/Sub audiences", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          googlechat: {
            adapter: "googlechat",
            googlechat: {
              pubsubAudience: "https://chat.example.test/webhook",
            },
          },
        },
      }),
    ).toThrow(/requires a Pub\/Sub service-account identity/u);

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          googlechat: {
            adapter: "googlechat",
            googlechat: {
              credentials: {
                client_email: "push@example.iam.gserviceaccount.com",
                private_key: "secret",
              },
              pubsubAudience: "https://chat.example.test/webhook",
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("allows Google Chat Pub/Sub audiences when signature verification is disabled", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          googlechat: {
            adapter: "googlechat",
            googlechat: {
              disableSignatureVerification: true,
              pubsubAudience: "https://chat.example.test/webhook",
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts the documented thread target shape", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "slack-thread",
            mode: "send",
            provider: "slack",
            target: {
              channelId: "C1234567890",
              id: "C1234567890",
              threadId: "1700000000.000100",
            },
          },
        ],
        providers: { slack: { adapter: "slack" } },
      }),
    ).not.toThrow();
  });

  it("rejects loopback delays beyond the Node timer ceiling", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          local: {
            adapter: "loopback",
            loopback: { delayMs: 2_147_483_648 },
          },
        },
      }),
    ).toThrow(TIMER_MAX_ERROR);
  });

  it.each(TIMER_CONFIG_CASES)(
    "rejects $field beyond the Node timer ceiling",
    ({ path, provider }) => {
      const result = ManifestSchema.safeParse({
        configVersion: 1,
        fixtures: [],
        providers: { timer: provider(2_147_483_648) },
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected timer validation to fail");
      }
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          message: TIMER_MAX_ERROR,
          path,
        }),
      ]);
    },
  );

  it.each(TIMER_CONFIG_CASES)("accepts $field at the Node timer ceiling", ({ provider }) => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: { timer: provider(2_147_483_647) },
      }),
    ).not.toThrow();
  });

  it("rejects fixture ids that cannot be embedded in nonces", () => {
    for (const id of ["foo_bar", "foo.bar", "foo bar", "foo\n"]) {
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

  it("rejects empty provider identifiers", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: { "": { adapter: "loopback" } },
      }),
    ).toThrow(/Too small/u);
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

  it("rejects fixture timeouts above Node's timer ceiling", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [
          {
            id: "oversized-timeout",
            mode: "send",
            provider: "local",
            target: { id: "sink-bot" },
            timeoutMs: 2_147_483_648,
          },
        ],
        providers: { local: { adapter: "loopback" } },
      }),
    ).toThrow(TIMER_MAX_ERROR);
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

  it("rejects whitespace-only script commands", () => {
    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures: [],
        providers: {
          slack: {
            adapter: "script",
            capabilities: ["send"],
            platform: "slack",
            script: {
              commands: {
                send: " \t\n ",
              },
            },
          },
        },
      }),
    ).toThrow(/script command must not be blank/u);
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
            encryptKey: "feishu-encrypt-key",
            verificationToken: "sample",
          },
        },
        googlechat: {
          adapter: "googlechat",
          googlechat: {
            disableSignatureVerification: true,
            pubsubServiceAccountEmail: "push@example.iam.gserviceaccount.com",
          },
        },
        mattermost: {
          adapter: "mattermost",
          mattermost: {
            baseUrl: "https://mattermost.example.com",
            webhookToken: "sample",
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
    expect(manifest.providers["feishu"]?.feishu?.encryptKey).toBe("feishu-encrypt-key");
    expect(manifest.providers["feishu"]?.platform).toBe("feishu");
    expect(manifest.providers["googlechat"]?.googlechat?.pubsubServiceAccountEmail).toBe(
      "push@example.iam.gserviceaccount.com",
    );
    expect(manifest.providers["googlechat"]?.googlechat?.webhook.port).toBe(8792);
    expect(manifest.providers["googlechat"]?.platform).toBe("googlechat");
    expect(manifest.providers["mattermost"]?.mattermost?.webhook.path).toBe("/mattermost/webhook");
    expect(manifest.providers["mattermost"]?.mattermost?.webhookToken).toBe("sample");
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
