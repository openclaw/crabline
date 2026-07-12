import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../src/config/schema.js";
import { SlackProviderAdapter } from "../src/providers/builtin/slack.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const providers: SlackProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createSlackConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "slack",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "slack",
    slack: {
      recorder: { path: path.join(directory, "slack.jsonl") },
      webhook: {
        host: "127.0.0.1",
        path: "/slack/events",
        port,
      },
    },
    status: "active",
  };
}

function createContext(
  config: ProviderConfig,
  target: ProviderContext["fixture"]["target"] = {
    id: "C1234567890",
    metadata: {},
  },
): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "slack-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "slack",
      retries: 0,
      tags: [],
      target,
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "slack",
    userName: "crabline",
  };
}

function endpointFromDetails(details: string[]): string {
  const detail = details.find((entry) => entry.startsWith("events endpoint "));
  if (!detail) {
    throw new Error(`No Slack events endpoint detail found in ${details.join("\n")}`);
  }
  return detail.replace("events endpoint ", "");
}

describe("slack provider", () => {
  it("keeps native Slack conversation and thread timestamp ids", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "C1234567890", metadata: {} })).toMatchObject({
      channelId: "C1234567890",
    });
    expect(
      provider.normalizeTarget({
        channelId: "C1234567890",
        id: "reply-target",
        metadata: {},
        threadId: "1700000000.000100",
      }),
    ).toMatchObject({
      channelId: "C1234567890",
      threadId: "1700000000.000100",
    });

    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: "1700000000.000100",
    });
    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "thread-scope",
        text: "thread-scoped send",
      }),
    ).resolves.toMatchObject({
      threadId: "C1234567890:thread:1700000000.000100",
    });
  });

  it("rejects generic and Crabline-prefixed Slack ids", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    expect(() => provider.normalizeTarget({ id: "target-1", metadata: {} })).toThrow(
      /native Slack conversation id/u,
    );
    expect(() => provider.normalizeTarget({ id: "slack:C1234567890", metadata: {} })).toThrow(
      /native Slack conversation id/u,
    );
    expect(() =>
      provider.normalizeTarget({
        channelId: "C1234567890",
        id: "reply-target",
        metadata: {},
        threadId: "thread-1",
      }),
    ).toThrow(/Slack timestamp/u);
  });

  it("probes and sends with Slack-shaped ids", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    const context = createContext(config);
    const probe = await provider.probe(context);
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("slack local mock ready");
    expect(probe.details.join("\n")).toContain("events endpoint http://127.0.0.1:");
    expect(probe.details.join("\n")).toContain("channel reachable C1234567890");

    const result = await provider.send({
      ...context,
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello nonce-1",
    });
    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("C1234567890");

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce-1",
        since: new Date(Date.now() - 1000).toISOString(),
        threadId: result.threadId,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      author: "assistant",
      text: "[slack mock] hello nonce-1",
      threadId: "C1234567890",
    });
  });

  it("accepts Slack Events API-style inbound messages", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: "1700000000.000100",
    });
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const threadKey = "C1234567890:thread:1700000000.000100";
    const waitPromise = provider.waitForInbound({
      ...context,
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: threadKey,
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          channel: "C1234567890",
          text: "ACK nonce-2",
          thread_ts: "1700000000.000100",
          ts: "1700000001.000200",
          type: "message",
          user: "U1234567890",
        },
        team_id: "T1234567890",
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    await expect(waitPromise).resolves.toMatchObject({
      author: "user",
      id: "1700000001.000200",
      text: "ACK nonce-2",
      threadId: threadKey,
    });
  });

  it("rejects mock webhook thread ids that are not Slack-shaped", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    const endpoint = endpointFromDetails((await provider.probe(createContext(config))).details);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        id: "bad-slack-inbound",
        text: "bad nonce",
        threadId: "slack:C1234567890",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "native Slack timestamp or Slack conversation id",
    );
  });
});
