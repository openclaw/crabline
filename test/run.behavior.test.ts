import { describe, expect, it } from "vitest";
import { CrablineError } from "../src/core/errors.js";
import { EXIT_CODES } from "../src/core/exit-codes.js";
import { computeExitCode, runFixtureCommand, runSuite } from "../src/core/run.js";
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
      retries: 0,
      tags: [],
      target: { id: "echo", metadata: {} },
      timeoutMs: 10,
    },
  ],
  providers: {
    mock: {
      adapter: "loopback",
      capabilities: ["probe", "send"],
      env: [],
      platform: "loopback",
      status: "active",
    },
  },
  userName: "crabline",
};

const withAllCapabilities = (value: ManifestDefinition): ManifestDefinition => ({
  ...value,
  providers: {
    mock: {
      adapter: value.providers.mock!.adapter,
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: value.providers.mock!.env,
      platform: value.providers.mock!.platform,
      status: value.providers.mock!.status,
    },
  },
});

const buildRegistry = (provider: ProviderAdapter): Registry => ({
  catalog: OPENCLAW_SUPPORT_CATALOG,
  resolve() {
    return provider;
  },
});

describe("run behavior", () => {
  it("throws for unknown fixtures", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "1", threadId: "1" }),
      waitForInbound: async () => null,
    };

    await expect(
      runFixtureCommand({
        fixtureId: "missing",
        manifest,
        manifestPath: "/tmp/crabline.yaml",
        registry: buildRegistry(provider),
      }),
    ).rejects.toThrow(/Unknown fixture/);
  });

  it("returns config failures for unsupported modes and missing env", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "1", threadId: "1" }),
      waitForInbound: async () => null,
    };

    const unsupported = await runFixtureCommand({
      fixtureId: "fixture",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });
    expect(unsupported.failureKind).toBe("config");

    const withEnv: ManifestDefinition = {
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, env: ["MISSING_ENV"] }],
    };
    const missingEnv = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withEnv,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });
    expect(missingEnv.failureKind).toBe("config");
  });

  it("classifies probe and send failures", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => {
        throw new CrablineError("bad auth", { kind: "auth" });
      },
      send: async () => {
        throw new Error("send exploded");
      },
      waitForInbound: async () => ({
        author: "assistant",
        id: "inbound",
        provider: "mock",
        sentAt: new Date().toISOString(),
        text: "wrong payload",
        threadId: "thread",
      }),
    };

    const probe = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      modeOverride: "probe",
      registry: buildRegistry(provider),
    });
    expect(probe.failureKind).toBe("auth");

    const roundtrip = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });
    expect(roundtrip.failureKind).toBe("assertion");
  });

  it("fails an otherwise successful fixture when cleanup fails", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "sent", threadId: "thread" }),
      waitForInbound: async (context) => ({
        author: "assistant",
        id: "inbound",
        provider: "mock",
        sentAt: new Date().toISOString(),
        text: `ACK ${context.nonce}`,
        threadId: "thread",
      }),
      cleanup: async () => {
        throw new Error("cleanup exploded");
      },
    };

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("assertion");
    expect(result.diagnostics).toContain("cleanup failed: cleanup exploded");
    expect(computeExitCode(result)).toBe(EXIT_CODES.ASSERTION);
  });

  it("preserves captured failures when cleanup fails", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => {
        throw new CrablineError("send failed", { kind: "outbound" });
      },
      waitForInbound: async () => null,
      cleanup: async () => {
        throw new Error("cleanup exploded");
      },
    };

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result).toMatchObject({
      failureKind: "outbound",
      ok: false,
    });
    expect(result.diagnostics).toEqual(["send failed", "cleanup failed: cleanup exploded"]);
  });

  it("preserves explicit CrablineError exit codes", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => {
        throw new CrablineError("custom failure", {
          exitCode: EXIT_CODES.AUTH,
          kind: "outbound",
        });
      },
      waitForInbound: async () => null,
    };

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.failureKind).toBe("outbound");
    expect(result.exitCode).toBe(EXIT_CODES.AUTH);
    expect(computeExitCode(result)).toBe(EXIT_CODES.AUTH);
  });

  it("computes suite exit codes", async () => {
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "sent", threadId: "thread" }),
      waitForInbound: async (context) => ({
        author: "assistant",
        id: "inbound",
        provider: "mock",
        sentAt: new Date().toISOString(),
        text: `ACK ${context.nonce}`,
        threadId: "thread",
      }),
    };

    const suite = await runSuite({
      fixtureIds: ["fixture"],
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(computeExitCode(suite)).toBe(0);
    expect(suite.totalPassed).toBe(1);
  });
});
