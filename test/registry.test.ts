import { describe, expect, it } from "vitest";
import type { ManifestDefinition, ProviderConfig } from "../src/config/schema.js";
import { TelegramProviderAdapter } from "../src/providers/builtin/telegram.js";
import { createRegistry } from "../src/providers/registry.js";

const manifest: ManifestDefinition = {
  configVersion: 1,
  fixtures: [
    {
      env: [],
      id: "fixture",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "local",
      retries: 0,
      tags: [],
      target: { id: "echo", metadata: {} },
      timeoutMs: 1000,
    },
  ],
  providers: {
    local: {
      adapter: "loopback",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      platform: "loopback",
      status: "active",
    },
  },
  userName: "crabline",
};

describe("registry", () => {
  it("resolves configured providers", () => {
    const registry = createRegistry(manifest, "/tmp/crabline.yaml");
    const provider = registry.resolve("local", "fixture");
    expect(provider.id).toBe("local");
    expect(provider.status).toBe("ready");
  });

  it("uses configured capabilities and concrete target normalization before loading adapters", () => {
    const config: ProviderConfig = {
      adapter: "telegram",
      capabilities: ["probe"],
      env: [],
      platform: "telegram",
      status: "active",
      telegram: {
        mode: "auto",
        recorder: {},
        webhook: {
          host: "127.0.0.1",
          path: "/telegram/webhook",
          port: 0,
        },
      },
    };
    const fixture = {
      ...manifest.fixtures[0]!,
      id: "telegram-topic",
      mode: "probe" as const,
      provider: "telegram",
      target: {
        id: "-1001234567890",
        metadata: {},
        threadId: "-1001234567890:42",
      },
    };
    const telegramManifest: ManifestDefinition = {
      ...manifest,
      fixtures: [fixture],
      providers: { telegram: config },
    };

    const lazyProvider = createRegistry(telegramManifest, "/tmp/crabline.yaml").resolve(
      "telegram",
      fixture.id,
    );
    const concreteProvider = new TelegramProviderAdapter("telegram", config, "crabline");

    expect(lazyProvider.supports).toEqual(["probe"]);
    expect(concreteProvider.supports).toEqual(["probe"]);
    expect(lazyProvider.normalizeTarget(fixture.target)).toEqual(
      concreteProvider.normalizeTarget(fixture.target),
    );
    expect(lazyProvider.normalizeTarget(fixture.target)).toMatchObject({
      channelId: "-1001234567890",
      threadId: "-1001234567890:42",
    });
  });

  it("applies provider-specific validation through lazy adapters", () => {
    const whatsappManifest: ManifestDefinition = {
      ...manifest,
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          id: "whatsapp-fixture",
          provider: "whatsapp",
          target: { id: "not-a-wa-id", metadata: {} },
        },
      ],
      providers: {
        whatsapp: {
          adapter: "whatsapp",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "whatsapp",
          status: "active",
          whatsapp: {
            recorder: {},
            webhook: {
              host: "127.0.0.1",
              path: "/whatsapp/webhook",
              port: 0,
            },
          },
        },
      },
    };

    const provider = createRegistry(whatsappManifest, "/tmp/crabline.yaml").resolve(
      "whatsapp",
      "whatsapp-fixture",
    );

    expect(() => provider.normalizeTarget(whatsappManifest.fixtures[0]!.target)).toThrow(
      /WhatsApp wa_id/u,
    );
  });

  it("throws for unknown providers", () => {
    const registry = createRegistry(manifest, "/tmp/crabline.yaml");
    expect(() => registry.resolve("missing", "fixture")).toThrow(/Unknown provider/);
  });

  it("throws for disabled providers", () => {
    const localProvider = manifest.providers.local;
    expect(localProvider).toBeDefined();

    const disabledManifest: ManifestDefinition = {
      ...manifest,
      providers: {
        local: {
          ...localProvider!,
          status: "disabled",
        },
      },
    };
    const registry = createRegistry(disabledManifest, "/tmp/crabline.yaml");
    expect(() => registry.resolve("local", "fixture")).toThrow(/disabled/);
  });

  it("resolves built-in slack providers", () => {
    const slackManifest: ManifestDefinition = {
      ...manifest,
      providers: {
        slack: {
          adapter: "slack",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "slack",
          slack: {
            recorder: { path: "/tmp/crabline-slack-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/slack/events",
              port: 0,
            },
          },
          status: "active",
        },
      },
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          id: "slack-fixture",
          provider: "slack",
          target: {
            channelId: "C1234567890",
            id: "C1234567890",
            metadata: {},
          },
        },
      ],
    };

    const registry = createRegistry(slackManifest, "/tmp/crabline.yaml");
    const provider = registry.resolve("slack", "slack-fixture");
    expect(provider.id).toBe("slack");
    expect(provider.platform).toBe("slack");
    expect(provider.status).toBe("ready");
  });

  it("resolves built-in discord, matrix, imessage, feishu, googlechat, mattermost, msteams, telegram, whatsapp, and zalo providers", () => {
    const nativeManifest: ManifestDefinition = {
      ...manifest,
      providers: {
        discord: {
          adapter: "discord",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          discord: {
            applicationId: "123456789012345678",
            botToken: "discord-token",
            gatewayDurationMs: 30_000,
            publicKey: "a".repeat(64),
            recorder: { path: "/tmp/crabline-discord-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/discord/interactions",
              port: 8788,
            },
          },
          env: [],
          platform: "discord",
          status: "active",
        },
        feishu: {
          adapter: "feishu",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          feishu: {
            appId: "feishu-app",
            appSecret: "feishu-secret",
            recorder: { path: "/tmp/crabline-feishu-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/feishu/webhook",
              port: 8795,
            },
          },
          platform: "feishu",
          status: "active",
        },
        googlechat: {
          adapter: "googlechat",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          googlechat: {
            credentials: {
              client_email: "bot@example.iam.gserviceaccount.com",
              private_key: "private-key",
            },
            disableSignatureVerification: true,
            recorder: { path: "/tmp/crabline-googlechat-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/googlechat/webhook",
              port: 8792,
            },
          },
          platform: "googlechat",
          status: "active",
        },
        imessage: {
          adapter: "imessage",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          imessage: {
            gatewayDurationMs: 30_000,
            local: true,
            recorder: { path: "/tmp/crabline-imessage-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/imessage/webhook",
              port: 8796,
            },
          },
          platform: "imessage",
          status: "active",
        },
        matrix: {
          adapter: "matrix",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          matrix: {
            auth: { accessToken: "token", type: "accessToken" },
            baseURL: "https://matrix.example.com",
            recorder: { path: "/tmp/crabline-matrix-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/matrix/webhook",
              port: 8797,
            },
          },
          platform: "matrix",
          status: "active",
        },
        mattermost: {
          adapter: "mattermost",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          mattermost: {
            baseUrl: "https://mattermost.example.com",
            botToken: "mattermost-token",
            recorder: { path: "/tmp/crabline-mattermost-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/mattermost/webhook",
              port: 8793,
            },
          },
          platform: "mattermost",
          status: "active",
        },
        msteams: {
          adapter: "msteams",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          msteams: {
            appId: "teams-app",
            appPassword: "teams-secret",
            recorder: { path: "/tmp/crabline-msteams-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/msteams/webhook",
              port: 8791,
            },
          },
          platform: "msteams",
          status: "active",
        },
        telegram: {
          adapter: "telegram",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "telegram",
          status: "active",
          telegram: {
            botToken: "telegram-token",
            mode: "webhook",
            recorder: { path: "/tmp/crabline-telegram-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/telegram/webhook",
              port: 8790,
            },
          },
        },
        whatsapp: {
          adapter: "whatsapp",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "whatsapp",
          status: "active",
          whatsapp: {
            accessToken: "whatsapp-token",
            appSecret: "whatsapp-secret",
            phoneNumberId: "1234567890",
            recorder: { path: "/tmp/crabline-whatsapp-test.jsonl" },
            verifyToken: "verify-token",
            webhook: {
              host: "127.0.0.1",
              path: "/whatsapp/webhook",
              port: 8789,
            },
          },
        },
        zalo: {
          adapter: "zalo",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "zalo",
          status: "active",
          zalo: {
            botToken: "zalo-token",
            recorder: { path: "/tmp/crabline-zalo-test.jsonl" },
            webhook: {
              host: "127.0.0.1",
              path: "/zalo/webhook",
              port: 8794,
            },
            webhookSecret: "zalo-secret",
          },
        },
      },
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          id: "discord-fixture",
          provider: "discord",
          target: {
            id: "123456789012345678",
            metadata: { guildId: "987654321098765432" },
          },
        },
        {
          ...manifest.fixtures[0]!,
          id: "feishu-fixture",
          provider: "feishu",
          target: { id: "oc_123", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "googlechat-fixture",
          provider: "googlechat",
          target: { id: "spaces/AAAA1234567", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "imessage-fixture",
          provider: "imessage",
          target: { id: "chat-guid", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "matrix-fixture",
          provider: "matrix",
          target: { id: "!room:example.com", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "mattermost-fixture",
          provider: "mattermost",
          target: { id: "channel-id", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "msteams-fixture",
          provider: "msteams",
          target: {
            id: "19:conversation@thread.v2",
            metadata: { serviceUrl: "https://smba.trafficmanager.net/amer/" },
          },
        },
        {
          ...manifest.fixtures[0]!,
          id: "telegram-fixture",
          provider: "telegram",
          target: { id: "123456789", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "whatsapp-fixture",
          provider: "whatsapp",
          target: { id: "15551234567", metadata: {} },
        },
        {
          ...manifest.fixtures[0]!,
          id: "zalo-fixture",
          provider: "zalo",
          target: { id: "chat-123", metadata: {} },
        },
      ],
    };

    const registry = createRegistry(nativeManifest, "/tmp/crabline.yaml");
    expect(registry.resolve("discord", "discord-fixture").platform).toBe("discord");
    expect(registry.resolve("feishu", "feishu-fixture").platform).toBe("feishu");
    expect(registry.resolve("googlechat", "googlechat-fixture").platform).toBe("googlechat");
    expect(registry.resolve("imessage", "imessage-fixture").platform).toBe("imessage");
    expect(registry.resolve("matrix", "matrix-fixture").platform).toBe("matrix");
    expect(registry.resolve("mattermost", "mattermost-fixture").platform).toBe("mattermost");
    expect(registry.resolve("msteams", "msteams-fixture").platform).toBe("msteams");
    expect(registry.resolve("telegram", "telegram-fixture").platform).toBe("telegram");
    expect(registry.resolve("whatsapp", "whatsapp-fixture").platform).toBe("whatsapp");
    expect(registry.resolve("zalo", "zalo-fixture").platform).toBe("zalo");
  });
});
