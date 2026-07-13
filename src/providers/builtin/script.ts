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
const CHILD_CLOSE_TIMEOUT_MS = 1_000;
const WINDOWS_TERMINATION_COMMAND_TIMEOUT_MS = 2_500;

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
  commandValues: string[];
  configuredCommands: string[];
  diagnosticsSafe: boolean;
  exactCommandValues: string[];
  sensitiveEnvironmentValues: string[];
  sensitivePayloadValues: string[];
};

type SpawnedScriptChild = ChildProcessByStdio<Writable, Readable, Readable>;
type ScriptChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
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

function runTerminationCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let cleanup: ChildProcess;
    try {
      cleanup = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(succeeded);
    };
    const timeout = setTimeout(() => {
      try {
        cleanup.kill("SIGKILL");
      } catch {
        // The cleanup process may have exited at the timeout boundary.
      }
      finish(false);
    }, WINDOWS_TERMINATION_COMMAND_TIMEOUT_MS);
    timeout.unref();
    cleanup.once("close", (code) => finish(code === 0));
    cleanup.once("error", () => finish(false));
  });
}

function windowsProcessTreeTermination(
  pid: number,
  childStartedAtMs: number,
  childObservedAtMs: number,
  rootExpectedAlive: boolean,
): string {
  const rootNotBeforeMs = Math.max(0, Math.floor(childStartedAtMs));
  const rootObservedByMs = Math.max(rootNotBeforeMs, Math.ceil(childObservedAtMs));
  return [
    "$ErrorActionPreference='Stop'",
    `$RootProcessId=${pid}`,
    `$RootExpectedAlive=$${rootExpectedAlive ? "true" : "false"}`,
    `$RootNotBefore=([datetime]'1970-01-01T00:00:00Z').AddMilliseconds(${rootNotBeforeMs})`,
    `$RootObservedBy=([datetime]'1970-01-01T00:00:00Z').AddMilliseconds(${rootObservedByMs})`,
    "$SnapshotAt=[datetime]::UtcNow",
    "$AllProcesses=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)",
    "$Snapshot=[System.Collections.Generic.List[object]]::new()",
    "$Pending=[System.Collections.Generic.Queue[object]]::new()",
    "$Visited=[System.Collections.Generic.HashSet[string]]::new()",
    "$RootProcess=$AllProcesses | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1",
    "$RootMatches=$null -ne $RootProcess -and [datetime]$RootProcess.CreationDate -ge $RootNotBefore -and [datetime]$RootProcess.CreationDate -le $RootObservedBy",
    "$RootPidReused=$null -ne $RootProcess -and (!$RootExpectedAlive -or !$RootMatches)",
    "$KillRoot=$RootExpectedAlive -and $RootMatches",
    "if($KillRoot){",
    "$Snapshot.Add($RootProcess)",
    '$Visited.Add("$([int]$RootProcess.ProcessId)|$(([datetime]$RootProcess.CreationDate).ToFileTimeUtc())") | Out-Null',
    "$Pending.Enqueue($RootProcess)",
    "}elseif(!$RootPidReused){",
    "$Pending.Enqueue([pscustomobject]@{ProcessId=$RootProcessId;CreationDate=$RootNotBefore})",
    "}",
    "while($Pending.Count -gt 0){",
    "$Parent=$Pending.Dequeue()",
    "foreach($Process in @($AllProcesses | Where-Object { [int]$_.ParentProcessId -eq [int]$Parent.ProcessId })){",
    "$ChildCreated=[datetime]$Process.CreationDate",
    "$ParentCreated=[datetime]$Parent.CreationDate",
    "if($ChildCreated -lt $ParentCreated -or $ChildCreated -gt $SnapshotAt){continue}",
    '$Identity="$([int]$Process.ProcessId)|$($ChildCreated.ToFileTimeUtc())"',
    "if(!$Visited.Add($Identity)){continue}",
    "$Snapshot.Add($Process)",
    "$Pending.Enqueue($Process)",
    "}",
    "}",
    "$TaskkillExitCode=-1",
    "if($KillRoot){",
    '$Taskkill=Start-Process taskkill.exe -ArgumentList @("/PID","$RootProcessId","/T","/F") -WindowStyle Hidden -PassThru',
    "if($Taskkill.WaitForExit(1000)){$TaskkillExitCode=$Taskkill.ExitCode}else{$Taskkill.Kill();$TaskkillExitCode=-1}",
    "}",
    "if($TaskkillExitCode -ne 0){",
    "$Entries=@($Snapshot)",
    "[array]::Reverse($Entries)",
    "foreach($Entry in $Entries){",
    '$Current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Entry.ProcessId)" -ErrorAction SilentlyContinue',
    "if($null -ne $Current -and $Current.CreationDate -eq $Entry.CreationDate){",
    "Stop-Process -Id ([int]$Entry.ProcessId) -Force -ErrorAction SilentlyContinue",
    "}",
    "}",
    "}",
  ].join(";");
}

