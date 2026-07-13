import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import type {
  InboundEnvelope,
  ProviderAdapter,
  ProviderContext,
  SendContext,
  WaitContext,
  WatchContext,
} from "../types.js";

const MAX_SCRIPT_OUTPUT_BYTES = 1024 * 1024;
const SCRIPT_WAIT_EXIT_GRACE_MS = 250;
const WINDOWS_TERMINATION_TIMEOUT_MS = 5_000;

type ScriptWatchIterator = AsyncIterableIterator<InboundEnvelope> & {
  [Symbol.asyncIterator](): ScriptWatchIterator;
  return(): Promise<IteratorResult<InboundEnvelope, undefined>>;
  throw(error?: unknown): Promise<IteratorResult<InboundEnvelope, undefined>>;
};

type ScriptPayload = {
  fixture: ProviderContext["fixture"];
  provider: {
    config: ProviderContext["config"];
    id: string;
    manifestPath: string;
  };
};

type ScriptDiagnosticsSnapshot = {
  configuredCommands: string[];
  sensitiveEnvironmentValues: string[];
  sensitivePayloadValues: string[];
};

type SpawnedScriptChild = ChildProcessByStdio<Writable, Readable, Readable>;

const ScriptMessageSchema = z.object({
  author: z.enum(["assistant", "system", "user"]),
  id: z.string().min(1),
  raw: z.unknown().optional(),
  sentAt: z.string().min(1),
  text: z.string(),
  threadId: z.string().min(1),
});

const ScriptProbeResultSchema = z.object({
  details: z.array(z.string()).optional(),
  healthy: z.boolean(),
});

const ScriptSendResultSchema = z.object({
  accepted: z.boolean(),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
});

const ScriptInboundResultSchema = z
  .object({
    message: ScriptMessageSchema.optional(),
    timeout: z.boolean().optional(),
  })
  .refine(
    (result) =>
      (result.timeout === true && result.message === undefined) ||
      (result.timeout !== true && result.message !== undefined),
    { message: "result must contain either a message or timeout: true" },
  );

