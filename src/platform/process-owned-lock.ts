import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveWindowsPowerShellPath } from "./windows-acl.js";

type LockOwner = {
  pid: number;
  processIdentity: string | null;
  processStartedAtMs: number;
  token: string;
  version: 1;
};

type OwnerStatus = "active" | "dead" | "unknown";

const OWNER_FILE = "crabline-owner.json";
const MAX_OWNER_BYTES = 4096;
const MAX_PROCESS_ID = 2_147_483_647;
const IDENTITY_CACHE_MS = 1000;
const OWNERLESS_LOCK_RECOVERY_MS = 10 * 60 * 1000;
const CURRENT_PROCESS_STARTED_AT_MS = Math.trunc(performance.timeOrigin);

function isValidProcessId(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PROCESS_ID;
}

function isProcessAlive(pid: number): boolean {
  if (!isValidProcessId(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isDeadLinuxProcessState(value: string): boolean {
  const commandEnd = value.lastIndexOf(") ");
  if (commandEnd < 0) {
    return false;
  }
  const state = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)[0];
  return state === "Z" || state === "X" || state === "x";
}

function isDefunctProcess(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      return isDeadLinuxProcessState(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 1000,
    });
    return result.status === 0 && /^Z/u.test(result.stdout.trim());
  }
  return false;
}

function processIdentityFromLinuxStat(value: string, bootId: string): string | null {
  const normalizedBootId = bootId.trim();
  if (!/^[0-9a-f-]{16,64}$/iu.test(normalizedBootId)) {
    return null;
  }
  const commandEnd = value.lastIndexOf(") ");
  if (commandEnd < 0) {
    return null;
  }
  const startTicks = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)[19];
  return startTicks && /^\d+$/u.test(startTicks) ? `linux:${normalizedBootId}:${startTicks}` : null;
}

function processIdentityFromDarwin(processDetails: string, bootTime: string): string | null {
  const bootMatch = /\bsec = (\d+), usec = (\d+)\b/u.exec(bootTime);
  const launchMatch =
    /^Launch Time:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3,6}) ([+-])(\d{2})(\d{2})$/mu.exec(
      processDetails,
    );
  if (!bootMatch) {
    return null;
  }
  if (launchMatch) {
    const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] =
      launchMatch as RegExpExecArray &
        [string, string, string, string, string, string, string, string, string, string, string];
    const offsetMs =
      (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000 * (sign === "+" ? 1 : -1);
    const fractionMicros = Number(fraction.padEnd(6, "0"));
    const utcMilliseconds =
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Math.floor(fractionMicros / 1000),
      ) - offsetMs;
    if (Number.isSafeInteger(utcMilliseconds) && utcMilliseconds > 0) {
      const startedAtMicros = BigInt(utcMilliseconds) * 1000n + BigInt(fractionMicros % 1000);
      return `darwin:${bootMatch[1]}.${bootMatch[2]}:${startedAtMicros}`;
    }
  }
  const normalizedDetails = processDetails.trim().replace(/\s+/gu, " ");
  if (normalizedDetails.length === 0 || normalizedDetails.length > 64) {
    return null;
  }
  return `darwin:${bootMatch[1]}.${bootMatch[2]}:${normalizedDetails}`;
}

function readProcessIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return processIdentityFromLinuxStat(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
      );
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const options = {
      encoding: "utf8" as const,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 512 * 1024,
      timeout: 1000,
    };
    const bootTime = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], options);
    const processDetails = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], options);
    return bootTime.status === 0 && processDetails.status === 0
      ? processIdentityFromDarwin(processDetails.stdout, bootTime.stdout)
      : null;
  }
  if (process.platform !== "win32") {
    return null;
  }
  let powershellPath: string;
  try {
    powershellPath = resolveWindowsPowerShellPath(process.env.SystemRoot);
  } catch {
    return null;
  }
  const result = spawnSync(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`,
    ],
    { encoding: "utf8", timeout: 1000, windowsHide: true },
  );
  const ticks = result.status === 0 ? result.stdout.trim() : "";
  return /^\d+$/u.test(ticks) ? `windows:${ticks}` : null;
}

let cachedCurrentProcessIdentity: string | null | undefined;

function parseOwner(lockDirectory: fs.PathLike): LockOwner | undefined {
  try {
    const raw = readFileSync(path.join(String(lockDirectory), OWNER_FILE));
    if (raw.byteLength === 0 || raw.byteLength > MAX_OWNER_BYTES) {
      return undefined;
    }
    const value = JSON.parse(raw.toString("utf8")) as Partial<LockOwner>;
    if (
      value.version !== 1 ||
      !isValidProcessId(value.pid ?? 0) ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      value.token.length > 128 ||
      !Number.isSafeInteger(value.processStartedAtMs) ||
      (value.processIdentity !== null &&
        (typeof value.processIdentity !== "string" ||
          value.processIdentity.length === 0 ||
          value.processIdentity.length > 256))
    ) {
      return undefined;
    }
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function syntheticFreshStat(stats: fs.Stats): fs.Stats {
  const fresh = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats) as fs.Stats;
  Object.defineProperty(fresh, "mtime", {
    configurable: true,
    enumerable: true,
    value: new Date(),
  });
  return fresh;
}

function isRecoverableOwnerlessLock(stats: Pick<fs.Stats, "mtimeMs">): boolean {
  return Date.now() - stats.mtimeMs >= OWNERLESS_LOCK_RECOVERY_MS;
}

export function createProcessOwnedLockFileSystem(): typeof fs {
  const token = randomUUID();
  if (cachedCurrentProcessIdentity === undefined) {
    cachedCurrentProcessIdentity = readProcessIdentity(process.pid);
  }
  const currentIdentity = cachedCurrentProcessIdentity;
  let cachedForeignIdentity:
    | {
        checkedAt: number;
        identity: string | null;
        pid: number;
      }
    | undefined;
  const owner: LockOwner = {
    pid: process.pid,
    processIdentity: currentIdentity,
    processStartedAtMs: CURRENT_PROCESS_STARTED_AT_MS,
    token,
    version: 1,
  };

  const ownerStatus = (candidate: LockOwner | undefined): OwnerStatus => {
    if (!candidate) {
      return "unknown";
    }
    if (!isProcessAlive(candidate.pid)) {
      return "dead";
    }
    if (isDefunctProcess(candidate.pid)) {
      return "dead";
    }
    if (candidate.pid === process.pid) {
      return candidate.processStartedAtMs === CURRENT_PROCESS_STARTED_AT_MS ? "active" : "dead";
    }
    if (candidate.processIdentity === null) {
      return "unknown";
    }
    const now = Date.now();
    if (
      !cachedForeignIdentity ||
      cachedForeignIdentity.pid !== candidate.pid ||
      now - cachedForeignIdentity.checkedAt >= IDENTITY_CACHE_MS
    ) {
      cachedForeignIdentity = {
        checkedAt: now,
        identity: readProcessIdentity(candidate.pid),
        pid: candidate.pid,
      };
    }
    return cachedForeignIdentity.identity === null
      ? "unknown"
      : cachedForeignIdentity.identity === candidate.processIdentity
        ? "active"
        : "dead";
  };

  const lockFs = Object.create(fs) as typeof fs;
  lockFs.mkdir = ((
    directoryPath: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => {
    fs.mkdir(directoryPath, (error) => {
      if (error) {
        callback(error);
        return;
      }
      try {
        fs.writeFileSync(
          path.join(String(directoryPath), OWNER_FILE),
          `${JSON.stringify(owner)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        callback(null);
      } catch (ownerError) {
        try {
          fs.rmSync(directoryPath, { force: true, recursive: true });
        } catch {
          // Preserve the owner publication failure.
        }
        callback(ownerError as NodeJS.ErrnoException);
      }
    });
  }) as typeof fs.mkdir;
  lockFs.stat = ((
    filePath: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null, stats?: fs.Stats) => void,
  ) => {
    fs.stat(filePath, (error, stats) => {
      if (error) {
        callback(error);
        return;
      }
      const candidate = parseOwner(filePath);
      callback(
        null,
        candidate?.token === token ||
          ownerStatus(candidate) === "dead" ||
          (candidate === undefined && isRecoverableOwnerlessLock(stats))
          ? stats
          : syntheticFreshStat(stats),
      );
    });
  }) as typeof fs.stat;
  lockFs.rmdir = ((
    directoryPath: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => {
    const candidate = parseOwner(directoryPath);
    let recoverableOwnerless = false;
    if (candidate === undefined) {
      try {
        recoverableOwnerless = isRecoverableOwnerlessLock(fs.statSync(directoryPath));
      } catch (error) {
        callback(error as NodeJS.ErrnoException);
        return;
      }
    }
    if (candidate?.token !== token && ownerStatus(candidate) !== "dead" && !recoverableOwnerless) {
      callback(
        Object.assign(new Error("Recorder lock owner is still active or cannot be verified."), {
          code: "ELOCKED",
        }),
      );
      return;
    }
    fs.rm(path.join(String(directoryPath), OWNER_FILE), { force: true }, (ownerError) => {
      if (ownerError) {
        callback(ownerError);
        return;
      }
      fs.rmdir(directoryPath, callback);
    });
  }) as typeof fs.rmdir;
  lockFs.rmdirSync = ((directoryPath: fs.PathLike) => {
    const candidate = parseOwner(directoryPath);
    if (candidate?.token !== token) {
      throw Object.assign(new Error("Recorder lock is not owned by this process."), {
        code: "ELOCKED",
      });
    }
    fs.rmSync(path.join(String(directoryPath), OWNER_FILE), { force: true });
    fs.rmdirSync(directoryPath);
  }) as typeof fs.rmdirSync;
  return lockFs;
}