function destroyChildPipes(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Pipe teardown is best effort after process-tree termination.
    }
  }
}

function isChildRunning(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  try {
    return child.kill(0);
  } catch {
    return false;
  }
}

async function terminateChild(
  child: ChildProcess,
  childStartedAtMs: number,
  childObservedAtMs: number,
): Promise<void> {
  try {
    const childRunning = isChildRunning(child);
    if (process.platform === "win32") {
      if (child.pid) {
        const cleaned = await runTerminationCommand("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsProcessTreeTermination(
            child.pid,
            childStartedAtMs,
            childObservedAtMs,
            childRunning,
          ),
        ]);
        if (!cleaned && isChildRunning(child)) {
          await runTerminationCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
        }
      }
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group may have exited with the shell.
      }
    }

    if (isChildRunning(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited while its descendants retained the pipes.
      }
    }
  } finally {
    destroyChildPipes(child);
  }
}

async function waitForChildClose(
  childClosed: Promise<ScriptChildExit>,
): Promise<ScriptChildExit | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    childClosed,
    new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), CHILD_CLOSE_TIMEOUT_MS);
      timeout.unref();
    }),
  ]);
  clearTimeout(timeout);
  return exit;
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "result"}: ${issue.message}`)
    .join("; ");
}

const sensitiveEnvironmentNameFragmentPattern =
  /(?:AUTH|BEARER|CREDENTIAL|JWT|KEY|PASS|PRIVATE|SECRET|TOKEN)/iu;
const nonSensitiveWorkingDirectoryNames = new Set(["PWD", "OLDPWD"]);

function isSensitiveEnvironmentName(name: string): boolean {
  const upperName = name.toUpperCase();
  return (
    sensitiveEnvironmentNameFragmentPattern.test(upperName) ||
    (!nonSensitiveWorkingDirectoryNames.has(upperName) && upperName.includes("PWD")) ||
    /PAT(?!H)/u.test(upperName)
  );
}

function redactCredentialSyntax(detail: string): string {
  let redacted = detail.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/giu,
    "$1[redacted credentials]@",
  );
  redacted = redacted.replace(
    /(\bauthorization\b["']?\s*[:=]\s*["']?\s*)(?:(basic|bearer)\s+)?([^\s"',;}]+)/giu,
    (_match, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme ? `${scheme} ` : ""}[redacted credential]`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(\+?=|:)\s*("[^"]*"|'[^']*'|[^,;}\]\r\n]+)/gu,
    (match, name: string, operator: string) =>
      name.toLowerCase() !== "authorization" && isSensitiveEnvironmentName(name)
        ? `${name}${operator}[redacted credential]`
        : match,
  );
  return redacted.replace(
    /--([A-Za-z0-9][A-Za-z0-9_-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gu,
    (match, name: string, separator: string) =>
      isSensitiveEnvironmentName(name.replaceAll("-", "_"))
        ? `--${name}${separator}[redacted credential]`
        : match,
  );
}

function commandContainsSensitiveValue(command: string): boolean {
  if (redactCredentialSyntax(command) !== command) {
    return true;
  }
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

function addRedactionRepresentations(values: Set<string>, value: string): void {
  if (!value) {
    return;
  }
  values.add(value);
  const serialized = JSON.stringify(value);
  values.add(serialized);
  values.add(serialized.slice(1, -1));
}

function addCommandValueRedactions(substringValues: Set<string>, value: string): void {
  addRedactionRepresentations(substringValues, value);
}

function tokenizeLiteralCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && /[$`%!]/u.test(character)) {
        return undefined;
      }
      if (character === "\\" && quote === '"') {
        return undefined;
      }
      current += character;
      continue;
    }
    if (character === '"' || (character === "'" && process.platform !== "win32")) {
      quote = character;
      continue;
    }
    if (character === "\n" || character === "\r") {
      return undefined;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (
      /[;&|<>(){}$`%!*?[\]~]/u.test(character) ||
      (process.platform === "win32" && character === "^")
    ) {
      return undefined;
    }
    if (character === "\\") {
      return undefined;
    }
    current += character;
  }
  if (quote) {
    return undefined;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function snapshotCommandValues(
  command: string,
): { exactValues: string[]; substringValues: string[] } | undefined {
  const tokens = tokenizeLiteralCommand(command);
  if (!tokens) {
    return undefined;
  }
  const exactValues = new Set<string>();
  const substringValues = new Set<string>();
  let executableSeen = false;
  for (const token of tokens) {
    if (!executableSeen) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/u.exec(token);
      if (assignment) {
        addCommandValueRedactions(substringValues, assignment[2] ?? "");
        continue;
      }
      executableSeen = true;
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(token)) {
      if (token.length < 3) {
        return undefined;
      }
      addRedactionRepresentations(exactValues, token);
      continue;
    }
    if (/^-[A-Za-z0-9][A-Za-z0-9_-]+$/u.test(token)) {
      addRedactionRepresentations(exactValues, token);
      addCommandValueRedactions(substringValues, token.slice(1));
      addCommandValueRedactions(substringValues, token.slice(2));
      continue;
    }
    const option = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.*)$/u.exec(token);
    if (option) {
      const value = option[1] ?? "";
      if (value.length < 3) {
        return undefined;
      }
      addCommandValueRedactions(substringValues, value);
      continue;
    }
    if (token.length < 3) {
      return undefined;
    }
    if (token.startsWith("-")) {
      addCommandValueRedactions(substringValues, token);
    } else {
      addRedactionRepresentations(substringValues, token);
    }
  }
  return {
    exactValues: [...exactValues].sort((left, right) => right.length - left.length),
    substringValues: [...substringValues].sort((left, right) => right.length - left.length),
  };
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
    addRedactionRepresentations(representations, value);
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