async function terminateChild(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      let taskkill: ChildProcess;
      try {
        taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        taskkill.kill("SIGKILL");
        finish();
      }, WINDOWS_TERMINATION_TIMEOUT_MS);
      timeout.unref();
      taskkill.once("close", finish);
      taskkill.once("error", finish);
    });
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may have exited with the shell.
    }
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "result"}: ${issue.message}`)
    .join("; ");
}

const sensitiveEnvironmentNameFragmentPattern =
  /(?:AUTH|BEARER|CREDENTIAL|KEY|PASS|PRIVATE|SECRET|TOKEN)/iu;
const nonSensitiveWorkingDirectoryNames = new Set(["PWD", "OLDPWD"]);

function isSensitiveEnvironmentName(name: string): boolean {
  const upperName = name.toUpperCase();
  return (
    sensitiveEnvironmentNameFragmentPattern.test(upperName) ||
    (!nonSensitiveWorkingDirectoryNames.has(upperName) && upperName.includes("PWD")) ||
    /PAT(?!H)/u.test(upperName)
  );
}

function commandContainsSensitiveValue(command: string): boolean {
  const assignments = [
    ...command.matchAll(/(?:^|[\s;&|])["']?([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/gu),
    ...command.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/giu),
    ...command.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}\s*\+?=/giu),
  ];
  if (assignments.some((match) => isSensitiveEnvironmentName(match[1] ?? ""))) {
    return true;
  }
  return [...command.matchAll(/(?:^|[\s;&|])["']?--([A-Za-z0-9][A-Za-z0-9_-]*)(?:=|\s)/gu)].some(
    (match) => isSensitiveEnvironmentName((match[1] ?? "").replaceAll("-", "_")),
  );
}

function snapshotSensitiveEnvironmentValues(): string[] {
  const representations = new Set<string>();
  const values = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        isSensitiveEnvironmentName(name) && value !== undefined && value.length > 0,
    )
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    representations.add(value);
    representations.add(JSON.stringify(value));
    representations.add(JSON.stringify(value).slice(1, -1));
  }
  return [...representations].sort((left, right) => right.length - left.length);
}

function redactSensitiveEnvironmentValues(
  detail: string,
  sensitiveEnvironmentValues: string[],
): string {
  let redacted = detail;
  for (const representation of sensitiveEnvironmentValues) {
    redacted = redacted.split(representation).join("[redacted environment value]");
  }
  return redacted;
}

function collectSensitivePayloadValues(
  value: unknown,
  values: Set<string>,
  seen: { nonSensitive: WeakSet<object>; sensitive: WeakSet<object> },
  sensitive = false,
): void {
  if (typeof value === "string") {
    if (sensitive && value.length > 0) {
      values.add(value);
      const serialized = JSON.stringify(value);
      values.add(serialized);
      values.add(serialized.slice(1, -1));
    }
    return;
  }
  if (sensitive && typeof value === "number" && Number.isFinite(value)) {
    values.add(String(value));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const visited = sensitive ? seen.sensitive : seen.nonSensitive;
  if (visited.has(value)) {
    return;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSensitivePayloadValues(entry, values, seen, sensitive);
    }
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    collectSensitivePayloadValues(
      entry,
      values,
      seen,
      sensitive || isSensitiveEnvironmentName(name),
    );
  }
}

function snapshotSensitivePayloadValues(payload: unknown): string[] {
  const values = new Set<string>();
  collectSensitivePayloadValues(payload, values, {
    nonSensitive: new WeakSet(),
    sensitive: new WeakSet(),
  });
  return [...values].sort((left, right) => right.length - left.length);
}

function redactSensitivePayloadValues(detail: string, sensitivePayloadValues: string[]): string {
  let redacted = detail;
  for (const value of sensitivePayloadValues) {
    redacted = redacted.split(value).join("[redacted configured value]");
  }
  return redacted;
}

function formatScriptError(
  summary: string,
  detail: string,
  command: string,
  diagnostics: ScriptDiagnosticsSnapshot,
): string {
  if (!detail.trim()) {
    return summary;
  }
  if (commandContainsSensitiveValue(command)) {
    return `${summary}\n[script diagnostics redacted]`;
  }
  let redacted = redactSensitivePayloadValues(
    redactSensitiveEnvironmentValues(detail, diagnostics.sensitiveEnvironmentValues),
    diagnostics.sensitivePayloadValues,
  );
  for (const configuredCommand of diagnostics.configuredCommands) {
    redacted = redacted.split(configuredCommand).join("[configured script command]");
  }
  redacted = redacted.trim();
  return redacted ? `${summary}\n${redacted}` : summary;
}

function createScriptDiagnosticsSnapshot(
  command: string,
  serializedPayload: string,
): ScriptDiagnosticsSnapshot {
  const payload = JSON.parse(serializedPayload) as unknown;
  const configuredCommands = new Set([command]);
  const commands = (
    payload as {
      provider?: { config?: { script?: { commands?: Record<string, unknown> } } };
    }
  ).provider?.config?.script?.commands;
  for (const configuredCommand of Object.values(commands ?? {})) {
    if (typeof configuredCommand === "string" && configuredCommand.length > 0) {
      configuredCommands.add(configuredCommand);
    }
  }
  return {
    configuredCommands: [...configuredCommands].sort((left, right) => right.length - left.length),
    sensitiveEnvironmentValues: snapshotSensitiveEnvironmentValues(),
    sensitivePayloadValues: snapshotSensitivePayloadValues(payload),
  };
}

function parseScriptJson<T>(params: {
  command: string;
  diagnostics: ScriptDiagnosticsSnapshot;
  output: string;
  schema: z.ZodType<T>;
}): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.output);
  } catch (error) {
    throw new CrablineError(
      formatScriptError(
        "Script command did not return valid JSON.",
        ensureErrorMessage(error),
        params.command,
        params.diagnostics,
      ),
      { kind: "config" },
    );
  }

  const result = params.schema.safeParse(parsed);
  if (!result.success) {
    throw new CrablineError(
      `Script command returned invalid result.\n${formatValidationError(result.error)}`,
      { kind: "config" },
    );
  }
  return result.data;
}

function runScript<T>(params: {
  acceptResultDuringTimeoutGrace?: ((result: T) => boolean) | undefined;
  command: string;
  cwd?: string | undefined;
  payload: unknown;
  schema: z.ZodType<T>;
  shell?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutGraceMs?: number | undefined;
  timeoutMs: number;
}): Promise<T> {
  if (params.signal?.aborted) {
    return Promise.reject(params.signal.reason ?? new Error("Script command aborted."));
  }
  const serializedPayload = JSON.stringify(params.payload);
  const diagnostics = createScriptDiagnosticsSnapshot(params.command, serializedPayload);
  return new Promise((resolve, reject) => {
    let child: SpawnedScriptChild;
    try {
      child = spawn(params.command, {
        cwd: params.cwd ? path.resolve(params.cwd) : process.cwd(),
        env: process.env,
        shell: params.shell ?? true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new CrablineError(
          formatScriptError(
            "Script command failed to start.",
            ensureErrorMessage(error),
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let deadlineExceeded = false;
    let outputBytes = 0;
    let settled = false;
    let timeoutGrace: NodeJS.Timeout | undefined;
    const abort = () => {
      finish(async () => {
        await terminateChild(child);
        reject(params.signal?.reason ?? new Error("Script command aborted."));
      });
    };

    const finish = (callback: () => Promise<void> | void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(timeoutGrace);
      params.signal?.removeEventListener("abort", abort);
      void callback();
    };

    const failForOutputLimit = () => {
      finish(async () => {
        await terminateChild(child);
        reject(
          new CrablineError(`Script command exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes of output.`, {
            kind: "connectivity",
          }),
        );
      });
    };

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        failForOutputLimit();
        return;
      }
      stdout.push(buffer);
    });

    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        failForOutputLimit();
        return;
      }
      stderr.push(buffer);
    });

    child.stdin.on("error", () => {
      // Child closure is reported through the process error/close handlers.
    });
    child.once("error", (error) => {
      finish(() => {
        reject(
          new CrablineError(
            formatScriptError(
              "Script command failed to start.",
              ensureErrorMessage(error),
              params.command,
              diagnostics,
            ),
            { kind: "connectivity" },
          ),
        );
      });
    });
    child.once("close", (code, signal) => {
      finish(() => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          reject(
            new CrablineError(
              formatScriptError(
                `Script command failed${signal ? ` (${signal})` : ""}.`,
                stderrText.trim() ? stderrText : stdoutText,
                params.command,
                diagnostics,
              ),
              { kind: "connectivity" },
            ),
          );
          return;
        }

        try {
          const result = parseScriptJson({
            command: params.command,
            diagnostics,
            output: stdoutText,
            schema: params.schema,
          });
          if (deadlineExceeded && !params.acceptResultDuringTimeoutGrace?.(result)) {
            reject(
              new CrablineError(`Script command timed out after ${params.timeoutMs}ms.`, {
                kind: "timeout",
              }),
            );
            return;
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    const failForTimeout = () => {
      finish(async () => {
        await terminateChild(child);
        reject(
          new CrablineError(`Script command timed out after ${params.timeoutMs}ms.`, {
            kind: "timeout",
          }),
        );
      });
    };
    const timeout = setTimeout(() => {
      const timeoutGraceMs = params.timeoutGraceMs ?? 0;
      if (timeoutGraceMs <= 0) {
        failForTimeout();
        return;
      }
      deadlineExceeded = true;
      timeoutGrace = setTimeout(failForTimeout, timeoutGraceMs);
      timeoutGrace.unref();
    }, params.timeoutMs);
    timeout.unref();

    if (params.signal?.aborted) {
      abort();
      return;
    }
    params.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(serializedPayload);
  });
}

function watchScript(params: {
  cancelSignal: AbortSignal;
  command: string;
  context: WatchContext;
  cwd?: string | undefined;
  id: string;
  normalizeTarget: ProviderAdapter["normalizeTarget"];
  shell?: string | undefined;
}): AsyncGenerator<InboundEnvelope> {
  return (async function* () {
    if (params.cancelSignal.aborted) {
      return;
    }
    if (params.context.signal?.aborted) {
      throw params.context.signal.reason ?? new Error("Script watch command aborted.");
    }
    const payload = {
      ...createPayload(params.context),
      watch: {
        since: params.context.since,
        target: params.normalizeTarget(params.context.fixture.target),
      },
    };
    const serializedPayload = JSON.stringify(payload);
    const diagnostics = createScriptDiagnosticsSnapshot(params.command, serializedPayload);
    let child: SpawnedScriptChild;
    try {
      child = spawn(params.command, {
        cwd: params.cwd ? path.resolve(params.cwd) : process.cwd(),
        env: process.env,
        shell: params.shell ?? true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new CrablineError(
        formatScriptError(
          "Script watch command failed to start.",
          ensureErrorMessage(error),
          params.command,
          diagnostics,
        ),
        { kind: "connectivity" },
      );
    }

    let buffer = "";
    let stderr = "";
    let childError: unknown;
    let outputLimitError: CrablineError | undefined;
    const stopChild = () => {
      void terminateChild(child);
    };
    params.cancelSignal.addEventListener("abort", stopChild, { once: true });
    params.context.signal?.addEventListener("abort", stopChild, { once: true });
    if (params.cancelSignal.aborted || params.context.signal?.aborted) {
      stopChild();
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {
      // Child closure is reported through the process error/close handlers.
    });
    child.stderr.on("data", (chunk) => {
      if (outputLimitError) {
        return;
      }
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_SCRIPT_OUTPUT_BYTES) {
        outputLimitError = new CrablineError(
          `Script watch command exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes of stderr.`,
          { kind: "connectivity" },
        );
        void terminateChild(child);
      }
    });
    child.once("error", (error) => {
      childError = error;
    });
    let childCloseObserved = false;
    const childClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => {
          childCloseObserved = true;
          resolve({ code, signal });
        });
      },
    );
    child.stdin.end(serializedPayload);

    try {
      for await (const chunk of child.stdout) {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_SCRIPT_OUTPUT_BYTES && !buffer.includes("\n")) {
          throw new CrablineError(
            `Script watch command exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes without a newline.`,
            { kind: "config" },
          );
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          if (Buffer.byteLength(line) > MAX_SCRIPT_OUTPUT_BYTES) {
            throw new CrablineError(
              `Script watch command emitted a JSON line larger than ${MAX_SCRIPT_OUTPUT_BYTES} bytes.`,
              { kind: "config" },
            );
          }
          const parsed = parseScriptJson({
            command: params.command,
            diagnostics,
            output: line,
            schema: ScriptMessageSchema,
          });
          yield {
            ...parsed,
            provider: params.id,
          };
        }
      }

      if (params.context.signal?.aborted) {
        throw params.context.signal.reason ?? new Error("Script watch command aborted.");
      }
      if (params.cancelSignal.aborted) {
        return;
      }
      if (buffer.trim()) {
        const parsed = parseScriptJson({
          command: params.command,
          diagnostics,
          output: buffer,
          schema: ScriptMessageSchema,
        });
        yield {
          ...parsed,
          provider: params.id,
        };
      }

      const exit = await childClosed;
      if (outputLimitError) {
        throw outputLimitError;
      }
      if (childError) {
        throw new CrablineError(
          formatScriptError(
            "Script watch command failed to start.",
            ensureErrorMessage(childError),
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        );
      }
      if (exit.code !== 0) {
        throw new CrablineError(
          formatScriptError(
            `Script watch command failed${exit.signal ? ` (${exit.signal})` : ""}.`,
            stderr,
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        );
      }
    } catch (error) {
      if (params.cancelSignal.aborted) {
        return;
      }
      if (outputLimitError) {
        throw outputLimitError;
      }
      if (childError) {
        throw new CrablineError(
          formatScriptError(
            "Script watch command failed to start.",
            ensureErrorMessage(childError),
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        );
      }
      throw error;
    } finally {
      params.cancelSignal.removeEventListener("abort", stopChild);
      params.context.signal?.removeEventListener("abort", stopChild);
      child.stdin.destroy();
      if (!childCloseObserved) {
        await terminateChild(child);
      }
      await childClosed;
    }
  })();
}

function failedScriptWatch(error: unknown): ScriptWatchIterator {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return Promise.reject(error);
    },
    return() {
      return Promise.resolve({ done: true, value: undefined });
    },
    throw(thrown?: unknown) {
      return Promise.reject(thrown);
    },
  };
}

export class ScriptProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status = "bridge" as const;
  readonly supports;
  readonly #config;

  constructor(context: ProviderContext) {
    if (!context.config.script) {
      throw new CrablineError(`Provider "${context.providerId}" is missing script configuration.`, {
        kind: "config",
      });
    }

    this.id = context.providerId;
    this.platform = context.config.platform;
    this.supports = [...context.config.capabilities];
    this.#config = context.config.script;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]) {
    const normalized = {
      id: target.id,
      metadata: target.metadata,
    } as ReturnType<ProviderAdapter["normalizeTarget"]>;
    if (target.channelId) {
      normalized.channelId = target.channelId;
    }
    if (target.threadId) {
      normalized.threadId = target.threadId;
    }
    return normalized;
  }

  async probe(context: ProviderContext) {
    const command = this.#config.commands.probe;
    if (!command) {
      return {
        details: ["probe command not configured"],
        healthy: false,
      };
    }

    const result = await runScript({
      command,
      cwd: this.#config.cwd,
      payload: createPayload(context),
      schema: ScriptProbeResultSchema,
      shell: this.#config.shell,
      signal: context.signal,
      timeoutMs: context.fixture.timeoutMs,
    });
    return {
      details: result.details ?? [],
      healthy: result.healthy,
    };
  }

  async send(context: SendContext) {
    const command = this.#config.commands.send;
    if (!command) {
      throw new CrablineError(`Provider "${this.id}" is missing send command.`, {
        kind: "config",
      });
    }

    return runScript({
      command,
      cwd: this.#config.cwd,
      payload: {
        ...createPayload(context),
        outbound: {
          mode: context.mode,
          nonce: context.nonce,
          target: this.normalizeTarget(context.fixture.target),
          text: context.text,
        },
      },
      schema: ScriptSendResultSchema,
      shell: this.#config.shell,
      signal: context.signal,
      timeoutMs: context.fixture.timeoutMs,
    });
  }

  async waitForInbound(context: WaitContext) {
    const command = this.#config.commands.waitForInbound;
    if (!command) {
      return null;
    }

    const result = await runScript({
      acceptResultDuringTimeoutGrace: (candidate) => candidate.timeout === true,
      command,
      cwd: this.#config.cwd,
      payload: {
        ...createPayload(context),
        wait: {
          excludeIds: context.excludeIds ?? [],
          nonce: context.nonce,
          since: context.since,
          target: this.normalizeTarget(context.fixture.target),
          threadId: context.threadId,
          timeoutMs: context.timeoutMs,
        },
      },
      schema: ScriptInboundResultSchema,
      shell: this.#config.shell,
      signal: context.signal,
      timeoutGraceMs: SCRIPT_WAIT_EXIT_GRACE_MS,
      timeoutMs: context.timeoutMs,
    });

    if (result.timeout || !result.message) {
      return null;
    }

    return {
      ...result.message,
      provider: this.id,
    };
  }

  watch(context: WatchContext): ScriptWatchIterator {
    const command = this.#config.commands.watch;
    if (!command) {
      return failedScriptWatch(
        new CrablineError(`Provider "${this.id}" is missing watch command.`, {
          kind: "config",
        }),
      );
    }

    const controller = new AbortController();
    const source = watchScript({
      cancelSignal: controller.signal,
      command,
      context,
      cwd: this.#config.cwd,
      id: this.id,
      normalizeTarget: (target) => this.normalizeTarget(target),
      shell: this.#config.shell,
    });
    const iterator: ScriptWatchIterator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return source.next();
      },
      async return() {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        await source.return(undefined);
        return { done: true, value: undefined };
      },
      async throw(error?: unknown) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        await source.return(undefined);
        throw error;
      },
    };
    return iterator;
  }
}

function createPayload(context: ProviderContext): ScriptPayload {
  return {
    fixture: context.fixture,
    provider: {
      config: context.config,
      id: context.providerId,
      manifestPath: context.manifestPath,
    },
  };
}
