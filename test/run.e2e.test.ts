import { beforeAll, describe, expect, it } from "vitest";
import { runFixtureCommand } from "../src/core/run.js";
import { createRegistry } from "../src/providers/registry.js";
import type { ManifestDefinition } from "../src/config/schema.js";
import { initializeProcessOwnedLockIdentity } from "../src/platform/process-owned-lock.js";

const manifest: ManifestDefinition = {
  configVersion: 1,
  fixtures: [
    {
      env: [],
      id: "loopback-roundtrip",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "local",
      retries: 0,
      tags: ["local"],
      target: { behavior: "echo", id: "echo-bot", metadata: {} },
      timeoutMs: 1000,
    },
    {
      env: [],
      id: "loopback-agent",
      inboundMatch: {
        author: "assistant",
        nonce: "contains",
        pattern: "ACK",
        strategy: "contains",
      },
      mode: "agent",
      provider: "local",
      retries: 0,
      tags: ["local"],
      target: { behavior: "agent", id: "agent-bot", metadata: {} },
      timeoutMs: 1000,
    },
  ],
  providers: {
    local: {
      adapter: "loopback",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      loopback: { delayMs: 0 },
      platform: "loopback",
      status: "active",
    },
  },
  userName: "crabline",
};

describe("loopback e2e", () => {
  beforeAll(() => {
    // Native identity discovery is startup work outside the one-second fixture budget.
    initializeProcessOwnedLockIdentity();
  });

  it("completes a roundtrip", async () => {
    const result = await runFixtureCommand({
      fixtureId: "loopback-roundtrip",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: createRegistry(manifest, "/tmp/crabline.yaml"),
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("completes an agent flow", async () => {
    const result = await runFixtureCommand({
      fixtureId: "loopback-agent",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: createRegistry(manifest, "/tmp/crabline.yaml"),
    });

    expect(result).toMatchObject({ ok: true });
  });
});
