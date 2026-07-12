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

  it("rejects an invalid inbound regex before sending", async () => {
    let sendCalls = 0;
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
        sendCalls += 1;
        return { accepted: true, messageId: "1", threadId: "1" };
      },
      waitForInbound: async () => null,
    };
    const invalidManifest = withAllCapabilities({
      ...manifest,
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          inboundMatch: {
            author: "assistant",
            nonce: "contains",
            pattern: "[",
            strategy: "regex",
          },
          retries: 2,
        },
      ],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: invalidManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.failureKind).toBe("config");
    expect(result.diagnostics.join("\n")).toContain("Invalid inbound regex");
    expect(sendCalls).toBe(0);
  });

  it("uses one effective fixture for mode overrides in provider contexts", async () => {
    const contextFixtures: ManifestDefinition["fixtures"] = [];
    let outboundText = "";
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async (context) => {
        contextFixtures.push(context.fixture);
        return { details: [], healthy: true };
      },
      send: async (context) => {
        contextFixtures.push(context.fixture);
        outboundText = context.text;
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async (context) => {
        contextFixtures.push(context.fixture);
        return {
          author: "assistant",
          id: "inbound",
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: `ACK ${context.nonce}`,
          threadId: "thread",
        };
      },
    };
    const capableManifest = withAllCapabilities(manifest);

    const agent = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: capableManifest,
      manifestPath: "/tmp/crabline.yaml",
      modeOverride: "agent",
      registry: buildRegistry(provider),
    });
    const probe = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: capableManifest,
      manifestPath: "/tmp/crabline.yaml",
      modeOverride: "probe",
      registry: buildRegistry(provider),
    });

    expect(agent.ok).toBe(true);
    expect(probe.ok).toBe(true);
    expect(contextFixtures[0]).toBe(contextFixtures[1]);
    expect(contextFixtures[0]?.mode).toBe("agent");
    expect(contextFixtures[2]?.mode).toBe("probe");
    expect(capableManifest.fixtures[0]?.mode).toBe("roundtrip");
    expect(outboundText).toContain("crabline agent fixture");
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
    expect(roundtrip.failureKind).toBe("outbound");
  });

  it("classifies plain provider failures by execution stage", async () => {
    let stage: "probe" | "send" | "wait" = "probe";
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => {
        throw new Error("probe exploded");
      },
      send: async () => {
        if (stage === "send") {
          throw new Error("send exploded");
        }
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async () => {
        throw new Error("wait exploded");
      },
    };
    const run = (modeOverride?: "probe") =>
      runFixtureCommand({
        fixtureId: "fixture",
        manifest: withAllCapabilities(manifest),
        manifestPath: "/tmp/crabline.yaml",
        ...(modeOverride ? { modeOverride } : {}),
        registry: buildRegistry(provider),
      });

    expect((await run("probe")).failureKind).toBe("connectivity");
    stage = "send";
    expect((await run()).failureKind).toBe("outbound");
    stage = "wait";
    expect((await run()).failureKind).toBe("inbound");
  });

  it("keeps waiting through unrelated inbound messages without resending", async () => {
    let sendCalls = 0;
    let waitCalls = 0;
    let unrelated:
      | {
          author: "assistant";
          id: string;
          provider: string;
          sentAt: string;
          text: string;
          threadId: string;
        }
      | undefined;
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
        sendCalls += 1;
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async (context) => {
        waitCalls += 1;
        unrelated ??= {
          author: "assistant",
          id: "unrelated",
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: "not the requested nonce",
          threadId: "thread",
        };
        if (waitCalls <= 2) {
          return unrelated;
        }
        return {
          author: "assistant",
          id: "matched",
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: `ACK ${context.nonce}`,
          threadId: "thread",
        };
      },
    };
    const retryingManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, retries: 1, timeoutMs: 100 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: retryingManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContain("matched inbound matched");
    expect(sendCalls).toBe(1);
    expect(waitCalls).toBe(3);
  });

  it("bounds repeated inbound envelopes by the fixture deadline", async () => {
    let sendCalls = 0;
    let waitCalls = 0;
    const repeated = {
      author: "assistant" as const,
      id: "repeated",
      provider: "mock",
      sentAt: new Date().toISOString(),
      text: "not the requested nonce",
      threadId: "thread",
    };
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
        sendCalls += 1;
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async () => {
        waitCalls += 1;
        return repeated;
      },
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 35 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.failureKind).toBe("timeout");
    expect(sendCalls).toBe(1);
    expect(waitCalls).toBeGreaterThan(1);
    expect(waitCalls).toBeLessThan(10);
  });

  it("bounds a hung inbound provider by the core deadline", async () => {
    let rejectWait: ((error: Error) => void) | undefined;
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
      waitForInbound: async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectWait = reject;
        }),
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 20 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.failureKind).toBe("inbound");
    expect(result.diagnostics.join("\n")).toContain("did not settle within 250ms after abort");
    rejectWait?.(new Error("late provider failure"));
    await Promise.resolve();
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
