import { matchesInbound } from "./matcher.js";
import { createOutboundText } from "./message-template.js";
import { createNonce } from "./nonces.js";
import { inboundRegexSafetyError } from "./safe-regex.js";
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
const MAX_EXCLUDED_INBOUND_IDS = 1_024;
const MAX_SCRIPT_STDIN_BYTES = 1024 * 1024;
const suiteBlockingResults = new WeakSet<CommandRunResult>();

type ObservedProviderOperation<T> = {
  isSettled(): boolean;
  promise: Promise<T>;
  settled: Promise<void>;
};

class UnsettledProviderOperationError extends CrablineError {
  constructor(
    message: string,
    options: { cause?: unknown; kind: FailureKind },
    readonly operation: ObservedProviderOperation<unknown>,
  ) {
    super(message, options);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observeProviderOperation<T>(promise: Promise<T>): ObservedProviderOperation<T> {
  let operationSettled = false;
  const settled = promise.then(
    () => {
      operationSettled = true;
    },
    () => {
      operationSettled = true;
    },
  );
  return {
    isSettled: () => operationSettled,
    promise,
    settled,
  };
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

async function withFixtureDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const controller = new AbortController();
  const pending = observeProviderOperation(
    Promise.resolve().then(async () => await operation(controller.signal)),
  );
  const result = await raceInboundDeadline(pending.promise, timeoutMs);
  if (result === INBOUND_DEADLINE_REACHED) {
    const timeoutError = new CrablineError(
      `Provider ${operationName} timed out after ${timeoutMs}ms.`,
      {
        kind: "timeout",
      },
    );
    controller.abort(timeoutError);
    if (
      (await raceInboundDeadline(pending.settled, INBOUND_ABORT_GRACE_MS)) ===
      INBOUND_DEADLINE_REACHED
    ) {
      throw new UnsettledProviderOperationError(
        `Provider ${operationName} did not settle within ${INBOUND_ABORT_GRACE_MS}ms after abort.`,
        {
          cause: timeoutError,
          kind: "timeout",
        },
        pending,
      );
    }
    throw timeoutError;
  }
  return result;
}

async function withCleanupDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const result = await raceInboundDeadline(operation, timeoutMs);
  if (result === INBOUND_DEADLINE_REACHED) {
    throw new CrablineError(`Provider ${operationName} timed out after ${timeoutMs}ms.`, {
      kind: "timeout",
    });
  }
  return result;
}

function jsonStringByteLength(value: string, limit: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length && bytes <= limit; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a) {
      bytes += 2;
    } else if (code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function boundedJsonByteLength(
  value: unknown,
  limit: number,
  ancestors = new Set<object>(),
  arrayEntry = false,
): number {
  if (value === null || value === undefined || typeof value === "function") {
    return value === undefined && !arrayEntry ? 0 : 4;
  }
  if (typeof value === "string") {
    return jsonStringByteLength(value, limit);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value).length : 4;
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (typeof value !== "object") {
    return 0;
  }
  if (ancestors.has(value)) {
    throw new CrablineError("Script command input must not contain circular values.", {
      kind: "config",
    });
  }

  ancestors.add(value);
  let bytes = 2;
  let entries = 0;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entries > 0) {
        bytes += 1;
      }
      bytes += boundedJsonByteLength(entry, limit - bytes, ancestors, true);
      entries += 1;
      if (bytes > limit) {
        break;
      }
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function") {
        continue;
      }
      if (entries > 0) {
        bytes += 1;
      }
      bytes += jsonStringByteLength(key, limit - bytes) + 1;
      bytes += boundedJsonByteLength(entry, limit - bytes, ancestors);
      entries += 1;
      if (bytes > limit) {
        break;
      }
    }
  }
  ancestors.delete(value);
  return bytes;
}

export function assertScriptStdinPayloadSize(payload: unknown): void {
  if (boundedJsonByteLength(payload, MAX_SCRIPT_STDIN_BYTES) > MAX_SCRIPT_STDIN_BYTES) {
    throw new CrablineError(`Script command input exceeded ${MAX_SCRIPT_STDIN_BYTES} bytes.`, {
      kind: "config",
    });
  }
}