function redactCommandValues(detail: string, commandValues: string[]): string {
  let redacted = detail;
  for (const value of commandValues) {
    redacted = redacted.split(value).join("[redacted command value]");
  }
  return redacted;
}

function isExactCommandValueBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s"'`=,:;.()[\]{}<>!?]/u.test(character);
}

function redactExactCommandValues(detail: string, commandValues: string[]): string {
  let redacted = detail;
  for (const value of commandValues) {
    let cursor = 0;
    while (cursor < redacted.length) {
      const index = redacted.indexOf(value, cursor);
      if (index < 0) {
        break;
      }
      const end = index + value.length;
      if (
        isExactCommandValueBoundary(redacted[index - 1]) &&
        isExactCommandValueBoundary(redacted[end])
      ) {
        redacted = redacted.slice(0, index) + "[redacted command value]" + redacted.slice(end);
        cursor = index + "[redacted command value]".length;
      } else {
        cursor = end;
      }
    }
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
  if (!diagnostics.diagnosticsSafe || commandContainsSensitiveValue(command)) {
    return `${summary}\n[script diagnostics redacted]`;
  }
  let redacted = redactSensitivePayloadValues(
    redactSensitiveEnvironmentValues(detail, diagnostics.sensitiveEnvironmentValues),
    diagnostics.sensitivePayloadValues,
  );
  redacted = redactCredentialSyntax(redacted);
  for (const configuredCommand of diagnostics.configuredCommands) {
    redacted = redacted.split(configuredCommand).join("[configured script command]");
  }
  redacted = redactCommandValues(redacted, diagnostics.commandValues);
  redacted = redactExactCommandValues(redacted, diagnostics.exactCommandValues);
  redacted = redacted.trim();
  return redacted ? `${summary}\n${redacted}` : summary;
}

function createScriptDiagnosticsSnapshot(
  command: string,
  serializedPayload: string,
  shell?: string | undefined,
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
  const commandValues = new Set<string>();
  const exactCommandValues = new Set<string>();
  let diagnosticsSafe = shell === undefined;
  for (const configuredCommand of configuredCommands) {
    if (commandContainsSensitiveValue(configuredCommand)) {
      diagnosticsSafe = false;
    }
    const values = snapshotCommandValues(configuredCommand);
    if (!values) {
      diagnosticsSafe = false;
      continue;
    }
    for (const value of values.substringValues) {
      commandValues.add(value);
    }
    for (const value of values.exactValues) {
      exactCommandValues.add(value);
    }
  }
  return {
    commandValues: [...commandValues].sort((left, right) => right.length - left.length),
    configuredCommands: [...configuredCommands].sort((left, right) => right.length - left.length),
    diagnosticsSafe,
    exactCommandValues: [...exactCommandValues].sort((left, right) => right.length - left.length),
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
  const diagnostics = createScriptDiagnosticsSnapshot(
    params.command,
    serializedPayload,
    params.shell,
  );
  return new Promise((resolve, reject) => {
    const childStartedAtMs = Date.now();
    let childObservedAtMs = childStartedAtMs;
    let child: SpawnedScriptChild;
    try {
      child = spawn(params.command, {
        cwd: params.cwd ? path.resolve(params.cwd) : process.cwd(),
        env: process.env,
        shell: params.shell ?? true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      childObservedAtMs = Date.now();
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
        await terminateChild(child, childStartedAtMs, childObservedAtMs);
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
        await terminateChild(child, childStartedAtMs, childObservedAtMs);
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
        await terminateChild(child, childStartedAtMs, childObservedAtMs);
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
    const diagnostics = createScriptDiagnosticsSnapshot(
      params.command,
      serializedPayload,
      params.shell,
    );
    const childStartedAtMs = Date.now();
    let childObservedAtMs = childStartedAtMs;
    let child: SpawnedScriptChild;
    try {
      child = spawn(params.command, {
        cwd: params.cwd ? path.resolve(params.cwd) : process.cwd(),
        env: process.env,
        shell: params.shell ?? true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      childObservedAtMs = Date.now();
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
    let termination: Promise<void> | undefined;
    const stopChild = () => {
      termination ??= terminateChild(child, childStartedAtMs, childObservedAtMs);
      return termination;
    };
    const requestStopChild = () => {
      void stopChild();
    };
    params.cancelSignal.addEventListener("abort", requestStopChild, { once: true });
    params.context.signal?.addEventListener("abort", requestStopChild, { once: true });
    if (params.cancelSignal.aborted || params.context.signal?.aborted) {
      requestStopChild();
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
        requestStopChild();
      }
    });
    child.once("error", (error) => {
      childError = error;
    });
    let childCloseObserved = false;
    const childClosed = new Promise<ScriptChildExit>((resolve) => {
      child.once("close", (code, signal) => {
        childCloseObserved = true;
        resolve({ code, signal });
      });
    });
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

      const exit = await waitForChildClose(childClosed);
      if (!exit) {
        await stopChild();
        throw new CrablineError("Script watch command did not close after its output ended.", {
          kind: "connectivity",
        });
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
      params.cancelSignal.removeEventListener("abort", requestStopChild);
      params.context.signal?.removeEventListener("abort", requestStopChild);
      child.stdin.destroy();
      if (!childCloseObserved) {
        await stopChild();
      }
      await waitForChildClose(childClosed);
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
