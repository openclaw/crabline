import { createHmac } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuiltinAdapterId, ProviderConfig, ProviderPlatform } from "../src/config/schema.js";
import type { ProviderAdapter, ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type ProviderCtor = new (
  id: string,
  config: ProviderConfig,
  userName: string,
  runtime?: unknown,
) => ProviderAdapter;

type ContractOptions = {
  Adapter: ProviderCtor;
  adapter?: BuiltinAdapterId;
  endpointPath: string;
  endpointText?: string;
  expectedChannelId: string;
  expectedThreadId?: string | undefined;
  invalidTargets?: ProviderContext["fixture"]["target"][] | undefined;
  nonces?:
    | {
        reply?: string | undefined;
        user?: string | undefined;
        webhook?: string | undefined;
      }
    | undefined;
  target: ProviderContext["fixture"]["target"];
  threadTarget?: ProviderContext["fixture"]["target"] | undefined;
  webhookExpected: {
    author?: "assistant" | "system" | "user" | undefined;
    id?: string | undefined;
    text: string;
  };
  webhookPayload: unknown;
  webhookThreadId: string;
  platform: ProviderPlatform;
};

const directories: string[] = [];
const providers: ProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup?.()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

export async function createLocalMockConfig(
  platform: ProviderPlatform,
  endpointPath: string,
  adapter: BuiltinAdapterId = platform as BuiltinAdapterId,
): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  const config = {
    adapter,
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform,
    [platform]: {
      recorder: { path: path.join(directory, `${platform}.jsonl`) },
      webhook: {
        host: "127.0.0.1",
        path: endpointPath,
        port: 0,
      },
    },
    status: "active",
  } as ProviderConfig;
  if (platform === "whatsapp") {
    config.whatsapp!.appSecret = "test-token-placeholder";
    config.whatsapp!.verifyToken = "test-token-placeholder";
  }
  return config;
}

export function createProviderContext(
  platform: ProviderPlatform,
  config: ProviderConfig,
  target: ProviderContext["fixture"]["target"] = { id: "target-1", metadata: {} },
): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: `${platform}-agent`,
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: platform,
      retries: 0,
      tags: [],
      target,
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: platform,
    userName: "crabline",
  };
}

