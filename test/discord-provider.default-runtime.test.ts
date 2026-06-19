import { describe, expect, it } from "vitest";
import { resolveDiscordAdapterConfig } from "../src/providers/builtin/discord.js";
import type { ProviderConfig } from "../src/config/schema.js";

function createConfig(discord?: Partial<NonNullable<ProviderConfig["discord"]>>): ProviderConfig {
  return {
    adapter: "discord",
    capabilities: ["probe"],
    discord: {
      gatewayDurationMs: 60_000,
      recorder: {},
      webhook: {
        host: "127.0.0.1",
        path: "/discord/interactions",
        port: 8788,
      },
      ...discord,
    },
    env: [],
    platform: "discord",
    status: "active",
  };
}

describe("discord provider default runtime", () => {
  it("builds optional discord metadata from provider settings", async () => {
    const config = createConfig({
      applicationId: "123456789012345678",
      botToken: "discord-token",
      mentionRoleIds: ["111", "222"],
      publicKey: "a".repeat(64),
    });

    await expect(resolveDiscordAdapterConfig(config, "crabline")).resolves.toEqual({
      applicationId: "123456789012345678",
      botToken: "discord-token",
      mentionRoleIds: ["111", "222"],
      publicKey: "a".repeat(64),
      userName: "crabline",
    });
  });

  it("falls back to env-based optional metadata", async () => {
    const config = createConfig();

    await expect(
      resolveDiscordAdapterConfig(config, "crabline", {
        DISCORD_APPLICATION_ID: "123456789012345678",
        DISCORD_BOT_TOKEN: "env-token",
        DISCORD_PUBLIC_KEY: "b".repeat(64),
      }),
    ).resolves.toEqual({
      applicationId: "123456789012345678",
      botToken: "env-token",
      publicKey: "b".repeat(64),
      userName: "crabline",
    });
  });

  it("does not require live Discord credentials for the local mock", async () => {
    const config = createConfig();

    await expect(
      resolveDiscordAdapterConfig(config, "crabline", {
        DISCORD_APPLICATION_ID: undefined,
        DISCORD_BOT_TOKEN: undefined,
        DISCORD_PUBLIC_KEY: undefined,
      }),
    ).resolves.toEqual({
      userName: "crabline",
    });
  });
});
