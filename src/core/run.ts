import { matchesInbound } from "./matcher.js";
import { createOutboundText } from "./message-template.js";
import { createNonce } from "./nonces.js";
import { type FailureKind, CrablineError, ensureErrorMessage } from "./errors.js";
import { EXIT_CODES, type ExitCode } from "./exit-codes.js";
import type { ManifestDefinition } from "../config/schema.js";
import type { Registry } from "../providers/registry.js";

export type CommandRunResult = {
  diagnostics: string[];
  exitCode?: ExitCode | undefined;
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

const INBOUND_DEADLINE_REACHED = Symbol("inbound deadline reached");
const INBOUND_ABORT_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceInboundDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof INBOUND_DEADLINE_REACHED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof INBOUND_DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(INBOUND_DEADLINE_REACHED), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function abortAndDrainInboundWait(
  operation: Promise<unknown>,
  controller: AbortController,
): Promise<boolean> {
  controller.abort(new Error("Inbound wait deadline reached."));
  const settled = operation.then(
    () => true,
    () => true,
  );
  return (await raceInboundDeadline(settled, INBOUND_ABORT_GRACE_MS)) !== INBOUND_DEADLINE_REACHED;
}

export async function runFixtureCommand(params: {
  fixtureId: string;
  manifest: ManifestDefinition;
  manifestPath: string;
  modeOverride?: "agent" | "probe" | "roundtrip" | "send";
  registry: Registry;
}): Promise<CommandRunResult> {
  const configuredFixture = params.manifest.fixtures.find((entry) => entry.id === params.fixtureId);
  if (!configuredFixture) {
    throw new CrablineError(`Unknown fixture: ${params.fixtureId}`, { kind: "config" });
  }

  const mode = params.modeOverride ?? configuredFixture.mode;
  const fixture =
    mode === configuredFixture.mode ? configuredFixture : { ...configuredFixture, mode };
  const provider = params.registry.resolve(fixture.provider, fixture.id);
  const diagnostics: string[] = [];
  let deferredCleanupOperation: Promise<unknown> | null = null;

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

  let result: CommandRunResult | undefined;
  try {
    if (mode === "probe") {
      try {
        const probeResult = await provider.probe(contextBase);
        return (result = {
          diagnostics: probeResult.details,
          failureKind: probeResult.healthy ? undefined : "connectivity",
          fixtureId: fixture.id,
          mode,
          ok: probeResult.healthy,
          providerId: fixture.provider,
        });
      } catch (error) {
        return (result = toFailure(fixture.id, fixture.provider, mode, error, "connectivity"));
      }
    }

    if (fixture.inboundMatch.strategy === "regex" && fixture.inboundMatch.pattern) {
      try {
        RegExp(fixture.inboundMatch.pattern, "u");
      } catch (error) {
        return (result = toFailure(
          fixture.id,
          fixture.provider,
          mode,
          new CrablineError(`Invalid inbound regex: ${ensureErrorMessage(error)}`, {
            cause: error,
            kind: "config",
          }),
          "config",
        ));
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
        let accepted;
        try {
          accepted = await provider.send({
            ...contextBase,
            mode,
            nonce,
            text: outboundText,
          });
        } catch (error) {
          lastFailure = toFailure(fixture.id, fixture.provider, mode, error, "outbound", nonce);
          continue;
        }
        diagnostics.push(`accepted message ${accepted.messageId}`);

        if (mode === "send") {
          return (result = {
            diagnostics,
            fixtureId: fixture.id,
            mode,
            nonce,
            ok: true,
            providerId: fixture.provider,
          });
        }

        const inboundDeadline = Date.now() + fixture.timeoutMs;
        const seenInbound = new Set<string>();
        let inbound;
        try {
          while (Date.now() < inboundDeadline) {
            const timeoutMs = inboundDeadline - Date.now();
            const controller = new AbortController();
            const wait = provider.waitForInbound({
              ...contextBase,
              nonce,
              signal: controller.signal,
              since,
              threadId: accepted.threadId,
              timeoutMs,
            });
            const candidate = await raceInboundDeadline(wait, timeoutMs);
            if (candidate === INBOUND_DEADLINE_REACHED) {
              if (!(await abortAndDrainInboundWait(wait, controller))) {
                deferredCleanupOperation = wait;
                throw new CrablineError(
                  `Provider inbound wait did not settle within ${INBOUND_ABORT_GRACE_MS}ms after abort.`,
                  { kind: "inbound" },
                );
              }
              break;
            }
            if (!candidate) {
              break;
            }

            const key = JSON.stringify([candidate.provider, candidate.threadId, candidate.id]);
            if (seenInbound.has(key)) {
              await sleep(Math.min(10, Math.max(0, inboundDeadline - Date.now())));
              continue;
            }
            seenInbound.add(key);

            if (matchesInbound(candidate, fixture.inboundMatch, nonce)) {
              inbound = candidate;
              break;
            }
          }
        } catch (error) {
          lastFailure = toFailure(fixture.id, fixture.provider, mode, error, "inbound", nonce);
          if (deferredCleanupOperation) {
            break;
          }
          continue;
        }
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

        return (result = {
          diagnostics: [...diagnostics, `matched inbound ${inbound.id}`],
          fixtureId: fixture.id,
          mode,
          nonce,
          ok: true,
          providerId: fixture.provider,
        });
      } catch (error) {
        lastFailure = toFailure(fixture.id, fixture.provider, mode, error, "assertion", nonce);
      }
    }

    return (result = lastFailure ?? {
      diagnostics: ["unknown failure"],
      failureKind: "assertion",
      fixtureId: fixture.id,
      mode,
      ok: false,
      providerId: fixture.provider,
    });
  } finally {
    if (deferredCleanupOperation) {
      void deferredCleanupOperation
        .catch(() => undefined)
        .then(async () => await provider.cleanup?.())
        .catch(() => undefined);
    } else {
      try {
        await provider.cleanup?.();
      } catch (error) {
        const diagnostic = `cleanup failed: ${ensureErrorMessage(error)}`;
        if (result) {
          result.diagnostics.push(diagnostic);
          if (result.ok) {
            result.exitCode = EXIT_CODES.ASSERTION;
            result.failureKind = "assertion";
            result.ok = false;
          }
        } else {
          result = {
            diagnostics: [...diagnostics, diagnostic],
            exitCode: EXIT_CODES.ASSERTION,
            failureKind: "assertion",
            fixtureId: fixture.id,
            mode,
            ok: false,
            providerId: fixture.provider,
          };
        }
      }
    }
  }

  // The finally block can synthesize a result when provider cleanup fails.
  // oxlint-disable-next-line no-unreachable
  return result!;
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

  if (result.exitCode !== undefined) {
    return result.exitCode;
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
  fallbackKind: FailureKind,
  nonce?: string,
): CommandRunResult {
  const diagnostics = [ensureErrorMessage(error)];
  if (error instanceof CrablineError) {
    return {
      diagnostics,
      exitCode: error.exitCode,
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
    failureKind: fallbackKind,
    fixtureId,
    mode,
    nonce,
    ok: false,
    providerId,
  };
}
