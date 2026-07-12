import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordProviderAdapter } from "../src/providers/builtin/discord.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const providers: DiscordProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createDiscordConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "discord",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    discord: {
      gatewayDurationMs: 60_000,
      recorder: { path: path.join(directory, "discord.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/discord/interactions",
        port,
      },
    },
    env: [],
    platform: "discord",
    status: "active",
  };
}

async function resolveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve free port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function createContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "discord-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "discord",
      retries: 0,
      tags: [],
      target: {
        id: "123456789012345678",
        metadata: { guildId: "987654321098765432" },
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "discord",
    userName: "crabline",
  };
}

describe("discord provider", () => {
  it("normalizes native channel and thread targets", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    expect(
      provider.normalizeTarget({
        id: "123456789012345678",
        metadata: { guildId: "987654321098765432" },
      }),
    ).toMatchObject({
      channelId: "123456789012345678",
    });
    expect(
      provider.normalizeTarget({
        channelId: "123456789012345678",
        id: "123456789012345678",
        metadata: { guildId: "987654321098765432" },
        threadId: "223456789012345678",
      }),
    ).toMatchObject({
      channelId: "123456789012345678",
      threadId: "223456789012345678",
    });
  });

  it("rejects encoded or non-snowflake targets", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    expect(() =>
      provider.normalizeTarget({
        id: "discord:987654321098765432:123456789012345678",
        metadata: {},
      }),
    ).toThrow(/Discord channel_id/u);
    expect(() => provider.normalizeTarget({ id: "target-1", metadata: {} })).toThrow(
      /Discord channel_id/u,
    );
  });

  it("probes built-in discord configuration and DM targets", async () => {
    const config = await createDiscordConfig(0);
    config.discord!.webhook.publicUrl = "https://example.ngrok.app/discord/interactions";
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    const result = await provider.probe(createContext(config));
    expect(result.healthy).toBe(true);
    expect(result.details.join("\n")).toContain("discord local mock ready");
    expect(result.details.join("\n")).toContain("interactions endpoint http://127.0.0.1:");
    expect(result.details.join("\n")).toContain(
      "public webhook https://example.ngrok.app/discord/interactions",
    );
    expect(result.details.join("\n")).toContain("channel reachable 123456789012345678");

    const dmResult = await provider.probe({
      ...createContext(config),
      fixture: {
        ...createContext(config).fixture,
        target: {
          id: "555555555555555555",
          metadata: {},
        },
      },
    });
    expect(dmResult.details.join("\n")).toContain("channel reachable 555555555555555555");
  });

  it("sends to a discord channel and records a local mock reply", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello nonce-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("123456789012345678");
    await expect(
      provider.waitForInbound({
        ...createContext(config),
        nonce: "nonce-1",
        since: new Date(Date.now() - 1000).toISOString(),
        threadId: result.threadId,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      author: "assistant",
      text: expect.stringContaining("nonce-1"),
    });
  });

  it("records webhook inbound events and waits for them", async () => {
    const config = await createDiscordConfig(0);
    config.discord!.webhook.publicUrl = "https://example.ngrok.app/discord/interactions";
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("interactions endpoint "));
    expect(endpoint).toBeDefined();

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "123456789012345678",
      timeoutMs: 500,
    });

    const response = await fetch(endpoint!.replace("interactions endpoint ", ""), {
      body: JSON.stringify({
        author: { bot: true },
        channel_id: "123456789012345678",
        content: "ACK nonce-2",
        id: "333456789012345678",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waitPromise).resolves.toMatchObject({
      id: "333456789012345678",
      text: "ACK nonce-2",
    });
  });

  it("streams watched interaction events", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("interactions endpoint "));
    expect(endpoint).toBeDefined();

    const watchStream = provider.watch({
      ...createContext(config),
      since: new Date(Date.now() - 1000).toISOString(),
    });
    const iterator = watchStream[Symbol.asyncIterator]();

    await fetch(endpoint!.replace("interactions endpoint ", ""), {
      body: JSON.stringify({
        message: {
          author: "user",
          id: "evt-2",
          text: "user message",
          threadId: "123456789012345678",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.author).toBe("user");
    expect(next.value?.id).toBe("evt-2");
  });

  it("rejects a secondary probe when the interactions listener is occupied", async () => {
    const config = await createDiscordConfig(await resolveFreePort());
    const primary = new DiscordProviderAdapter(
      "discord-primary",
      {
        ...config,
        discord: { ...config.discord!, recorder: { path: config.discord!.recorder.path } },
      },
      "crabline",
    );
    providers.push(primary);

    const secondary = new DiscordProviderAdapter(
      "discord-secondary",
      {
        ...config,
        discord: {
          ...config.discord!,
          recorder: {
            path: config.discord!.recorder.path?.replace(
              "discord.jsonl",
              "discord-secondary.jsonl",
            ),
          },
        },
      },
      "crabline",
    );
    providers.push(secondary);

    const primaryProbe = await primary.probe(createContext(config));
    expect(primaryProbe.healthy).toBe(true);

    await expect(
      secondary.probe(
        createContext({
          ...config,
          discord: {
            ...config.discord!,
            recorder: {
              path: config.discord!.recorder.path?.replace(
                "discord.jsonl",
                "discord-secondary.jsonl",
              ),
            },
          },
        }),
      ),
    ).rejects.toThrow(/EADDRINUSE/u);

    await expect(primary.probe(createContext(config))).resolves.toMatchObject({ healthy: true });
  });

  it("returns channel-like webhook errors for malformed interaction events", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("interactions endpoint "));
    expect(endpoint).toBeDefined();

    const response = await fetch(endpoint!.replace("interactions endpoint ", ""), {
      body: JSON.stringify({ message: { id: "evt-bad", text: "missing thread" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("threadId");
  });
});