function scriptPayloadBase(context: {
  config: ManifestDefinition["providers"][string];
  fixture: ManifestDefinition["fixtures"][number];
  manifestPath: string;
  providerId: string;
}): object {
  return {
    fixture: context.fixture,
    provider: {
      config: context.config,
      id: context.providerId,
      manifestPath: context.manifestPath,
    },
  };
}

async function abortAndDrainInboundWait(
  operation: ObservedProviderOperation<unknown>,
  controller: AbortController,
): Promise<boolean> {
  controller.abort(new Error("Inbound wait deadline reached."));
  return (
    (await raceInboundDeadline(operation.settled, INBOUND_ABORT_GRACE_MS)) !==
    INBOUND_DEADLINE_REACHED
  );
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
  let abortDrainFailed = false;
  const unsettledProviderOperations: ObservedProviderOperation<unknown>[] = [];

  const contextBase = {
    config: params.manifest.providers[fixture.provider]!,
    fixture,
    manifestPath: params.manifestPath,
    providerId: fixture.provider,
    userName: params.manifest.userName,
  };

  let result: CommandRunResult | undefined;
  try {
    if (!provider.supports.includes(mode)) {
      result = {
        diagnostics: [`provider ${fixture.provider} does not support mode ${mode}`],
        failureKind: "config",
        fixtureId: fixture.id,
        mode,
        ok: false,
        providerId: fixture.provider,
      };
    }

    if (!result) {
      for (const envName of [
        ...fixture.env,
        ...(params.manifest.providers[fixture.provider]?.env ?? []),
      ]) {
        if (!process.env[envName]) {
          result = {
            diagnostics: [`missing env: ${envName}`],
            failureKind: "config",
            fixtureId: fixture.id,
            mode,
            ok: false,
            providerId: fixture.provider,
          };
          break;
        }
      }
    }

    if (result) {
      // Preflight failures still flow through provider cleanup before returning.
    } else if (mode === "probe") {
      try {
        if (contextBase.config.adapter === "script") {
          assertScriptStdinPayloadSize(scriptPayloadBase(contextBase));
        }
        const probeResult = await withFixtureDeadline(
          async (signal) => await provider.probe({ ...contextBase, signal }),
          fixture.timeoutMs,
          "probe",
        );
        return (result = {
          diagnostics: probeResult.details,
          failureKind: probeResult.healthy ? undefined : "connectivity",
          fixtureId: fixture.id,
          mode,
          ok: probeResult.healthy,
          providerId: fixture.provider,
        });
      } catch (error) {
        if (error instanceof UnsettledProviderOperationError) {
          abortDrainFailed = true;
          unsettledProviderOperations.push(error.operation);
        }
        return (result = toFailure(fixture.id, fixture.provider, mode, error, "connectivity"));
      }
    } else {
      if (fixture.inboundMatch.strategy === "regex" && fixture.inboundMatch.pattern) {
        try {
          RegExp(fixture.inboundMatch.pattern, "u");
          const safetyError = inboundRegexSafetyError(fixture.inboundMatch.pattern);
          if (safetyError) {
            throw new Error(safetyError);
          }
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
            const sendContext = {
              ...contextBase,
              mode,
              nonce,
              text: outboundText,
            };
            if (contextBase.config.adapter === "script") {
              assertScriptStdinPayloadSize({
                ...scriptPayloadBase(contextBase),
                outbound: {
                  mode,
                  nonce,
                  target: fixture.target,
                  text: outboundText,
                },
              });
            }
            accepted = await withFixtureDeadline(
              async (signal) => await provider.send({ ...sendContext, signal }),
              fixture.timeoutMs,
              "send",
            );
          } catch (error) {
            lastFailure = toFailure(fixture.id, fixture.provider, mode, error, "outbound", nonce);
            if (error instanceof UnsettledProviderOperationError) {
              abortDrainFailed = true;
              unsettledProviderOperations.push(error.operation);
              break;
            }
            continue;
          }
          if (!accepted.accepted) {
            lastFailure = toFailure(
              fixture.id,
              fixture.provider,
              mode,
              new CrablineError(`Provider rejected outbound message ${accepted.messageId}.`, {
                kind: "outbound",
              }),
              "outbound",
              nonce,
            );
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
          const excludedInboundIds = new Set<string>();
          let inbound;
          try {
            while (Date.now() < inboundDeadline) {
              const timeoutMs = inboundDeadline - Date.now();
              const controller = new AbortController();
              const excludeIds = [...excludedInboundIds];
              const waitContext = {
                ...contextBase,
                excludeIds,
                nonce,
                signal: controller.signal,
                since,
                threadId: accepted.threadId,
                timeoutMs,
              };
              if (contextBase.config.adapter === "script") {
                assertScriptStdinPayloadSize({
                  ...scriptPayloadBase(contextBase),
                  wait: {
                    excludeIds,
                    nonce,
                    since,
                    target: fixture.target,
                    threadId: accepted.threadId,
                    timeoutMs,
                  },
                });
              }
              const wait = observeProviderOperation(provider.waitForInbound(waitContext));
              const candidate = await raceInboundDeadline(wait.promise, timeoutMs);
              if (candidate === INBOUND_DEADLINE_REACHED) {
                if (!(await abortAndDrainInboundWait(wait, controller))) {
                  abortDrainFailed = true;
                  unsettledProviderOperations.push(wait);
                  throw new UnsettledProviderOperationError(
                    `Provider inbound wait did not settle within ${INBOUND_ABORT_GRACE_MS}ms after abort.`,
                    { kind: "inbound" },
                    wait,
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
              if (!excludedInboundIds.has(candidate.id)) {
                if (excludedInboundIds.size >= MAX_EXCLUDED_INBOUND_IDS) {
                  throw new CrablineError(
                    `Provider returned more than ${MAX_EXCLUDED_INBOUND_IDS} unmatched inbound message IDs.`,
                    { kind: "inbound" },
                  );
                }
                excludedInboundIds.add(candidate.id);
              }
            }
          } catch (error) {
            lastFailure = toFailure(fixture.id, fixture.provider, mode, error, "inbound", nonce);
            if (abortDrainFailed) {
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
            if (attempts < maxAttempts) {
              await sleep(50);
            }
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
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      provider.beginCleanup?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const cleanup = provider.cleanup?.();
      if (cleanup) {
        if (
          abortDrainFailed &&
          (await raceInboundDeadline(cleanup, INBOUND_ABORT_GRACE_MS)) === INBOUND_DEADLINE_REACHED
        ) {
          cleanupErrors.push(
            new Error(
              `Provider cleanup did not settle within ${INBOUND_ABORT_GRACE_MS}ms after an aborted operation.`,
            ),
          );
        }
        if (!abortDrainFailed) {
          await withCleanupDeadline(cleanup, fixture.timeoutMs, "cleanup");
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const cleanupError =
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(
              cleanupErrors,
              cleanupErrors.map((error) => ensureErrorMessage(error)).join("; "),
            );
      const diagnostic = `cleanup failed: ${ensureErrorMessage(cleanupError)}`;
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
    await Promise.resolve();
    if (result && unsettledProviderOperations.some((operation) => !operation.isSettled())) {
      suiteBlockingResults.add(result);
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
    let result: CommandRunResult;
    try {
      result = await runFixtureCommand({
        fixtureId,
        manifest: params.manifest,
        manifestPath: params.manifestPath,
        registry: params.registry,
      });
    } catch (error) {
      const fixture = params.manifest.fixtures.find((entry) => entry.id === fixtureId);
      const provider = fixture ? params.manifest.providers[fixture.provider] : undefined;
      if (
        !fixture ||
        (provider?.status !== "disabled" && provider?.status !== "planned") ||
        !(error instanceof CrablineError) ||
        error.kind !== "config"
      ) {
        throw error;
      }
      result = toFailure(fixture.id, fixture.provider, fixture.mode, error, "config");
    }
    results.push(result);
    if (suiteBlockingResults.has(result)) {
      break;
    }
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
