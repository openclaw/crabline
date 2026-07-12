import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import type {
  ProviderAdapter,
  ProviderContext,
  SendContext,
  WaitContext,
  WatchContext,
} from "../types.js";

const MAX_SCRIPT_OUTPUT_BYTES = 1024 * 1024;
const SCRIPT_WAIT_EXIT_GRACE_MS = 250;

type ScriptPayload = {
  fixture: ProviderContext["fixture"];
  provider: {
    config: ProviderContext["config"];
    id: string;
    manifestPath: string;
  };
};

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

function terminateChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
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

const sensitiveCommandValuePattern =
  /(?:^|[\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*=|--(?:api[-_]?key|auth|credential|pass(?:word)?|private[-_]?key|secret|token)(?:=|\s))/iu;

function formatScriptError(summary: string, detail: string, command: string): string {
  const trimmed = detail.trim();
  if (!trimmed) {
    return summary;
  }
  if (sensitiveCommandValuePattern.test(command)) {
    return `${summary}\n[script diagnostics redacted]`;
  }
  const redacted = trimmed.split(command).join("[configured script command]").trim();
  return redacted ? `${summary}\n${redacted}` : summary;
}

function parseScriptJson<T>(params: { command: string; output: string; schema: z.ZodType<T> }): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.output);
  } catch (error) {
    throw new CrablineError(
      formatScriptError(
        "Script command did not return valid JSON.",
        ensureErrorMessage(error),
        params.command,
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
  timeoutGraceMs?: number | undefined;
  timeoutMs: number;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, {
      cwd: params.cwd ? path.resolve(params.cwd) : process.cwd(),
      env: process.env,
      shell: params.shell ?? true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let deadlineExceeded = false;
    let outputBytes = 0;
    let settled = false;
    let timeoutGrace: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(timeoutGrace);
      callback();
    };

    const failForOutputLimit = () => {
      finish(() => {
        terminateChild(child);
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
                stderrText.trim() || stdoutText.trim(),
                params.command,
              ),
              { kind: "connectivity" },
            ),
          );
          return;
        }

        try {
          const result = parseScriptJson({
            command: params.command,
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
      finish(() => {
        terminateChild(child);
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

    child.stdin.end(JSON.stringify(params.payload));
  });
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
          nonce: context.nonce,
          since: context.since,
          target: this.normalizeTarget(context.fixture.target),
          timeoutMs: context.timeoutMs,
        },
      },
      schema: ScriptInboundResultSchema,
      shell: this.#config.shell,
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

  async *watch(context: WatchContext) {
    const command = this.#config.commands.watch;
    if (!command) {
      throw new CrablineError(`Provider "${this.id}" is missing watch command.`, {
        kind: "config",
      });
    }

    const child = spawn(command, {
      cwd: this.#config.cwd ? path.resolve(this.#config.cwd) : process.cwd(),
      env: process.env,
      shell: this.#config.shell ?? true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    let childError: unknown;
    let outputLimitError: CrablineError | undefined;
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
        terminateChild(child);
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
    child.stdin.end(
      JSON.stringify({
        ...createPayload(context),
        watch: {
          since: context.since,
          target: this.normalizeTarget(context.fixture.target),
        },
      }),
    );

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
            command,
            output: line,
            schema: ScriptMessageSchema,
          });
          yield {
            ...parsed,
            provider: this.id,
          };
        }
      }

      if (buffer.trim()) {
        const parsed = parseScriptJson({
          command,
          output: buffer,
          schema: ScriptMessageSchema,
        });
        yield {
          ...parsed,
          provider: this.id,
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
            command,
          ),
          { kind: "connectivity" },
        );
      }
      if (exit.code !== 0) {
        throw new CrablineError(
          formatScriptError(
            `Script watch command failed${exit.signal ? ` (${exit.signal})` : ""}.`,
            stderr,
            command,
          ),
          { kind: "connectivity" },
        );
      }
    } catch (error) {
      if (outputLimitError) {
        throw outputLimitError;
      }
      if (childError) {
        throw new CrablineError(
          formatScriptError(
            "Script watch command failed to start.",
            ensureErrorMessage(childError),
            command,
          ),
          { kind: "connectivity" },
        );
      }
      throw error;
    } finally {
      child.stdin.destroy();
      if (!childCloseObserved) {
        terminateChild(child);
      }
      await childClosed;
    }
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
