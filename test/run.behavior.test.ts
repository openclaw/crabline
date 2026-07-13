import { describe, expect, it, vi } from "vitest";
import { RE2JS } from "re2js";
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

  it("returns config failures for unsupported modes and missing env after cleanup", async () => {
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
      cleanup: async () => {
        throw new Error("preflight cleanup exploded");
      },
    };

    const unsupported = await runFixtureCommand({
      fixtureId: "fixture",
      manifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });
    expect(unsupported.failureKind).toBe("config");
    expect(unsupported.diagnostics).toContain("cleanup failed: preflight cleanup exploded");

    const withEnv: ManifestDefinition = {
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, env: ["MISSING_ENV"] }],
    };
    const missingEnv = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withEnv,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry({
        ...provider,
        supports: ["probe", "send", "roundtrip", "agent"],
      }),
    });
    expect(missingEnv.failureKind).toBe("config");
    expect(missingEnv.diagnostics).toContain("missing env: MISSING_ENV");
    expect(missingEnv.diagnostics).toContain("cleanup failed: preflight cleanup exploded");
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

  it("rejects regex syntax unsupported by the linear-time matcher before sending", async () => {
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
    const unsupportedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          inboundMatch: {
            author: "assistant",
            nonce: "ignore",
            pattern: String.raw`^(a)\1$`,
            strategy: "regex",
          },
        },
      ],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: unsupportedManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.failureKind).toBe("config");
    expect(result.diagnostics.join("\n")).toContain("Invalid inbound regex");
    expect(sendCalls).toBe(0);
  });

  it("compiles an inbound regex once while checking multiple candidates", async () => {
    let waitCalls = 0;
    const compileSpy = vi.spyOn(RE2JS, "compile");
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["roundtrip"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "sent", threadId: "thread" }),
      waitForInbound: async () => {
        waitCalls += 1;
        return {
          author: "assistant",
          id: `inbound-${waitCalls}`,
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: waitCalls === 3 ? "expected reply" : "unrelated reply",
          threadId: "thread",
        };
      },
    };
    const regexManifest = withAllCapabilities({
      ...manifest,
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          inboundMatch: {
            author: "assistant",
            nonce: "ignore",
            pattern: "^expected reply$",
            strategy: "regex",
          },
          timeoutMs: 100,
        },
      ],
    });

    try {
      const result = await runFixtureCommand({
        fixtureId: "fixture",
        manifest: regexManifest,
        manifestPath: "/tmp/crabline.yaml",
        registry: buildRegistry(provider),
      });

      expect(result.ok).toBe(true);
      expect(waitCalls).toBe(3);
      expect(compileSpy).toHaveBeenCalledTimes(1);
    } finally {
      compileSpy.mockRestore();
    }
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

  it("requires an exact ACK and canonical nonce for agent replies", async () => {
    let waitCalls = 0;
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "sent", threadId: "thread" }),
      waitForInbound: async (context) => {
        waitCalls += 1;
        const texts = [
          `HACK ${context.nonce}`,
          "ACK mp-other-def-8765dcba",
          `ACK ${context.nonce}`,
        ];
        return {
          author: "assistant",
          id: `inbound-${waitCalls}`,
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: texts[waitCalls - 1]!,
          threadId: "thread",
        };
      },
    };
    const agentManifest = withAllCapabilities({
      ...manifest,
      fixtures: [
        {
          ...manifest.fixtures[0]!,
          inboundMatch: { author: "assistant", nonce: "ignore", strategy: "contains" },
          mode: "agent",
          timeoutMs: 100,
        },
      ],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: agentManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.ok).toBe(true);
    expect(waitCalls).toBe(3);
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

  it("bounds hung probe and send operations by the fixture timeout", async () => {
    let abortedOperations = 0;
    const waitForAbort = async (signal: AbortSignal | undefined): Promise<never> =>
      await new Promise((_, reject) => {
        if (!signal) {
          reject(new Error("missing provider cancellation signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            abortedOperations += 1;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe", "send", "roundtrip", "agent"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async (context) => await waitForAbort(context.signal),
      send: async (context) => await waitForAbort(context.signal),
      waitForInbound: async () => null,
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 10 }],
    });

    const probe = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      modeOverride: "probe",
      registry: buildRegistry(provider),
    });
    const send = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      modeOverride: "send",
      registry: buildRegistry(provider),
    });

    expect(probe).toMatchObject({ failureKind: "timeout", ok: false });
    expect(probe.diagnostics).toContain("Provider probe timed out after 10ms.");
    expect(send).toMatchObject({ failureKind: "timeout", ok: false });
    expect(send.diagnostics).toContain("Provider send timed out after 10ms.");
    expect(abortedOperations).toBe(2);
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

  it("retries rejected outbound results and fails when rejection persists", async () => {
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
        return {
          accepted: sendCalls > 1,
          messageId: `sent-${sendCalls}`,
          threadId: "thread",
        };
      },
      waitForInbound: async (context) => ({
        author: "assistant",
        id: "inbound",
        provider: "mock",
        sentAt: new Date().toISOString(),
        text: `ACK ${context.nonce}`,
        threadId: "thread",
      }),
    };
    const retryingManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, retries: 1 }],
    });

    const recovered = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: retryingManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });
    expect(recovered.ok).toBe(true);
    expect(sendCalls).toBe(2);

    sendCalls = 0;
    provider.send = async () => {
      sendCalls += 1;
      return { accepted: false, messageId: `rejected-${sendCalls}`, threadId: "thread" };
    };
    const rejected = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: retryingManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });
    expect(rejected).toMatchObject({ failureKind: "outbound", ok: false });
    expect(rejected.diagnostics).toContain("Provider rejected outbound message rejected-2.");
    expect(sendCalls).toBe(2);
  });

  it("begins cleanup before cleanup on preflight failures", async () => {
    const events: string[] = [];
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["probe"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "sent", threadId: "thread" }),
      waitForInbound: async () => null,
      beginCleanup() {
        events.push("begin");
      },
      async cleanup() {
        events.push("cleanup");
      },
    };

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: withAllCapabilities(manifest),
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result).toMatchObject({ failureKind: "config", ok: false });
    expect(events).toEqual(["begin", "cleanup"]);
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

  it("advances stateless inbound waits past unmatched envelopes", async () => {
    let sendCalls = 0;
    let unrelatedSentAt = "";
    let matchedSentAt = "";
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
        const base = Date.now() + 100;
        unrelatedSentAt = new Date(base).toISOString();
        matchedSentAt = new Date(base + 100).toISOString();
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async (context) => {
        if (
          Date.parse(context.since) <= Date.parse(unrelatedSentAt) &&
          !context.excludeIds?.includes("unrelated")
        ) {
          return {
            author: "assistant",
            id: "unrelated",
            provider: "mock",
            sentAt: unrelatedSentAt,
            text: "not the requested nonce",
            threadId: "thread",
          };
        }
        return {
          author: "assistant",
          id: "matched",
          provider: "mock",
          sentAt: matchedSentAt,
          text: `ACK ${context.nonce}`,
          threadId: "thread",
        };
      },
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 100 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContain("matched inbound matched");
    expect(sendCalls).toBe(1);
  });

  it("preserves a later match that shares an unmatched envelope timestamp", async () => {
    let waitCalls = 0;
    let sharedSentAt = "";
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
        sharedSentAt = new Date(Date.now() + 100).toISOString();
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async (context) => {
        waitCalls += 1;
        if (Date.parse(context.since) > Date.parse(sharedSentAt)) {
          return null;
        }
        const messages = [
          {
            author: "assistant" as const,
            id: "unrelated",
            provider: "mock",
            sentAt: sharedSentAt,
            text: "not the requested nonce",
            threadId: "thread",
          },
          {
            author: "assistant" as const,
            id: "matched",
            provider: "mock",
            sentAt: sharedSentAt,
            text: `ACK ${context.nonce}`,
            threadId: "thread",
          },
        ];
        return messages.find((message) => !context.excludeIds?.includes(message.id)) ?? null;
      },
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 100 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContain("matched inbound matched");
    expect(waitCalls).toBe(2);
  });

  it("bounds repeated inbound envelopes by the fixture deadline", async () => {
    let sendCalls = 0;
    let waitCalls = 0;
    let maxExcludedIds = 0;
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
      waitForInbound: async (context) => {
        waitCalls += 1;
        maxExcludedIds = Math.max(maxExcludedIds, context.excludeIds?.length ?? 0);
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
    expect(maxExcludedIds).toBe(1);
  });

  it("bounds unique unmatched inbound IDs", async () => {
    let waitCalls = 0;
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
      waitForInbound: async () => {
        waitCalls += 1;
        return {
          author: "assistant",
          id: `unmatched-${waitCalls}`,
          provider: "mock",
          sentAt: new Date().toISOString(),
          text: "not the requested nonce",
          threadId: "thread",
        };
      },
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 5_000 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result.failureKind).toBe("inbound");
    expect(result.diagnostics).toContain(
      "Provider returned more than 1024 unmatched inbound message IDs.",
    );
    expect(waitCalls).toBe(1025);
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

  it("bounds ordinary provider cleanup by the fixture timeout", async () => {
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
      waitForInbound: async () => null,
      cleanup: async () => await new Promise(() => undefined),
    };
    const boundedManifest = withAllCapabilities({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, timeoutMs: 10 }],
    });

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: boundedManifest,
      manifestPath: "/tmp/crabline.yaml",
      modeOverride: "send",
      registry: buildRegistry(provider),
    });

    expect(result).toMatchObject({ failureKind: "assertion", ok: false });
    expect(result.diagnostics).toContain("cleanup failed: Provider cleanup timed out after 10ms.");
  });

  it("skips later fixtures while timed-out cleanup remains unsettled", async () => {
    let releaseCleanup: (() => void) | undefined;
    const firstProvider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["send"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => ({ accepted: true, messageId: "first", threadId: "thread" }),
      waitForInbound: async () => null,
      cleanup: async () =>
        await new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    };
    const secondProvider: ProviderAdapter = {
      ...firstProvider,
      send: async () => ({ accepted: true, messageId: "second", threadId: "thread" }),
      cleanup: async () => undefined,
    };
    const secondSend = vi.spyOn(secondProvider, "send");
    const suiteManifest: ManifestDefinition = {
      ...withAllCapabilities(manifest),
      fixtures: [
        { ...manifest.fixtures[0]!, id: "first", mode: "send", timeoutMs: 10 },
        { ...manifest.fixtures[0]!, id: "second", mode: "send", timeoutMs: 10 },
      ],
    };

    try {
      const suite = await runSuite({
        fixtureIds: ["first", "second"],
        manifest: suiteManifest,
        manifestPath: "/tmp/crabline.yaml",
        registry: {
          catalog: OPENCLAW_SUPPORT_CATALOG,
          resolve(_providerId, fixtureId) {
            return fixtureId === "first" ? firstProvider : secondProvider;
          },
        },
      });

      expect(suite.requestedFixtureIds).toEqual(["first", "second"]);
      expect(suite.skippedFixtureIds).toEqual(["second"]);
      expect(suite.results).toHaveLength(1);
      expect(suite.results[0]).toMatchObject({ failureKind: "assertion", ok: false });
      expect(suite.results[0]?.diagnostics).toContain(
        "cleanup failed: Provider cleanup timed out after 10ms.",
      );
      expect(secondSend).not.toHaveBeenCalled();
    } finally {
      releaseCleanup?.();
    }
  });

  it("rejects oversized script stdin payloads before provider dispatch", async () => {
    let sendCalls = 0;
    const provider: ProviderAdapter = {
      id: "mock",
      platform: "slack",
      status: "bridge",
      supports: ["send"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send: async () => {
        sendCalls += 1;
        return { accepted: true, messageId: "sent", threadId: "thread" };
      },
      waitForInbound: async () => null,
    };
    const scriptManifest: ManifestDefinition = {
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, mode: "send", provider: "mock" }],
      providers: {
        mock: {
          adapter: "script",
          capabilities: ["send"],
          env: [],
          notes: "x".repeat(1024 * 1024),
          platform: "slack",
          script: { commands: { send: "send" } },
          status: "active",
        },
      },
    };

    const result = await runFixtureCommand({
      fixtureId: "fixture",
      manifest: scriptManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: buildRegistry(provider),
    });

    expect(result).toMatchObject({ failureKind: "config", ok: false });
    expect(result.diagnostics).toContain("Script command input exceeded 1048576 bytes.");
    expect(sendCalls).toBe(0);
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

  it("records disabled and planned provider failures and continues the suite", async () => {
    const statusManifest: ManifestDefinition = {
      ...manifest,
      fixtures: [
        { ...manifest.fixtures[0]!, id: "disabled", provider: "disabled" },
        { ...manifest.fixtures[0]!, id: "planned", provider: "planned" },
      ],
      providers: {
        disabled: { ...manifest.providers.mock!, status: "disabled" },
        planned: { ...manifest.providers.mock!, status: "planned" },
      },
    };
    const suite = await runSuite({
      fixtureIds: ["disabled", "planned"],
      manifest: statusManifest,
      manifestPath: "/tmp/crabline.yaml",
      registry: {
        catalog: OPENCLAW_SUPPORT_CATALOG,
        resolve(providerId) {
          const status = statusManifest.providers[providerId]?.status;
          throw new CrablineError(`Provider "${providerId}" is ${status}.`, { kind: "config" });
        },
      },
    });

    expect(suite.results).toHaveLength(2);
    expect(suite.results.map((result) => result.failureKind)).toEqual(["config", "config"]);
    expect(suite.results.map((result) => result.providerId)).toEqual(["disabled", "planned"]);
  });

  it("does not hide unexpected failures for disabled providers", async () => {
    const disabledManifest: ManifestDefinition = {
      ...manifest,
      providers: {
        mock: { ...manifest.providers.mock!, status: "disabled" },
      },
    };
    const unexpected = new Error("unexpected registry failure");

    await expect(
      runSuite({
        fixtureIds: ["fixture"],
        manifest: disabledManifest,
        manifestPath: "/tmp/crabline.yaml",
        registry: {
          catalog: OPENCLAW_SUPPORT_CATALOG,
          resolve() {
            throw unexpected;
          },
        },
      }),
    ).rejects.toBe(unexpected);
  });

  it("stops the suite while aborted provider work remains unsettled", async () => {
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(
      async () =>
        await new Promise<{ accepted: boolean; messageId: string; threadId: string }>((resolve) => {
          releaseSend = () => resolve({ accepted: true, messageId: "late", threadId: "thread" });
        }),
    );
    const unsettledProvider: ProviderAdapter = {
      id: "mock",
      platform: "loopback",
      status: "ready",
      supports: ["send"],
      normalizeTarget(target) {
        return { id: target.id, metadata: target.metadata };
      },
      probe: async () => ({ details: [], healthy: true }),
      send,
      waitForInbound: async () => null,
      cleanup: async () => undefined,
    };
    const secondProvider = {
      ...unsettledProvider,
      send: async () => ({ accepted: true, messageId: "second", threadId: "thread" }),
    };
    const secondSend = vi.spyOn(secondProvider, "send");
    const suiteManifest: ManifestDefinition = {
      ...withAllCapabilities(manifest),
      fixtures: [
        { ...manifest.fixtures[0]!, id: "first", mode: "send", retries: 1, timeoutMs: 10 },
        { ...manifest.fixtures[0]!, id: "second", mode: "send", timeoutMs: 10 },
      ],
    };
    try {
      const suite = await runSuite({
        fixtureIds: ["first", "second"],
        manifest: suiteManifest,
        manifestPath: "/tmp/crabline.yaml",
        registry: {
          catalog: OPENCLAW_SUPPORT_CATALOG,
          resolve(_providerId, fixtureId) {
            return fixtureId === "first" ? unsettledProvider : secondProvider;
          },
        },
      });

      expect(suite.results).toHaveLength(1);
      expect(suite.requestedFixtureIds).toEqual(["first", "second"]);
      expect(suite.skippedFixtureIds).toEqual(["second"]);
      expect(suite.results[0]?.ok).toBe(false);
      expect(suite.results[0]?.diagnostics).toContain(
        "Provider send did not settle within 250ms after abort.",
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(secondSend).not.toHaveBeenCalled();
    } finally {
      releaseSend?.();
    }
  });
});
