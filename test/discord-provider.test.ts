import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiscordInteractionResponse,
  DiscordProviderAdapter,
  handleDiscordWebhookPayload,
  normalizeDiscordWebhookPayload,
} from "../src/providers/builtin/discord.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const providers: DiscordProviderAdapter[] = [];

describe("Discord interaction responses", () => {
  it("returns a native component acknowledgement", async () => {
    const response = createDiscordInteractionResponse({ type: 3 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 6 });
  });

  it("handles autocomplete before recorder normalization", async () => {
    const response = handleDiscordWebhookPayload({
      channel_id: "123456789012345678",
      data: { name: "search" },
      type: 4,
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      data: { choices: [] },
      type: 8,
    });
  });

  it("normalizes the documented top-level generic payload", () => {
    expect(
      normalizeDiscordWebhookPayload({
        author: "user",
        id: "444456789012345678",
        text: "generic nonce-4",
        threadId: "123456789012345678",
      }),
    ).toMatchObject({
      author: "user",
      id: "444456789012345678",
      text: "generic nonce-4",
      threadId: "123456789012345678",
    });
  });

  it("includes nested application-command option values", () => {
    expect(
      normalizeDiscordWebhookPayload({
        channel_id: "123456789012345678",
        data: {
          name: "deploy",
          options: [
            {
              name: "service",
              options: [
                {
                  name: "environment",
                  options: [{ name: "nonce", type: 3, value: "nonce-nested" }],
                  type: 1,
                },
              ],
              type: 2,
            },
          ],
        },
        id: "444456789012345678",
        type: 2,
      }),
    ).toMatchObject({
      text: "deploy service environment nonce-nested",
    });
  });

  it("preserves context-command target and resolved data", () => {
    expect(
      normalizeDiscordWebhookPayload({
        channel_id: "123456789012345678",
        data: {
          name: "inspect user",
          resolved: {
            members: {
              "555456789012345678": { nick: "Target User" },
            },
            users: {
              "555456789012345678": {
                id: "555456789012345678",
                username: "target-user",
              },
            },
          },
          target_id: "555456789012345678",
          type: 2,
        },
        id: "444456789012345678",
        type: 2,
      }),
    ).toMatchObject({
      text: 'inspect user {"target_id":"555456789012345678","resolved":{"members":{"555456789012345678":{"nick":"Target User"}},"users":{"555456789012345678":{"id":"555456789012345678","username":"target-user"}}}}',
    });
  });

  it.each([
    [
      {
        channel_id: "123456789012345678",
        data: {
          component_type: 3,
          custom_id: "environment",
          values: ["staging", "nonce-select"],
        },
        id: "444456789012345678",
        type: 3,
      },
      "environment staging nonce-select",
    ],
    [
      {
        channel_id: "123456789012345678",
        data: {
          components: [
            {
              components: [{ custom_id: "reason", type: 4, value: "deploy nonce-modal" }],
              type: 1,
            },
          ],
          custom_id: "deploy-form",
        },
        id: "444456789012345678",
        type: 5,
      },
      "deploy-form deploy nonce-modal",
    ],
  ])("preserves native component and modal values", (payload, text) => {
    expect(normalizeDiscordWebhookPayload(payload)).toMatchObject({ text });
  });
});

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
  it("confines generated recorder paths to the recorder directory", async () => {
    const config = await createDiscordConfig(0);
    config.discord!.recorder = {};

    expect(() => new DiscordProviderAdapter("../escaped", config, "crabline", { env: {} })).toThrow(
      /Provider ID cannot contain absolute or parent-directory paths/u,
    );
  });

  it("requires signatures for externally reachable interaction endpoints", async () => {
    const config = await createDiscordConfig(0);
    config.discord!.webhook.host = "0.0.0.0";
    expect(() => new DiscordProviderAdapter("discord", config, "crabline", { env: {} })).toThrow(
      /externally reachable webhooks require discord\.publicKey/u,
    );

    config.discord!.webhook.host = "127.0.0.1";
    config.discord!.webhook.publicUrl = "https://discord.example.test/interactions";
    expect(() => new DiscordProviderAdapter("discord", config, "crabline", { env: {} })).toThrow(
      /externally reachable webhooks require discord\.publicKey/u,
    );

    config.discord!.publicKey = "a".repeat(64);
    expect(
      () => new DiscordProviderAdapter("discord", config, "crabline", { env: {} }),
    ).not.toThrow();
  });

  it("verifies configured signatures and answers PING without recording it", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const now = 1_700_000_000_000;
    const config = await createDiscordConfig(0);
    config.discord!.publicKey = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    const provider = new DiscordProviderAdapter("discord", config, "crabline", {
      now: () => now,
    });
    providers.push(provider);
    const endpoint = (await provider.probe(createContext(config))).details
      .find((detail) => detail.startsWith("interactions endpoint "))
      ?.replace("interactions endpoint ", "");
    expect(endpoint).toBeDefined();
    const body = JSON.stringify({ type: 1 });
    const timestamp = String(now / 1_000);
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");

    const unsigned = await fetch(endpoint!, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unsigned.status).toBe(401);

    const wrongMediaType = await fetch(endpoint!, {
      body,
      headers: {
        "content-type": "text/application/jsonish",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
      method: "POST",
    });
    expect(wrongMediaType.status).toBe(415);

    const pong = await fetch(endpoint!, {
      body,
      headers: {
        "content-type": "Application/JSON; Charset=UTF-8",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
      method: "POST",
    });
    expect(pong.status).toBe(200);
    await expect(pong.json()).resolves.toEqual({ type: 1 });
    await expect(readFile(config.discord!.recorder.path!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects signed stale and far-future interactions before parsing payloads", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const now = 1_700_000_000_000;
    const config = await createDiscordConfig(0);
    config.discord!.publicKey = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    const provider = new DiscordProviderAdapter("discord", config, "crabline", {
      now: () => now,
    });
    providers.push(provider);
    const endpoint = (await provider.probe(createContext(config))).details
      .find((detail) => detail.startsWith("interactions endpoint "))
      ?.replace("interactions endpoint ", "");
    expect(endpoint).toBeDefined();
    const body = "{";

    for (const timestamp of [
      String(now / 1_000 - 301),
      String(now / 1_000 + 301),
      `${now / 1_000}.5`,
    ]) {
      const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
      const response = await fetch(endpoint!, {
        body,
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        },
        method: "POST",
      });

      expect(response.status).toBe(401);
    }
  });

  it("rejects malformed configured public keys", async () => {
    const config = await createDiscordConfig(0);
    config.discord!.publicKey = "not-a-public-key";
    expect(() => new DiscordProviderAdapter("discord", config, "crabline")).toThrow(
      /32-byte hexadecimal Ed25519 key/u,
    );
  });

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
    config.discord!.publicKey = "a".repeat(64);
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

  it("records native component interactions that include a Discord message", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("interactions endpoint "));
    expect(endpoint).toBeDefined();

    const context = createContext(config);
    context.fixture.inboundMatch = {
      author: "user",
      nonce: "contains",
      strategy: "contains",
    };
    const since = new Date(Date.now() - 1000).toISOString();
    const response = await fetch(endpoint!.replace("interactions endpoint ", ""), {
      body: JSON.stringify({
        channel_id: "123456789012345678",
        data: {
          component_type: 2,
          custom_id: "approve:nonce-3",
        },
        id: "444456789012345678",
        member: {
          user: {
            bot: false,
            id: "555456789012345678",
          },
        },
        message: {
          author: {
            bot: true,
            id: "666456789012345678",
          },
          content: "Choose an action",
          id: "777456789012345678",
        },
        type: 3,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 6 });
    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce-3",
        since,
        threadId: "123456789012345678",
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      author: "user",
      id: "444456789012345678",
      text: "approve:nonce-3",
      threadId: "123456789012345678",
    });
  });

  it("answers autocomplete interactions without recording them", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);
    const endpoint = (await provider.probe(createContext(config))).details
      .find((detail) => detail.startsWith("interactions endpoint "))
      ?.replace("interactions endpoint ", "");
    expect(endpoint).toBeDefined();

    const response = await fetch(endpoint!, {
      body: JSON.stringify({
        channel_id: "123456789012345678",
        data: { name: "search" },
        id: "444456789012345678",
        type: 4,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { choices: [] },
      type: 8,
    });
    await expect(readFile(config.discord!.recorder.path!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts the documented top-level generic webhook payload", async () => {
    const config = await createDiscordConfig(0);
    const provider = new DiscordProviderAdapter("discord", config, "crabline");
    providers.push(provider);
    const endpoint = (await provider.probe(createContext(config))).details
      .find((detail) => detail.startsWith("interactions endpoint "))
      ?.replace("interactions endpoint ", "");
    expect(endpoint).toBeDefined();
    const since = new Date(Date.now() - 1000).toISOString();

    const response = await fetch(endpoint!, {
      body: JSON.stringify({
        author: "user",
        id: "444456789012345678",
        text: "generic nonce-4",
        threadId: "123456789012345678",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const context = createContext(config);
    context.fixture.inboundMatch.author = "any";
    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce-4",
        since,
        threadId: "123456789012345678",
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      author: "user",
      id: "444456789012345678",
      text: "generic nonce-4",
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