function endpointFromDetails(details: string[]): string {
  const detail = details.find((entry) => /\bhttps?:\/\//u.test(entry));
  if (!detail) {
    throw new Error(`No endpoint detail found in ${details.join("\n")}`);
  }
  return detail.replace(/^.*?(https?:\/\/\S+)$/u, "$1");
}

function webhookHeaders(
  platform: ProviderPlatform,
  config: ProviderConfig,
  body: string,
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (platform === "whatsapp") {
    const signingKey = config.whatsapp!.appSecret!;
    headers["x-hub-signature-256"] =
      `sha256=${createHmac("sha256", signingKey).update(body).digest("hex")}`;
  }
  return headers;
}

export function runLocalMockProviderContract(options: ContractOptions): void {
  describe(`${options.platform} local mock provider`, () => {
    it("normalizes native channel targets and rejects synthetic local ids", async () => {
      const config = await createLocalMockConfig(
        options.platform,
        options.endpointPath,
        options.adapter,
      );
      const provider = new options.Adapter(options.platform, config, "crabline");
      providers.push(provider);

      expect(provider.normalizeTarget(options.target)).toMatchObject({
        channelId: options.expectedChannelId,
      });
      expect(provider.normalizeTarget(options.threadTarget ?? options.target)).toMatchObject({
        channelId: options.expectedChannelId,
        ...(options.expectedThreadId ? { threadId: options.expectedThreadId } : {}),
      });
      for (const target of options.invalidTargets ?? [
        { id: `target-1`, metadata: {} },
        { id: `${options.platform}:${options.expectedChannelId}`, metadata: {} },
      ]) {
        expect(() => provider.normalizeTarget(target)).toThrow(/must be|requires|native/u);
      }
    });

    it("probes, sends, and waits for a deterministic mock reply", async () => {
      const config = await createLocalMockConfig(
        options.platform,
        options.endpointPath,
        options.adapter,
      );
      const provider = new options.Adapter(options.platform, config, "crabline");
      providers.push(provider);
      const context = createProviderContext(options.platform, config, options.target);
      const nonce = options.nonces?.reply ?? "nonce-1";

      const probe = await provider.probe(context);
      expect(probe.healthy).toBe(true);
      expect(probe.details.join("\n")).toContain(`${options.platform} local mock ready`);
      expect(probe.details.join("\n")).toContain(options.endpointText ?? "endpoint");

      const since = new Date(Date.now() - 1000).toISOString();
      const result = await provider.send({
        ...context,
        mode: "agent",
        nonce,
        text: `hello ${nonce}`,
      });
      expect(result.accepted).toBe(true);
      expect(result.threadId).toBe(options.expectedChannelId);

      await expect(
        provider.waitForInbound({
          ...context,
          nonce,
          since,
          threadId: result.threadId,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        author: "assistant",
        text: `[${options.platform} mock] hello ${nonce}`,
        threadId: result.threadId,
      });
    });

    it("records inbound webhook events and rejects malformed webhooks", async () => {
      const config = await createLocalMockConfig(
        options.platform,
        options.endpointPath,
        options.adapter,
      );
      const provider = new options.Adapter(options.platform, config, "crabline");
      providers.push(provider);
      const context = createProviderContext(options.platform, config, options.target);
      const nonce = options.nonces?.webhook ?? "nonce-2";
      context.fixture.inboundMatch = {
        author: options.webhookExpected.author ?? "any",
        nonce: "contains",
        strategy: "contains",
      };
      const endpoint = endpointFromDetails((await provider.probe(context)).details);

      const since = new Date(Date.now() - 1000).toISOString();
      const malformedBody = JSON.stringify({ text: "missing thread" });
      const malformed = await fetch(endpoint, {
        body: malformedBody,
        headers: webhookHeaders(options.platform, config, malformedBody),
        method: "POST",
      });
      expect(malformed.status).toBe(400);

      const webhookBody = JSON.stringify(options.webhookPayload);
      const response = await fetch(endpoint, {
        body: webhookBody,
        headers: webhookHeaders(options.platform, config, webhookBody),
        method: "POST",
      });
      expect(response.status).toBe(200);

      await expect(
        provider.waitForInbound({
          ...context,
          nonce,
          since,
          threadId: options.webhookThreadId,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        ...options.webhookExpected,
      });
    });

    it("lets fixture matching observe user-authored webhook events", async () => {
      const config = await createLocalMockConfig(
        options.platform,
        options.endpointPath,
        options.adapter,
      );
      const provider = new options.Adapter(options.platform, config, "crabline");
      providers.push(provider);
      const context = createProviderContext(options.platform, config, options.target);
      const nonce = options.nonces?.user ?? "nonce-3";
      context.fixture.inboundMatch = {
        author: "user",
        nonce: "contains",
        strategy: "contains",
      };
      const endpoint = endpointFromDetails((await provider.probe(context)).details);
      const since = new Date(Date.now() - 1000).toISOString();

      const webhookBody = JSON.stringify({
        message: {
          author: "user",
          id: `${options.platform}-user-inbound`,
          text: `user ${nonce}`,
          threadId: options.expectedChannelId,
        },
      });
      const response = await fetch(endpoint, {
        body: webhookBody,
        headers: webhookHeaders(options.platform, config, webhookBody),
        method: "POST",
      });
      expect(response.status).toBe(200);

      await expect(
        provider.waitForInbound({
          ...context,
          nonce,
          since,
          threadId: options.expectedChannelId,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        author: "user",
        id: `${options.platform}-user-inbound`,
        text: `user ${nonce}`,
      });
    });
  });
}
