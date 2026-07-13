import { describe, expect, it, vi } from "vitest";
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
  it("keeps inbound deadlines monotonic when the wall clock moves backward", async () => {
    let wallNow = 10_000;
    let waitCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["roundtrip"],
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
        expect(context.timeoutMs).toBeLessThanOrEqual(30);
        if (waitCalls === 1) {
          wallNow -= 60_000;
        }
        return {
          author: "assistant",
          id: "repeated",
          provider: "mock",
          sentAt: new Date(wallNow).toISOString(),
          text: "not the requested nonce",
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
    const boundedManifest: ManifestDefinition = {
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, retries: 0, timeoutMs: 30 }],
    };

    try {
      const result = await runFixtureCommand({
        fixtureId: "fixture",
        manifest: boundedManifest,
        manifestPath: "/tmp/crabline.yaml",
        registry,
      });

      expect(result).toMatchObject({ failureKind: "timeout", ok: false });
      expect(waitCalls).toBeGreaterThan(1);
      expect(waitCalls).toBeLessThan(10);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

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

  it("drains an aborted wait before retrying or cleaning up", async () => {
    let activeWaits = 0;
    let maxActiveWaits = 0;
    let sendCalls = 0;
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
        sendCalls += 1;
        expect(activeWaits).toBe(0);
        return { accepted: true, messageId: `sent-${sendCalls}`, threadId: "thread-1" };
      },
      async waitForInbound(context) {
        waitCalls += 1;
        activeWaits += 1;
        maxActiveWaits = Math.max(maxActiveWaits, activeWaits);
        if (waitCalls === 1) {
          return await new Promise<null>((resolve) => {
            context.signal?.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  activeWaits -= 1;
                  resolve(null);
                }, 25);
              },
              { once: true },
            );
          });
        }
        activeWaits -= 1;
        return {
          author: "assistant",
          id: "inbound-1",
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: `ACK ${context.nonce}`,
          threadId: "thread-1",
        };
      },
      async cleanup() {
        expect(activeWaits).toBe(0);
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
    expect(sendCalls).toBe(2);
    expect(maxActiveWaits).toBe(1);
  });

  it("stops retrying and lets cleanup cancel an aborted wait that does not settle", async () => {
    let cleanupCalls = 0;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let releaseWait: (() => void) | undefined;
    let sendCalls = 0;
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
        sendCalls += 1;
        return { accepted: true, messageId: "sent-1", threadId: "thread-1" };
      },
      async waitForInbound() {
        waitCalls += 1;
        return await new Promise<null>((resolve) => {
          keepAlive = setInterval(() => undefined, 1_000);
          releaseWait = () => resolve(null);
        });
      },
      async cleanup() {
        cleanupCalls += 1;
        clearInterval(keepAlive);
        releaseWait?.();
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

    expect(result).toMatchObject({ failureKind: "inbound", ok: false });
    expect(result.diagnostics).toContain(
      "Provider inbound wait did not settle within 250ms after abort.",
    );
    expect(sendCalls).toBe(1);
    expect(waitCalls).toBe(1);
    expect(cleanupCalls).toBe(1);
  });

  it("does not retry an outbound send that ignores cancellation", async () => {
    let cleanupCalls = 0;
    let releaseSend: (() => void) | undefined;
    let sendCalls = 0;
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
        sendCalls += 1;
        return await new Promise((resolve) => {
          releaseSend = () =>
            resolve({ accepted: true, messageId: "sent-late", threadId: "thread-1" });
        });
      },
      async waitForInbound() {
        throw new Error("wait must not run");
      },
      async cleanup() {
        cleanupCalls += 1;
        releaseSend?.();
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

    expect(result).toMatchObject({ failureKind: "timeout", ok: false });
    expect(result.diagnostics).toContain("Provider send did not settle within 250ms after abort.");
    expect(sendCalls).toBe(1);
    expect(cleanupCalls).toBe(1);
  });

  it("bounds cleanup after an inbound wait ignores cancellation", async () => {
    let releaseWait: (() => void) | undefined;
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
      async waitForInbound() {
        return await new Promise<null>((resolve) => {
          releaseWait = () => resolve(null);
        });
      },
      async cleanup() {
        await new Promise(() => undefined);
      },
    };
    const registry: Registry = {
      catalog: OPENCLAW_SUPPORT_CATALOG,
      resolve() {
        return provider;
      },
    };

    try {
      const result = await runFixtureCommand({
        fixtureId: "fixture",
        manifest,
        manifestPath: "/tmp/crabline.yaml",
        registry,
      });

      expect(result).toMatchObject({ failureKind: "inbound", ok: false });
      expect(result.diagnostics).toContain(
        "cleanup failed: Provider cleanup did not settle within 250ms after an aborted operation.",
      );
    } finally {
      releaseWait?.();
    }
  });
});
