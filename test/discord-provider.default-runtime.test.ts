import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordAdapterConfig } from "../src/providers/builtin/discord.js";
import type { ProviderConfig } from "../src/config/schema.js";

const fetchMock = vi.fn<typeof fetch>();

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

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("discord provider default runtime", () => {
  it("builds native discord adapter config from provider settings", async () => {
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

  it("falls back to env-based config", async () => {
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

  it("auto-discovers missing Discord metadata from the bot token", async () => {
    const config = createConfig();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "999999999999999999",
          verify_key: "c".repeat(64),
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveDiscordAdapterConfig(config, "crabline", {
        DISCORD_APPLICATION_ID: undefined,
        DISCORD_BOT_TOKEN: "env-token",
        DISCORD_PUBLIC_KEY: undefined,
      }),
    ).resolves.toEqual({
      applicationId: "999999999999999999",
      botToken: "env-token",
      publicKey: "c".repeat(64),
      userName: "crabline",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://discord.com/api/v10/oauth2/applications/@me", {
      headers: {
        Authorization: "Bot env-token",
      },
    });
  });

  it("fails fast when the bot token is missing", async () => {
    const config = createConfig();

    await expect(
      resolveDiscordAdapterConfig(config, "crabline", {
        DISCORD_APPLICATION_ID: undefined,
        DISCORD_BOT_TOKEN: undefined,
        DISCORD_PUBLIC_KEY: undefined,
      }),
    ).rejects.toThrow(/bot token is required/u);
  });
});
