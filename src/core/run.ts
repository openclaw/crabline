import { matchesInbound } from "./matcher.js";
import { createOutboundText } from "./message-template.js";
import { createNonce } from "./nonces.js";
import { type FailureKind, CrablineError, ensureErrorMessage } from "./errors.js";
import type { ManifestDefinition } from "../config/schema.js";
import type { Registry } from "../providers/registry.js";

export type CommandRunResult = {
  diagnostics: string[];
  failureKind?: FailureKind | undefined;
  fixtureId: string;
  mode: string;
  nonce?: string | undefined;
  ok: boolean;
  providerId: string;
};

export type SuiteRunResult = {
  results: CommandRunResult[];
  totalPassed: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runFixtureCommand(params: {
  fixtureId: string;
  manifest: ManifestDefinition;
  manifestPath: string;
  modeOverride?: "agent" | "probe" | "roundtrip" | "send";
  registry: Registry;
}): Promise<CommandRunResult> {
  const fixture = params.manifest.fixtures.find((entry) => entry.id === params.fixtureId);
  if (!fixture) {
    throw new CrablineError(`Unknown fixture: ${params.fixtureId}`, { kind: "config" });
  }

  const provider = params.registry.resolve(fixture.provider, fixture.id);
  const mode = params.modeOverride ?? fixture.mode;
  const diagnostics: string[] = [];

  if (!provider.supports.includes(mode)) {
    return {
      diagnostics: [`provider ${fixture.provider} does not support mode ${mode}`],
      failureKind: "config",
      fixtureId: fixture.id,
      mode,
      ok: false,
      providerId: fixture.provider,
    };
  }

  for (const envName of [
    ...fixture.env,
    ...(params.manifest.providers[fixture.provider]?.env ?? []),
  ]) {
    if (!process.env[envName]) {
      return {
        diagnostics: [`missing env: ${envName}`],
        failureKind: "config",
        fixtureId: fixture.id,
        mode,
        ok: false,
        providerId: fixture.provider,
      };
    }
  }

  const contextBase = {
    config: params.manifest.providers[fixture.provider]!,
    fixture,
    manifestPath: params.manifestPath,
    providerId: fixture.provider,
    userName: params.manifest.userName,
  };

  try {
    if (mode === "probe") {
      try {
        const result = await provider.probe(contextBase);
        return {
          diagnostics: result.details,
          failureKind: result.healthy ? undefined : "connectivity",
          fixtureId: fixture.id,
          mode,
          ok: result.healthy,
          providerId: fixture.provider,
        };
      } catch (error) {
        return toFailure(fixture.id, fixture.provider, mode, error);
      }
    }

    let attempts = 0;
    const maxAttempts = fixture.retries + 1;
    let lastFailure: CommandRunResult | null = null;

    while (attempts < maxAttempts) {
      attempts += 1;
      const nonce = createNonce(fixture.id);

      try {
        const outboundText = createOutboundText({ ...fixture, mode }, nonce);
        const since = new Date().toISOString();
        const accepted = await provider.send({
          ...contextBase,
          mode,
          nonce,
          text: outboundText,
        });
        diagnostics.push(`accepted message ${accepted.messageId}`);

        if (mode === "send") {
          return {
            diagnostics,
            fixtureId: fixture.id,
            mode,
            nonce,
            ok: true,
            providerId: fixture.provider,
          };
        }

        const inbound = await provider.waitForInbound({
          ...contextBase,
          nonce,
          since,
          threadId: accepted.threadId,
          timeoutMs: fixture.timeoutMs,
        });
        if (!inbound) {
          lastFailure = {
            diagnostics: [
              ...diagnostics,
              `timed out waiting for inbound after ${fixture.timeoutMs}ms`,
            ],
            failureKind: "timeout",
            fixtureId: fixture.id,
            mode,
            nonce,
            ok: false,
            providerId: fixture.provider,
          };
          await sleep(50);
          continue;
        }

        if (!matchesInbound(inbound, fixture.inboundMatch, nonce)) {
          lastFailure = {
            diagnostics: [...diagnostics, `received non-matching inbound message ${inbound.id}`],
            failureKind: "assertion",
            fixtureId: fixture.id,
            mode,
            nonce,
            ok: false,
            providerId: fixture.provider,
          };
          await sleep(50);
          continue;
        }

        return {
          diagnostics: [...diagnostics, `matched inbound ${inbound.id}`],
          fixtureId: fixture.id,
          mode,
          nonce,
          ok: true,
          providerId: fixture.provider,
        };
      } catch (error) {
        lastFailure = toFailure(fixture.id, fixture.provider, mode, error, nonce);
      }
    }

    return (
      lastFailure ?? {
        diagnostics: ["unknown failure"],
        failureKind: "assertion",
        fixtureId: fixture.id,
        mode,
        ok: false,
        providerId: fixture.provider,
      }
    );
  } finally {
    await provider.cleanup?.();
  }
}

export async function runSuite(params: {
  fixtureIds: string[];
  manifest: ManifestDefinition;
  manifestPath: string;
  registry: Registry;
}): Promise<SuiteRunResult> {
  const results: CommandRunResult[] = [];
  for (const fixtureId of params.fixtureIds) {
    results.push(
      await runFixtureCommand({
        fixtureId,
        manifest: params.manifest,
        manifestPath: params.manifestPath,
        registry: params.registry,
      }),
    );
  }

  return {
    results,
    totalPassed: results.filter((entry) => entry.ok).length,
  };
}

export function computeExitCode(result: CommandRunResult | SuiteRunResult): number {
  if ("results" in result) {
    const failure = result.results.find((entry) => !entry.ok);
    return failure ? computeExitCode(failure) : 0;
  }

  if (result.ok) {
    return 0;
  }

  switch (result.failureKind) {
    case "auth":
      return 11;
    case "config":
      return 10;
    case "connectivity":
      return 12;
    case "outbound":
      return 13;
    case "inbound":
      return 14;
    case "timeout":
      return 15;
    case "assertion":
      return 16;
    default:
      return 1;
  }
}

function toFailure(
  fixtureId: string,
  providerId: string,
  mode: string,
  error: unknown,
  nonce?: string,
): CommandRunResult {
  const diagnostics = [ensureErrorMessage(error)];
  if (error instanceof CrablineError) {
    return {
      diagnostics,
      failureKind: error.kind,
      fixtureId,
      mode,
      nonce,
      ok: false,
      providerId,
    };
  }

  return {
    diagnostics,
    failureKind: "assertion",
    fixtureId,
    mode,
    nonce,
    ok: false,
    providerId,
  };
}
