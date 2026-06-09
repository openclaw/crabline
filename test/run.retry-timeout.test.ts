import { describe, expect, it } from "vitest";
import { runFixtureCommand } from "../src/core/run.js";
import type { ManifestDefinition } from "../src/config/schema.js";
import { OPENCLAW_SUPPORT_CATALOG } from "../src/providers/catalog.js";
import type { Registry } from "../src/providers/registry.js";
import type { ProviderAdapter } from "../src/providers/types.js";

const manifest: ManifestDefinition = {
  configVersion: 1,
  fixtures: [
    {
      env: [],
      id: "fixture",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "mock",
      retries: 1,
      tags: [],
      target: { id: "echo", metadata: {} },
      timeoutMs: 10,
    },
  ],
  providers: {
    mock: {
      adapter: "loopback",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      platform: "loopback",
      status: "active",
    },
  },
  userName: "crabline",
};

describe("runFixtureCommand retries", () => {
  it("retries after a timeout and succeeds", async () => {
    let waitCalls = 0;
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      async probe() {
        return { details: [], healthy: true };
      },
      async send() {
        return { accepted: true, messageId: "sent-1", threadId: "thread-1" };
      },
      async waitForInbound(context) {
        waitCalls += 1;
        if (waitCalls === 1) {
          return null;
        }
        return {
          author: "assistant",
          id: "inbound-1",
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: `ACK ${context.nonce}`,
          threadId: "thread-1",
        };
      },
    };

    const registry: Registry = {
      catalog: OPENCLAW_SUPPORT_CATALOG,
      resolve() {
        return provider;
      },
    };

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry,
    });

    expect(result.ok).toBe(true);
    expect(waitCalls).toBe(2);
  });
});
