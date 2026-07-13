import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ADAPTERS,
  type ManifestDefinition,
  type ProviderConfig,
} from "../src/config/schema.js";
import { TelegramProviderAdapter } from "../src/providers/builtin/telegram.js";
import { createRegistry } from "../src/providers/registry.js";
import {
  normalizeBuiltinTarget,
  type BuiltinProviderAdapterId,
  ZALO_UNSUPPORTED_THREAD_TARGET_ERROR,
} from "../src/providers/target-normalizers.js";
import type { ProviderContext, SendContext, WaitContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

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

  it("does not execute providers marked as planned", () => {
    const plannedManifest: ManifestDefinition = {
      ...manifest,
      providers: {
        local: {
          ...manifest.providers.local!,
          status: "planned",
        },
      },
    };

    expect(() =>
      createRegistry(plannedManifest, "/tmp/crabline.yaml").resolve("local", "fixture"),
    ).toThrow('Provider "local" is planned and cannot run.');
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

  it("enforces Telegram's native username length in shared target normalization", () => {
    expect(normalizeBuiltinTarget("telegram", { id: "@abcd", metadata: {} })).toMatchObject({
      channelId: "@abcd",
    });
    expect(
      normalizeBuiltinTarget("telegram", { id: `@${"a".repeat(32)}`, metadata: {} }),
    ).toMatchObject({
      channelId: `@${"a".repeat(32)}`,
    });
    for (const id of ["@abc", `@${"a".repeat(33)}`]) {
      expect(() => normalizeBuiltinTarget("telegram", { id, metadata: {} })).toThrow(
        /native Telegram chat id/u,
      );
    }
  });

  it.each([
    [
      "discord",
      {
        channelId: "123456789012345678",
        id: "123456789012345678",
        metadata: {},
        threadId: "223456789012345678",
      },
    ],
    ["feishu", { channelId: "oc_abc123", id: "oc_abc123", metadata: {}, threadId: "om_abc123" }],
    [
      "googlechat",
      {
        channelId: "spaces/AAAABbbbCCC",
        id: "spaces/AAAABbbbCCC",
        metadata: {},
        threadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
      },
    ],
    [
      "imessage",
      {
        channelId: "+15551234567",
        id: "+15551234567",
        metadata: {},
        threadId: "iMessage;-;chat-guid",
      },
    ],
    [
      "loopback",
      {
        channelId: "room-a",
        id: "room-a",
        metadata: {},
        threadId: "loopback:room-a:topic",
      },
    ],
    [
      "matrix",
      {
        channelId: "!abcdef:matrix.org",
        id: "!abcdef:matrix.org",
        metadata: {},
        threadId: "$eventid:matrix.org",
      },
    ],
    [
      "mattermost",
      {
        channelId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        metadata: {},
        threadId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    [
      "msteams",
      {
        channelId: "19:conversation@thread.v2",
        id: "19:conversation@thread.v2",
        metadata: {},
        threadId: "reply-chain",
      },
    ],
    [
      "slack",
      {
        channelId: "C1234567890",
        id: "C1234567890",
        metadata: {},
        threadId: "1700000000.000100",
      },
    ],
    [
      "telegram",
      {
        channelId: "-1001234567890",
        id: "-1001234567890",
        metadata: {},
        threadId: "-1001234567890:42",
      },
    ],
    [
      "whatsapp",
      {
        channelId: "15551234567",
        id: "15551234567",
        metadata: {},
        threadId: "15551234567",
      },
    ],
    [
      "zalo",
      {
        channelId: "user-1",
        id: "user-1",
        metadata: {},
      },
    ],
  ] satisfies Array<
    readonly [BuiltinProviderAdapterId, ManifestDefinition["fixtures"][number]["target"]]
  >)("keeps the %s lazy adapter in parity with its target codec", (adapter, target) => {
    expect(BUILTIN_ADAPTERS).toContain(adapter);
    const fixture = {
      ...manifest.fixtures[0]!,
      id: `${adapter}-parity`,
      provider: adapter,
      target,
    };
    const config = {
      adapter,
      capabilities: ["probe"],
      env: [],
      platform: adapter,
      status: "active",
    } as ProviderConfig;
    const registry = createRegistry(
      {
        ...manifest,
        fixtures: [fixture],
        providers: { [adapter]: config },
      },
      "/tmp/crabline.yaml",
    );

    expect(registry.resolve(adapter, fixture.id).normalizeTarget(target)).toEqual(
      normalizeBuiltinTarget(adapter, target),
    );
  });

  it("rejects unsupported Zalo thread targets through lazy adapters", () => {
    const target = {
      channelId: "user-1",
      id: "user-1",
      metadata: {},
      threadId: "message-1",
    };
    const fixture = {
      ...manifest.fixtures[0]!,
      id: "zalo-thread-target",
      provider: "zalo",
      target,
    };
    const registry = createRegistry(
      {
        ...manifest,
        fixtures: [fixture],
        providers: {
          zalo: {
            adapter: "zalo",
            capabilities: ["probe"],
            env: [],
            platform: "zalo",
            status: "active",
          },
        },
      },
      "/tmp/crabline.yaml",
    );

    expect(() => registry.resolve("zalo", fixture.id).normalizeTarget(target)).toThrow(
      ZALO_UNSUPPORTED_THREAD_TARGET_ERROR,
    );
  });

  it("accepts Matrix v12 domainless room ids in lazy target normalization", () => {
    const roomId = `!${Buffer.alloc(32, 0xab).toString("base64url")}`;
    expect(normalizeBuiltinTarget("matrix", { id: roomId, metadata: {} })).toMatchObject({
      channelId: roomId,
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

  it("keeps cleanup terminal before lazy provider materialization", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "whatsapp.jsonl");
    try {
      const config: ProviderConfig = {
        adapter: "whatsapp",
        capabilities: ["probe", "send", "roundtrip", "agent"],
        env: [],
        platform: "whatsapp",
        status: "active",
        whatsapp: {
          recorder: { path: recorderPath },
          webhook: {
            host: "127.0.0.1",
            path: "/whatsapp/webhook",
            port: 0,
          },
        },
      };
      const fixture = {
        ...manifest.fixtures[0]!,
        id: "whatsapp-cleanup",
        mode: "send" as const,
        provider: "whatsapp",
        target: { id: "15551234567", metadata: {} },
      };
      const lazyManifest: ManifestDefinition = {
        ...manifest,
        fixtures: [fixture],
        providers: { whatsapp: config },
      };
      const provider = createRegistry(lazyManifest, "/tmp/crabline.yaml").resolve(
        "whatsapp",
        fixture.id,
      );
      const context: ProviderContext = {
        config,
        fixture,
        manifestPath: "/tmp/crabline.yaml",
        providerId: "whatsapp",
        userName: "crabline",
      };
      const sendContext: SendContext = {
        ...context,
        mode: "send",
        nonce: "lazy-cleanup",
        text: "must not run",
      };
      const waitContext: WaitContext = {
        ...context,
        nonce: "lazy-cleanup",
        since: new Date().toISOString(),
        timeoutMs: 100,
      };

      await provider.cleanup?.();

      await expect(provider.send(sendContext)).rejects.toThrow(/has been cleaned up/u);
      await expect(provider.probe(context)).rejects.toThrow(/has been cleaned up/u);
      await expect(provider.waitForInbound(waitContext)).rejects.toThrow(/has been cleaned up/u);
      await expect(provider.watch?.(context)[Symbol.asyncIterator]().next()).rejects.toThrow(
        /has been cleaned up/u,
      );
      expect(() => provider.normalizeTarget(fixture.target)).toThrow(/has been cleaned up/u);
      await expect(readFile(recorderPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("throws for unknown providers", () => {
    const registry = createRegistry(manifest, "/tmp/crabline.yaml");
    expect(() => registry.resolve("missing", "fixture")).toThrow(/Unknown provider/);
  });

  it("rejects resolving a fixture through a different provider", () => {
    const mismatchedManifest: ManifestDefinition = {
      ...manifest,
      providers: {
        ...manifest.providers,
        other: {
          adapter: "loopback",
          capabilities: ["probe", "send"],
          env: [],
          platform: "loopback",
          status: "active",
        },
      },
    };
    const registry = createRegistry(mismatchedManifest, "/tmp/crabline.yaml");

    expect(() => registry.resolve("other", "fixture")).toThrow(
      'Fixture "fixture" belongs to provider "local", not "other".',
    );
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
