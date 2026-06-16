import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/providers/registry.js";
import type { ManifestDefinition } from "../src/config/schema.js";

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

  it("resolves built-in discord, matrix, imessage, telegram, and whatsapp providers", () => {
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
        imessage: {
          adapter: "imessage",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          imessage: {
            gatewayDurationMs: 30_000,
            local: true,
            recorder: { path: "/tmp/crabline-imessage-test.jsonl" },
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
          },
          platform: "matrix",
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
      ],
    };

    const registry = createRegistry(nativeManifest, "/tmp/crabline.yaml");
    expect(registry.resolve("discord", "discord-fixture").platform).toBe("discord");
    expect(registry.resolve("imessage", "imessage-fixture").platform).toBe("imessage");
    expect(registry.resolve("matrix", "matrix-fixture").platform).toBe("matrix");
    expect(registry.resolve("telegram", "telegram-fixture").platform).toBe("telegram");
    expect(registry.resolve("whatsapp", "whatsapp-fixture").platform).toBe("whatsapp");
  });
});
