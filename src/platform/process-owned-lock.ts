import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveWindowsPowerShellPath } from "./windows-acl.js";

type LockOwner = {
  executionIdentity: string | null;
  machineIdentity: string | null;
  pid: number;
  processIdentity: string | null;
  processNamespace: string | null;
  processStartedAtMs: number;
  token: string;
  version: 1 | 2 | 3 | 4;
};

type OwnerStatus = "active" | "dead" | "foreign" | "superseded" | "unknown";

type ParsedLockOwner = {
  lockDirectory: string;
  owner: LockOwner;
  publishedAtMs: number;
};

type RecoveryClaim = {
  activeIdentity: DirectoryIdentity;
  activePath: string;
  ownerGenerationKey: string;
  supersededPaths: SupersededRecoveryClaim[];
};

type DirectoryIdentity = {
  dev: bigint;
  ino: bigint;
};

type SupersededRecoveryClaim = {
  identity: DirectoryIdentity & { mtimeMs: bigint };
  ownerFingerprint: string;
  path: string;
};

type AbandonedDirectoryIdentity = DirectoryIdentity & {
  ownerGenerationKey: string;
};

const retainedCoordinationClaims = new Map<string, RecoveryClaim>();
const abandonedOwnerKeys = new Set<string>();
const abandonedDirectoryIdentities = new Map<string, AbandonedDirectoryIdentity>();

const OWNER_FILE = "crabline-owner.json";
const ABANDONED_OWNER_PREFIX = ".crabline-abandoned-";
const ABANDONED_OWNER_NAME_PATTERN = /^\.crabline-abandoned-[0-9a-f]{64}$/u;
const MAX_OWNER_BYTES = 4096;
const MAX_PROCESS_ID = 2_147_483_647;
const IDENTITY_CACHE_MS = 1000;
const CURRENT_IDENTITY_ATTEMPTS = 3;
const COORDINATION_RELEASE_RETRY_MS = 10;
const COORDINATION_RELEASE_WAIT_MS = 5000;
const LEGACY_PROCESS_START_TOLERANCE_MS = 2000;
const OWNERLESS_LOCK_RECOVERY_MS = 10 * 60 * 1000;
const CURRENT_PROCESS_STARTED_AT_MS = Math.trunc(performance.timeOrigin);
const CURRENT_EXECUTION_IDENTITY = randomUUID();
const DARWIN_PRECISE_IDENTITY_PATTERN = /^darwin:\d+\.\d+:us:\d+$/u;
const DARWIN_COARSE_IDENTITY_PATTERN = /^darwin:\d+\.\d+:s:(\d+)$/u;
const LINUX_PID_NAMESPACE_PATTERN = /^pid:\[\d+\]$/u;
const DARWIN_MONTHS = new Map([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11],
]);

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
      return `darwin:${bootMatch[1]}.${bootMatch[2]}:us:${startedAtMicros}`;
    }
  }
  const normalizedDetails = processDetails.trim().replace(/\s+/gu, " ");
  if (normalizedDetails.length === 0 || normalizedDetails.length > 64) {
    return null;
  }
  return `darwin:${bootMatch[1]}.${bootMatch[2]}:${normalizedDetails}`;
}

function coarseProcessIdentityFromDarwin(processDetails: string, bootTime: string): string | null {
  const bootMatch = /\bsec = (\d+), usec = (\d+)\b/u.exec(bootTime);
  const startMatch =
    /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/u.exec(
      processDetails,
    );
  const month = DARWIN_MONTHS.get(startMatch?.[1] ?? "");
  if (!bootMatch || !startMatch || month === undefined) {
    return null;
  }
  const startedAtMs = Date.UTC(
    Number(startMatch[6]),
    month,
    Number(startMatch[2]),
    Number(startMatch[3]),
    Number(startMatch[4]),
    Number(startMatch[5]),
  );
  return Number.isSafeInteger(startedAtMs) && startedAtMs > 0
    ? `darwin:${bootMatch[1]}.${bootMatch[2]}:s:${Math.trunc(startedAtMs / 1000)}`
    : null;
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
    const preciseDetails = spawnSync("/usr/bin/vmmap", ["-summary", String(pid)], {
      ...options,
      timeout: 3000,
    });
    const sampleDetails =
      preciseDetails.status === 0
        ? undefined
        : spawnSync("/usr/bin/sample", [String(pid), "1", "1"], {
            ...options,
            timeout: 3000,
          });
    const nativeDetails =
      preciseDetails.status === 0
        ? preciseDetails
        : sampleDetails?.status === 0
          ? sampleDetails
          : undefined;
    const identity =
      bootTime.status === 0 && nativeDetails
        ? processIdentityFromDarwin(nativeDetails.stdout, bootTime.stdout)
        : null;
    if (identity !== null && DARWIN_PRECISE_IDENTITY_PATTERN.test(identity)) {
      return identity;
    }
    const coarseDetails = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], options);
    return bootTime.status === 0 && coarseDetails.status === 0
      ? coarseProcessIdentityFromDarwin(coarseDetails.stdout, bootTime.stdout)
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

function readProcessNamespace(pid: number): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const namespace = fs.readlinkSync(`/proc/${pid}/ns/pid`);
    return LINUX_PID_NAMESPACE_PATTERN.test(namespace) ? namespace : null;
  } catch {
    return null;
  }
}

function readMachineIdentity(): string | null {
  if (process.platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return /^[0-9a-f-]{16,64}$/iu.test(bootId) ? `linux:${bootId}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 1000,
    });
    const platformUuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(result.stdout)?.[1];
    return result.status === 0 && platformUuid ? `darwin:${platformUuid.toLowerCase()}` : null;
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
      "(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid",
    ],
    { encoding: "utf8", timeout: 1000, windowsHide: true },
  );
  const machineGuid = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f-]{16,64}$/iu.test(machineGuid) ? `windows:${machineGuid.toLowerCase()}` : null;
}

let cachedLinuxClockTicks: number | undefined;

function processStartedAtMsFromIdentity(identity: string | null): number | null {
  const darwinStart = /^darwin:\d+\.\d+:us:(\d+)$/u.exec(identity ?? "")?.[1];
  if (darwinStart) {
    return Number(BigInt(darwinStart) / 1000n);
  }
  const coarseDarwinStart = DARWIN_COARSE_IDENTITY_PATTERN.exec(identity ?? "")?.[1];
  if (coarseDarwinStart) {
    return Number(coarseDarwinStart) * 1000;
  }
  const windowsStart = /^windows:(\d+)$/u.exec(identity ?? "")?.[1];
  if (windowsStart) {
    const unixEpochTicks = 621_355_968_000_000_000n;
    const ticks = BigInt(windowsStart);
    return ticks >= unixEpochTicks ? Number((ticks - unixEpochTicks) / 10_000n) : null;
  }
  return null;
}

function readLegacyProcessStartedAtMs(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = processStat.lastIndexOf(") ");
      const startTicks =
        commandEnd < 0
          ? undefined
          : processStat
              .slice(commandEnd + 2)
              .trim()
              .split(/\s+/u)[19];
      const bootTime = /^btime\s+(\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"))?.[1];
      if (!startTicks || !/^\d+$/u.test(startTicks) || !bootTime) {
        return null;
      }
      if (cachedLinuxClockTicks === undefined) {
        const result = spawnSync("/usr/bin/getconf", ["CLK_TCK"], {
          encoding: "utf8",
          timeout: 1000,
        });
        const ticks = result.status === 0 ? Number(result.stdout.trim()) : Number.NaN;
        if (!Number.isSafeInteger(ticks) || ticks <= 0) {
          return null;
        }
        cachedLinuxClockTicks = ticks;
      }
      return Number(bootTime) * 1000 + (Number(startTicks) * 1000) / cachedLinuxClockTicks;
    } catch {
      return null;
    }
  }
  return processStartedAtMsFromIdentity(readProcessIdentity(pid));
}

function legacyProcessStartMatches(expected: number, observed: number): boolean {
  return Math.abs(expected - observed) <= LEGACY_PROCESS_START_TOLERANCE_MS;
}

function isCoarseDarwinIdentity(identity: string): boolean {
  return DARWIN_COARSE_IDENTITY_PATTERN.test(identity);
}

function isExactProcessIdentity(identity: string): boolean {
  return (
    /^linux:[0-9a-f-]{16,64}:\d+$/iu.test(identity) ||
    DARWIN_PRECISE_IDENTITY_PATTERN.test(identity) ||
    /^windows:\d+$/u.test(identity)
  );
}

function directoryIdentity(stats: Pick<fs.BigIntStats, "dev" | "ino">): DirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function directoryIdentityMatches(
  expected: DirectoryIdentity | undefined,
  actual: Pick<fs.BigIntStats, "dev" | "ino">,
): boolean {
  return expected !== undefined && expected.dev === actual.dev && expected.ino === actual.ino;
}

function lockCleanupError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "ELOCKED" });
}

function isLockArtifactName(name: string): boolean {
  return name === OWNER_FILE || ABANDONED_OWNER_NAME_PATTERN.test(name);
}

function verifiedLockDirectoryStats(
  directoryPath: fs.PathLike,
  expectedIdentity: DirectoryIdentity,
  expectedMtimeMs?: bigint,
): fs.BigIntStats | undefined {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !directoryIdentityMatches(expectedIdentity, stats) ||
    (expectedMtimeMs !== undefined && stats.mtimeMs !== expectedMtimeMs)
  ) {
    throw lockCleanupError("Recorder lock cleanup target changed.");
  }
  return stats;
}

function removeVerifiedLockDirectorySync(
  directoryPath: fs.PathLike,
  expectedIdentity: DirectoryIdentity,
  expectedMtimeMs?: bigint,
): void {
  if (!verifiedLockDirectoryStats(directoryPath, expectedIdentity, expectedMtimeMs)) {
    return;
  }
  const entries = fs.readdirSync(directoryPath);
  if (!verifiedLockDirectoryStats(directoryPath, expectedIdentity)) {
    return;
  }
  const artifacts: string[] = [];
  for (const entry of entries) {
    if (!isLockArtifactName(entry)) {
      throw lockCleanupError("Recorder lock cleanup found an unexpected artifact.");
    }
    if (!verifiedLockDirectoryStats(directoryPath, expectedIdentity)) {
      return;
    }
    const artifactPath = path.join(String(directoryPath), entry);
    const artifact = fs.lstatSync(artifactPath, { bigint: true });
    if (!artifact.isFile() || artifact.isSymbolicLink()) {
      throw lockCleanupError("Recorder lock cleanup found an unsafe artifact.");
    }
    artifacts.push(artifactPath);
  }
  artifacts.sort(
    (left, right) =>
      Number(path.basename(left) === OWNER_FILE) - Number(path.basename(right) === OWNER_FILE),
  );
  for (const artifactPath of artifacts) {
    if (!verifiedLockDirectoryStats(directoryPath, expectedIdentity)) {
      return;
    }
    const artifact = fs.lstatSync(artifactPath, { bigint: true });
    if (!artifact.isFile() || artifact.isSymbolicLink()) {
      throw lockCleanupError("Recorder lock cleanup artifact changed.");
    }
    fs.unlinkSync(artifactPath);
  }
  if (!verifiedLockDirectoryStats(directoryPath, expectedIdentity)) {
    return;
  }
  try {
    fs.rmdirSync(directoryPath);
  } catch (error) {
    try {
      if (verifiedLockDirectoryStats(directoryPath, expectedIdentity)) {
        fs.utimesSync(directoryPath, new Date(0), new Date(0));
      }
    } catch {
      // Do not mutate a replacement directory after cleanup loses its identity fence.
    }
    throw error;
  }
}

function canonicalLockDirectoryPath(directoryPath: fs.PathLike): string {
  const resolved = path.resolve(String(directoryPath));
  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync.native(path.dirname(resolved));
  } catch {
    canonicalParent = path.dirname(resolved);
  }
  const canonical = path.join(canonicalParent, path.basename(resolved));
  return process.platform === "win32" ? path.win32.normalize(canonical).toLowerCase() : canonical;
}

function abandonedOwnerKey(directoryPath: fs.PathLike, ownerToken: string): string {
  return `${canonicalLockDirectoryPath(directoryPath)}\0${ownerToken}`;
}

function recoveryClaimPath(directoryPath: fs.PathLike, fingerprint = "coordination"): string {
  const canonicalDirectory = canonicalLockDirectoryPath(directoryPath);
  const digest = createHash("sha256")
    .update(canonicalDirectory)
    .update("\0")
    .update(fingerprint)
    .digest("hex");
  return path.join(path.dirname(canonicalDirectory), `.crabline-reclaim-${digest}`);
}

function lockOwnerMatches(
  left: ParsedLockOwner | null | undefined,
  right: ParsedLockOwner | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.owner.token === right.owner.token;
}

let cachedCurrentProcessIdentity: string | undefined;
let cachedCurrentMachineIdentity: string | undefined;

function readProcessIdentityWithRetry(
  pid: number,
  reader: (candidatePid: number) => string | null,
): string | null {
  for (let attempt = 0; attempt < CURRENT_IDENTITY_ATTEMPTS; attempt++) {
    const identity = reader(pid);
    if (identity !== null) {
      return identity;
    }
  }
  return null;
}

function readProcessNamespaceWithRetry(pid: number): string | null {
  for (let attempt = 0; attempt < CURRENT_IDENTITY_ATTEMPTS; attempt++) {
    const namespace = readProcessNamespace(pid);
    if (namespace !== null) {
      return namespace;
    }
  }
  return null;
}

function parseOpenedOwner(ownerHandle: number): Omit<ParsedLockOwner, "lockDirectory"> | undefined {
  const stats = fs.fstatSync(ownerHandle);
  if (!stats.isFile() || stats.size === 0 || stats.size > MAX_OWNER_BYTES) {
    return undefined;
  }
  const raw = Buffer.alloc(stats.size);
  let offset = 0;
  while (offset < raw.byteLength) {
    const bytesRead = fs.readSync(ownerHandle, raw, offset, raw.byteLength - offset, offset);
    if (bytesRead === 0) {
      return undefined;
    }
    offset += bytesRead;
  }
  const value = JSON.parse(raw.toString("utf8")) as Partial<LockOwner>;
  if (
    (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) ||
    !isValidProcessId(value.pid ?? 0) ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    value.token.length > 128 ||
    !Number.isSafeInteger(value.processStartedAtMs) ||
    (value.executionIdentity !== undefined &&
      value.executionIdentity !== null &&
      (typeof value.executionIdentity !== "string" ||
        value.executionIdentity.length === 0 ||
        value.executionIdentity.length > 128)) ||
    (value.machineIdentity !== undefined &&
      value.machineIdentity !== null &&
      (typeof value.machineIdentity !== "string" ||
        value.machineIdentity.length === 0 ||
        value.machineIdentity.length > 256)) ||
    (value.processNamespace !== undefined &&
      value.processNamespace !== null &&
      (typeof value.processNamespace !== "string" ||
        !LINUX_PID_NAMESPACE_PATTERN.test(value.processNamespace))) ||
    (value.processIdentity !== null &&
      (typeof value.processIdentity !== "string" ||
        value.processIdentity.length === 0 ||
        value.processIdentity.length > 256))
  ) {
    return undefined;
  }
  if (
    (value.version === 2 || value.version === 3 || value.version === 4) &&
    (value.processIdentity === null ||
      !isExactProcessIdentity(value.processIdentity) ||
      (/^linux:/u.test(value.processIdentity) &&
        (value.processNamespace === null ||
          value.processNamespace === undefined ||
          !LINUX_PID_NAMESPACE_PATTERN.test(value.processNamespace))))
  ) {
    return undefined;
  }
  if (
    (value.version === 3 || value.version === 4) &&
    (value.machineIdentity === null ||
      value.machineIdentity === undefined ||
      !/^(darwin|linux|windows):.+$/u.test(value.machineIdentity))
  ) {
    return undefined;
  }
  if (
    value.version === 4 &&
    (value.executionIdentity === null ||
      value.executionIdentity === undefined ||
      !/^[0-9a-f-]{36}$/iu.test(value.executionIdentity))
  ) {
    return undefined;
  }
  return {
    owner: {
      ...(value as LockOwner),
      executionIdentity: value.executionIdentity ?? null,
      machineIdentity: value.machineIdentity ?? null,
      processNamespace: value.processNamespace ?? null,
    },
    publishedAtMs: stats.mtimeMs,
  };
}

function parseOwner(lockDirectory: fs.PathLike): ParsedLockOwner | null | undefined {
  let ownerHandle: number;
  try {
    ownerHandle = fs.openSync(
      path.join(String(lockDirectory), OWNER_FILE),
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  let parsed: Omit<ParsedLockOwner, "lockDirectory"> | undefined;
  try {
    parsed = parseOpenedOwner(ownerHandle);
  } catch {
    parsed = undefined;
  }
  try {
    fs.closeSync(ownerHandle);
  } catch {
    return null;
  }
  return parsed === undefined
    ? null
    : {
        ...parsed,
        lockDirectory: String(lockDirectory),
      };
}

function abandonedOwnerMarkerPath(lockDirectory: fs.PathLike, ownerToken: string): string {
  const digest = createHash("sha256").update(ownerToken).digest("hex");
  return path.join(String(lockDirectory), `${ABANDONED_OWNER_PREFIX}${digest}`);
}

function hasAbandonedOwnerMarker(candidate: ParsedLockOwner): boolean {
  const markerPath = abandonedOwnerMarkerPath(candidate.lockDirectory, candidate.owner.token);
  let markerHandle: number;
  try {
    markerHandle = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  let matches = false;
  try {
    const stats = fs.fstatSync(markerHandle);
    if (stats.isFile() && stats.size > 0 && stats.size <= 256) {
      const raw = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < raw.byteLength) {
        const bytesRead = fs.readSync(markerHandle, raw, offset, raw.byteLength - offset, offset);
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      matches = offset === raw.byteLength && raw.toString("utf8").trim() === candidate.owner.token;
    }
  } catch {
    matches = false;
  }
  try {
    fs.closeSync(markerHandle);
  } catch {
    return false;
  }
  return matches;
}

function publishAbandonedOwnerMarker(lockDirectory: fs.PathLike, ownerToken: string): boolean {
  const candidate = parseOwner(lockDirectory);
  if (!candidate || candidate.owner.token !== ownerToken) {
    return false;
  }
  const markerPath = abandonedOwnerMarkerPath(lockDirectory, ownerToken);
  let markerHandle: number | undefined;
  let markerIdentity: fs.BigIntStats | undefined;
  try {
    markerHandle = fs.openSync(
      markerPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    markerIdentity = fs.fstatSync(markerHandle, { bigint: true });
    const contents = Buffer.from(`${ownerToken}\n`);
    let offset = 0;
    while (offset < contents.byteLength) {
      const written = fs.writeSync(
        markerHandle,
        contents,
        offset,
        contents.byteLength - offset,
        offset,
      );
      if (written === 0) {
        throw new Error("Recorder lock abandonment publication made no progress.");
      }
      offset += written;
    }
    fs.fsyncSync(markerHandle);
    fs.closeSync(markerHandle);
    markerHandle = undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return hasAbandonedOwnerMarker(candidate);
    }
    if (markerIdentity !== undefined) {
      try {
        const current = fs.lstatSync(markerPath, { bigint: true });
        if (markerIdentity.dev === current.dev && markerIdentity.ino === current.ino) {
          fs.unlinkSync(markerPath);
        }
      } catch {
        // Preserve a replacement marker that cannot be proven to be ours.
      }
    }
    return false;
  } finally {
    if (markerHandle !== undefined) {
      try {
        fs.closeSync(markerHandle);
      } catch {
        // The failed abandonment publication remains non-authoritative.
      }
    }
  }
  const refreshed = parseOwner(lockDirectory);
  if (!refreshed || refreshed.owner.token !== ownerToken || !hasAbandonedOwnerMarker(refreshed)) {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // A changed marker is ignored unless it matches the current owner token.
    }
    return false;
  }
  return true;
}

function hasRecoverableMalformedOwner(lockDirectory: fs.PathLike): boolean {
  let ownerHandle: number;
  try {
    ownerHandle = fs.openSync(
      path.join(String(lockDirectory), OWNER_FILE),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return false;
  }
  let recoverable = false;
  try {
    const stats = fs.fstatSync(ownerHandle);
    if (!stats.isFile() || stats.size > MAX_OWNER_BYTES) {
      recoverable = false;
    } else if (stats.size === 0) {
      recoverable = true;
    } else {
      const raw = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < raw.byteLength) {
        const bytesRead = fs.readSync(ownerHandle, raw, offset, raw.byteLength - offset, offset);
        if (bytesRead === 0) {
          recoverable = true;
          break;
        }
        offset += bytesRead;
      }
      if (offset === raw.byteLength) {
        JSON.parse(raw.toString("utf8"));
      }
    }
  } catch (error) {
    recoverable = error instanceof SyntaxError;
  }
  try {
    fs.closeSync(ownerHandle);
  } catch {
    return false;
  }
  return recoverable;
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

function syntheticStaleStat(stats: fs.Stats): fs.Stats {
  const stale = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats) as fs.Stats;
  Object.defineProperty(stale, "mtime", {
    configurable: true,
    enumerable: true,
    value: new Date(0),
  });
  return stale;
}

function statMtimeMs(stats: { mtimeMs: bigint | number }): number {
  return typeof stats.mtimeMs === "bigint" ? Number(stats.mtimeMs) : stats.mtimeMs;
}

function isRecoverableOwnerlessClaim(stats: { mtimeMs: bigint | number }): boolean {
  return Date.now() - statMtimeMs(stats) >= OWNERLESS_LOCK_RECOVERY_MS;
}

function isRecoverableUnverifiableOwner(candidate: ParsedLockOwner, status: OwnerStatus): boolean {
  return (
    status === "superseded" &&
    candidate.owner.version === 1 &&
    (candidate.owner.processIdentity === null ||
      isCoarseDarwinIdentity(candidate.owner.processIdentity)) &&
    Date.now() - candidate.publishedAtMs >= OWNERLESS_LOCK_RECOVERY_MS
  );
}

function isRecoverableForeignOwner(
  candidate: ParsedLockOwner,
  status: OwnerStatus,
  stats: { mtimeMs: bigint | number },
): boolean {
  return (
    status === "foreign" &&
    candidate.owner.version >= 2 &&
    Date.now() - statMtimeMs(stats) >= OWNERLESS_LOCK_RECOVERY_MS
  );
}

function isRecoverableUnknownOwner(
  candidate: ParsedLockOwner,
  status: OwnerStatus,
  stats: { mtimeMs: bigint | number },
): boolean {
  return (
    status === "unknown" &&
    candidate.owner.version >= 2 &&
    candidate.owner.processIdentity !== null &&
    isExactProcessIdentity(candidate.owner.processIdentity) &&
    Date.now() - candidate.publishedAtMs >= OWNERLESS_LOCK_RECOVERY_MS &&
    Date.now() - statMtimeMs(stats) >= OWNERLESS_LOCK_RECOVERY_MS
  );
}

export function createProcessOwnedLockFileSystem(
  options: {
    machineIdentityReader?: () => string | null;
    processIdentityReader?: (pid: number) => string | null;
  } = {},
): typeof fs {
  if (
    process.platform !== "linux" &&
    process.platform !== "darwin" &&
    process.platform !== "win32"
  ) {
    return fs;
  }
  const token = randomUUID();
  const identityReader = options.processIdentityReader ?? readProcessIdentity;
  let currentProcessIdentity: string | null;
  if (options.processIdentityReader) {
    currentProcessIdentity = readProcessIdentityWithRetry(process.pid, identityReader);
  } else {
    if (cachedCurrentProcessIdentity === undefined) {
      const currentIdentity = readProcessIdentityWithRetry(process.pid, identityReader);
      if (currentIdentity !== null) {
        cachedCurrentProcessIdentity = currentIdentity;
      }
    }
    currentProcessIdentity = cachedCurrentProcessIdentity ?? null;
  }
  if (
    currentProcessIdentity === null ||
    (!isExactProcessIdentity(currentProcessIdentity) &&
      !(process.platform === "darwin" && isCoarseDarwinIdentity(currentProcessIdentity)))
  ) {
    throw new Error("Recorder lock process identity is unavailable.");
  }
  let currentMachineIdentity: string | null;
  if (options.machineIdentityReader) {
    currentMachineIdentity = options.machineIdentityReader();
  } else {
    if (cachedCurrentMachineIdentity === undefined) {
      const machineIdentity = readMachineIdentity();
      if (machineIdentity !== null) {
        cachedCurrentMachineIdentity = machineIdentity;
      }
    }
    currentMachineIdentity = cachedCurrentMachineIdentity ?? null;
  }
  if (currentMachineIdentity === null) {
    throw new Error("Recorder lock machine identity is unavailable.");
  }
  const currentProcessNamespace = readProcessNamespaceWithRetry(process.pid);
  if (process.platform === "linux" && currentProcessNamespace === null) {
    throw new Error("Recorder lock process namespace is unavailable.");
  }
  const ownedDirectories = new Map<string, DirectoryIdentity>();
  const interruptedPublicationIdentities = new Map<string, DirectoryIdentity>();
  let cachedForeignIdentity:
    | {
        checkedAt: number;
        ownerGenerationKey: string;
        identity: string | null;
        pid: number;
        startedAtMs: number | null;
      }
    | undefined;
  const owner: LockOwner = {
    executionIdentity: CURRENT_EXECUTION_IDENTITY,
    machineIdentity: currentMachineIdentity,
    pid: process.pid,
    processIdentity: currentProcessIdentity,
    processNamespace: currentProcessNamespace,
    processStartedAtMs: CURRENT_PROCESS_STARTED_AT_MS,
    token,
    version: isExactProcessIdentity(currentProcessIdentity) ? 4 : 1,
  };

  const publishOwner = (directory: string): void => {
    const ownerPath = path.join(directory, OWNER_FILE);
    let ownerHandle: number | undefined;
    let openedIdentity: fs.BigIntStats | undefined;
    try {
      ownerHandle = fs.openSync(
        ownerPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      openedIdentity = fs.fstatSync(ownerHandle, { bigint: true });
      const contents = Buffer.from(`${JSON.stringify(owner)}\n`);
      let offset = 0;
      while (offset < contents.byteLength) {
        const written = fs.writeSync(
          ownerHandle,
          contents,
          offset,
          contents.byteLength - offset,
          offset,
        );
        if (written === 0) {
          throw new Error("Recorder lock owner publication made no progress.");
        }
        offset += written;
      }
      fs.closeSync(ownerHandle);
      ownerHandle = undefined;
    } catch (error) {
      if (openedIdentity !== undefined) {
        try {
          const current = fs.lstatSync(ownerPath, { bigint: true });
          if (openedIdentity.dev === current.dev && openedIdentity.ino === current.ino) {
            fs.unlinkSync(ownerPath);
          }
        } catch {
          // Preserve a replacement path that cannot be proven to be ours.
        }
      }
      throw error;
    } finally {
      if (ownerHandle !== undefined) {
        try {
          fs.closeSync(ownerHandle);
        } catch {
          // Preserve the publication error already being reported.
        }
      }
    }
  };

  const abandonOwner = (directory: string): boolean => {
    abandonedOwnerKeys.add(abandonedOwnerKey(directory, token));
    const published = publishAbandonedOwnerMarker(directory, token);
    const coordinationKey = canonicalLockDirectoryPath(directory);
    const ownedIdentity = ownedDirectories.get(coordinationKey);
    if (!ownedIdentity) {
      return published;
    }
    try {
      const current = fs.lstatSync(directory, { bigint: true });
      if (current.isDirectory() && directoryIdentityMatches(ownedIdentity, current)) {
        abandonedDirectoryIdentities.set(coordinationKey, {
          ...ownedIdentity,
          ownerGenerationKey: token,
        });
      }
    } catch {
      // The path no longer names the directory published by this wrapper.
    }
    return published;
  };

  const ownerStatus = (
    candidate: ParsedLockOwner | null | undefined,
    forceIdentityRefresh = false,
  ): OwnerStatus => {
    if (!candidate) {
      return "unknown";
    }
    const claim = candidate.owner;
    if (
      abandonedOwnerKeys.has(abandonedOwnerKey(candidate.lockDirectory, claim.token)) ||
      hasAbandonedOwnerMarker(candidate)
    ) {
      return "dead";
    }
    if (
      claim.version >= 3 &&
      claim.machineIdentity !== null &&
      claim.machineIdentity !== currentMachineIdentity
    ) {
      return "foreign";
    }
    if (
      process.platform === "linux" &&
      claim.version >= 2 &&
      (claim.processNamespace === null ||
        currentProcessNamespace === null ||
        claim.processNamespace !== currentProcessNamespace)
    ) {
      return "foreign";
    }
    if (claim.version === 2 && (process.platform === "darwin" || process.platform === "win32")) {
      return "foreign";
    }
    if (!isProcessAlive(claim.pid)) {
      if (process.platform === "linux" && claim.version === 1 && claim.processNamespace === null) {
        return "unknown";
      }
      return "dead";
    }
    if (isDefunctProcess(claim.pid)) {
      return "dead";
    }
    if (claim.pid === process.pid) {
      if (claim.processIdentity !== null && isExactProcessIdentity(claim.processIdentity)) {
        if (claim.processIdentity !== currentProcessIdentity) {
          return "dead";
        }
        return claim.version === 4 &&
          claim.executionIdentity !== null &&
          claim.executionIdentity !== CURRENT_EXECUTION_IDENTITY
          ? "foreign"
          : "active";
      }
      if (claim.processStartedAtMs !== CURRENT_PROCESS_STARTED_AT_MS) {
        return "superseded";
      }
      return claim.executionIdentity !== null &&
        claim.executionIdentity !== CURRENT_EXECUTION_IDENTITY
        ? "superseded"
        : "active";
    }
    const now = Date.now();
    if (
      forceIdentityRefresh ||
      !cachedForeignIdentity ||
      cachedForeignIdentity.pid !== claim.pid ||
      cachedForeignIdentity.ownerGenerationKey !== claim.token ||
      now - cachedForeignIdentity.checkedAt >= IDENTITY_CACHE_MS
    ) {
      const observedIdentity = identityReader(claim.pid);
      cachedForeignIdentity = {
        checkedAt: now,
        identity: observedIdentity,
        ownerGenerationKey: claim.token,
        pid: claim.pid,
        startedAtMs:
          processStartedAtMsFromIdentity(observedIdentity) ??
          readLegacyProcessStartedAtMs(claim.pid),
      };
    }
    if (
      claim.processIdentity === null ||
      isCoarseDarwinIdentity(claim.processIdentity) ||
      !isExactProcessIdentity(claim.processIdentity)
    ) {
      if (claim.version !== 1 || cachedForeignIdentity.startedAtMs === null) {
        return "unknown";
      }
      return legacyProcessStartMatches(claim.processStartedAtMs, cachedForeignIdentity.startedAtMs)
        ? "active"
        : "superseded";
    }
    if (cachedForeignIdentity.identity === null) {
      return "unknown";
    }
    if (process.platform === "darwin" && isCoarseDarwinIdentity(cachedForeignIdentity.identity)) {
      return cachedForeignIdentity.startedAtMs === null
        ? "unknown"
        : legacyProcessStartMatches(claim.processStartedAtMs, cachedForeignIdentity.startedAtMs)
          ? "active"
          : "superseded";
    }
    return cachedForeignIdentity.identity === claim.processIdentity ? "active" : "dead";
  };

  const createRecoveryClaim = (
    claimPath: string,
    callback: (error: NodeJS.ErrnoException | null, claim?: RecoveryClaim) => void,
  ): void => {
    fs.mkdir(claimPath, { mode: 0o700 }, (claimError) => {
      if (!claimError) {
        let createdIdentity: DirectoryIdentity | undefined;
        try {
          const created = fs.lstatSync(claimPath, { bigint: true });
          if (!created.isDirectory() || created.isSymbolicLink()) {
            throw lockCleanupError("Recorder lock recovery claim changed during creation.");
          }
          createdIdentity = directoryIdentity(created);
          publishOwner(claimPath);
          const published = verifiedLockDirectoryStats(claimPath, createdIdentity);
          if (!published) {
            throw lockCleanupError("Recorder lock recovery claim disappeared during publication.");
          }
          callback(null, {
            activeIdentity: directoryIdentity(published),
            activePath: claimPath,
            ownerGenerationKey: token,
            supersededPaths: [],
          });
        } catch (ownerError) {
          if (createdIdentity) {
            try {
              removeVerifiedLockDirectorySync(claimPath, createdIdentity);
            } catch {
              // Preserve an unverified replacement instead of deleting it by pathname.
            }
          }
          callback(ownerError as NodeJS.ErrnoException);
        }
        return;
      }
      if (claimError.code !== "EEXIST") {
        callback(claimError);
        return;
      }
      let existingFingerprint: string | undefined;
      let existingIdentity: SupersededRecoveryClaim["identity"] | undefined;
      let existingOwnerFingerprint: string | undefined;
      try {
        const initialStats = fs.lstatSync(claimPath, { bigint: true });
        if (initialStats.isDirectory() && !initialStats.isSymbolicLink()) {
          const initialIdentity = directoryIdentity(initialStats);
          const existingClaim = parseOwner(claimPath);
          const stats = verifiedLockDirectoryStats(
            claimPath,
            initialIdentity,
            initialStats.mtimeMs,
          );
          if (!stats) {
            throw lockCleanupError("Recorder lock recovery claim disappeared during inspection.");
          }
          if (existingClaim) {
            const status = ownerStatus(existingClaim);
            const recoverableForeign =
              status === "foreign" && isRecoverableForeignOwner(existingClaim, status, stats);
            const recoverableUnverifiable = isRecoverableUnverifiableOwner(existingClaim, status);
            const recoverableUnknown =
              isRecoverableUnknownOwner(existingClaim, status, stats) &&
              isRecoverableUnknownOwner(existingClaim, ownerStatus(existingClaim, true), stats);
            if (
              status === "dead" ||
              recoverableForeign ||
              recoverableUnverifiable ||
              recoverableUnknown
            ) {
              existingFingerprint = `owner:${existingClaim.owner.token}`;
              existingOwnerFingerprint = existingFingerprint;
            }
          } else if (isRecoverableOwnerlessClaim(stats)) {
            existingOwnerFingerprint = existingClaim === undefined ? "ownerless" : "malformed";
            existingFingerprint = `${existingOwnerFingerprint}:${stats.dev}:${stats.ino}:${stats.mtimeMs}`;
          }
          if (existingFingerprint) {
            existingIdentity = {
              ...directoryIdentity(stats),
              mtimeMs: stats.mtimeMs,
            };
          }
        }
      } catch {
        // Treat a concurrently changing claim as active.
      }
      if (!existingFingerprint || !existingIdentity || !existingOwnerFingerprint) {
        callback(
          Object.assign(new Error("Recorder lock recovery is already in progress."), {
            code: "ELOCKED",
          }),
        );
        return;
      }
      const takeoverPath = recoveryClaimPath(claimPath, existingFingerprint);
      createRecoveryClaim(takeoverPath, (takeoverError, takeoverClaim) => {
        if (takeoverError || !takeoverClaim) {
          callback(
            takeoverError ??
              Object.assign(new Error("Recorder lock recovery claim failed."), {
                code: "ELOCKED",
              }),
          );
        } else {
          callback(null, {
            activeIdentity: takeoverClaim.activeIdentity,
            activePath: takeoverClaim.activePath,
            ownerGenerationKey: takeoverClaim.ownerGenerationKey,
            supersededPaths: [
              {
                identity: existingIdentity,
                ownerFingerprint: existingOwnerFingerprint,
                path: claimPath,
              },
              ...takeoverClaim.supersededPaths,
            ],
          });
        }
      });
    });
  };

  const releaseRecoveryClaim = (
    directory: string,
    claim: RecoveryClaim,
    callback: () => void,
  ): void => {
    const coordinationKey = canonicalLockDirectoryPath(directory);
    // Retire nested takeover paths before the base claim so any failure leaves
    // the active claim discoverable through the original coordination path.
    const supersededPaths = [...claim.supersededPaths].reverse();
    let removedSupersededPath = false;
    const removeActiveClaim = (): void => {
      let activeError: NodeJS.ErrnoException | null = null;
      try {
        removeVerifiedLockDirectorySync(claim.activePath, claim.activeIdentity);
      } catch (error) {
        activeError = error as NodeJS.ErrnoException;
      }
      if (activeError && !abandonOwner(claim.activePath)) {
        retainedCoordinationClaims.set(coordinationKey, claim);
      }
      callback();
    };
    const preserveActiveClaim = (): void => {
      if (!abandonOwner(claim.activePath)) {
        retainedCoordinationClaims.set(coordinationKey, claim);
      }
      callback();
    };
    const removeSuperseded = (index: number): void => {
      const superseded = supersededPaths[index];
      if (!superseded) {
        removeActiveClaim();
        return;
      }
      let current: fs.BigIntStats | undefined;
      try {
        current = verifiedLockDirectoryStats(
          superseded.path,
          superseded.identity,
          superseded.identity.mtimeMs,
        );
      } catch {
        if (!removedSupersededPath) {
          preserveActiveClaim();
          return;
        }
        removeActiveClaim();
        return;
      }
      if (!current) {
        removedSupersededPath = true;
        removeSuperseded(index + 1);
        return;
      }
      const currentOwner = parseOwner(superseded.path);
      try {
        current = verifiedLockDirectoryStats(
          superseded.path,
          superseded.identity,
          superseded.identity.mtimeMs,
        );
      } catch {
        if (!removedSupersededPath) {
          preserveActiveClaim();
          return;
        }
        removeActiveClaim();
        return;
      }
      if (!current) {
        removedSupersededPath = true;
        removeSuperseded(index + 1);
        return;
      }
      const currentFingerprint = currentOwner
        ? `owner:${currentOwner.owner.token}`
        : currentOwner === undefined
          ? "ownerless"
          : "malformed";
      if (currentFingerprint !== superseded.ownerFingerprint) {
        if (!removedSupersededPath) {
          preserveActiveClaim();
          return;
        }
        removeActiveClaim();
        return;
      }
      try {
        removeVerifiedLockDirectorySync(
          superseded.path,
          superseded.identity,
          superseded.identity.mtimeMs,
        );
      } catch {
        if (!removedSupersededPath) {
          preserveActiveClaim();
          return;
        }
        removeActiveClaim();
        return;
      }
      removedSupersededPath = true;
      removeSuperseded(index + 1);
    };
    removeSuperseded(0);
  };

  const acquireCoordinationClaim = (
    directory: string,
    callback: (error: NodeJS.ErrnoException | null, claim?: RecoveryClaim) => void,
  ): void => {
    const coordinationKey = canonicalLockDirectoryPath(directory);
    const retainedClaim = retainedCoordinationClaims.get(coordinationKey);
    if (retainedClaim) {
      let retainedClaimIsOwned = false;
      try {
        const current = verifiedLockDirectoryStats(
          retainedClaim.activePath,
          retainedClaim.activeIdentity,
        );
        const retainedOwner = current ? parseOwner(retainedClaim.activePath) : undefined;
        retainedClaimIsOwned =
          retainedOwner !== undefined &&
          retainedOwner !== null &&
          retainedOwner.owner.token === retainedClaim.ownerGenerationKey &&
          ownerStatus(retainedOwner) === "active";
      } catch {
        retainedClaimIsOwned = false;
      }
      if (retainedClaimIsOwned) {
        if (retainedClaim.ownerGenerationKey !== token) {
          callback(
            lockCleanupError("Recorder lock retained coordination claim is owned elsewhere."),
          );
          return;
        }
        retainedCoordinationClaims.delete(coordinationKey);
        callback(null, retainedClaim);
        return;
      }
      if (retainedCoordinationClaims.get(coordinationKey) === retainedClaim) {
        retainedCoordinationClaims.delete(coordinationKey);
      }
    }
    createRecoveryClaim(recoveryClaimPath(directory), callback);
  };

  const lockFs = Object.create(fs) as typeof fs;
  lockFs.mkdir = ((
    directoryPath: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => {
    const directory = String(directoryPath);
    acquireCoordinationClaim(directory, (claimError, coordinationClaim) => {
      if (claimError || !coordinationClaim) {
        callback(
          claimError ??
            Object.assign(new Error("Recorder lock coordination failed."), {
              code: "ELOCKED",
            }),
        );
        return;
      }
      fs.mkdir(directoryPath, (error) => {
        if (error) {
          if (error.code === "EEXIST" && coordinationClaim.supersededPaths.length > 0) {
            try {
              const existing = fs.lstatSync(directoryPath, { bigint: true });
              const candidate = parseOwner(directoryPath);
              if (
                existing.isDirectory() &&
                !existing.isSymbolicLink() &&
                (candidate === undefined || candidate === null)
              ) {
                const coordinationKey = canonicalLockDirectoryPath(directory);
                interruptedPublicationIdentities.set(coordinationKey, directoryIdentity(existing));
                retainedCoordinationClaims.set(coordinationKey, coordinationClaim);
                callback(error);
                return;
              }
            } catch {
              // Fall through to normal cleanup for a changing target.
            }
          }
          releaseRecoveryClaim(directory, coordinationClaim, () => callback(error));
          return;
        }
        let createdIdentity: DirectoryIdentity | undefined;
        let ownerPublished = false;
        let publicationError: NodeJS.ErrnoException | null = null;
        try {
          const createdDirectory = fs.lstatSync(directoryPath, { bigint: true });
          if (!createdDirectory.isDirectory() || createdDirectory.isSymbolicLink()) {
            throw new Error("Recorder lock directory changed during creation.");
          }
          const candidateIdentity = directoryIdentity(createdDirectory);
          const createdEntries = fs.readdirSync(directoryPath);
          if (
            createdEntries.length > 0 ||
            !verifiedLockDirectoryStats(directoryPath, candidateIdentity)
          ) {
            throw lockCleanupError("Recorder lock directory changed during creation.");
          }
          createdIdentity = candidateIdentity;
          publishOwner(directory);
          ownerPublished = true;
          const publishedDirectory = verifiedLockDirectoryStats(directory, createdIdentity);
          if (!publishedDirectory) {
            throw new Error("Recorder lock directory changed during owner publication.");
          }
          ownedDirectories.set(
            canonicalLockDirectoryPath(directory),
            directoryIdentity(publishedDirectory),
          );
          interruptedPublicationIdentities.delete(canonicalLockDirectoryPath(directory));
        } catch (ownerError) {
          publicationError = ownerError as NodeJS.ErrnoException;
        }
        if (publicationError) {
          if (ownerPublished && createdIdentity) {
            try {
              if (verifiedLockDirectoryStats(directory, createdIdentity)) {
                abandonOwner(directory);
              }
            } catch {
              // Preserve an unverified replacement instead of mutating it by pathname.
            }
          } else if (createdIdentity) {
            try {
              removeVerifiedLockDirectorySync(directoryPath, createdIdentity);
            } catch {
              // Preserve an unverified replacement instead of deleting it by pathname.
            }
          }
          releaseRecoveryClaim(directory, coordinationClaim, () => callback(publicationError));
          return;
        }
        releaseRecoveryClaim(directory, coordinationClaim, () => callback(null));
      });
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
      const coordinationKey = canonicalLockDirectoryPath(filePath);
      let identityStats: fs.BigIntStats | undefined;
      try {
        const current = fs.lstatSync(filePath, { bigint: true });
        if (current.isDirectory() && !current.isSymbolicLink()) {
          identityStats = current;
        }
      } catch {
        // A changing path cannot match an identity-based recovery fence.
      }
      if (
        identityStats &&
        directoryIdentityMatches(abandonedDirectoryIdentities.get(coordinationKey), identityStats)
      ) {
        callback(null, syntheticStaleStat(stats));
        return;
      }
      const candidate = parseOwner(filePath);
      const status = ownerStatus(candidate);
      if (candidate !== undefined && candidate !== null) {
        interruptedPublicationIdentities.delete(coordinationKey);
      }
      const recoverableInterruptedPublication =
        (candidate === undefined || candidate === null) &&
        identityStats !== undefined &&
        directoryIdentityMatches(
          interruptedPublicationIdentities.get(coordinationKey),
          identityStats,
        ) &&
        Date.now() - stats.mtimeMs >= OWNERLESS_LOCK_RECOVERY_MS;
      const recoverableAgedUnverifiableOwner =
        isRecoverableOwnerlessClaim(stats) &&
        (candidate === undefined || (candidate === null && hasRecoverableMalformedOwner(filePath)));
      const recoverableForeign =
        candidate !== undefined &&
        candidate !== null &&
        isRecoverableForeignOwner(candidate, status, stats);
      const recoverableUnknown =
        candidate !== undefined &&
        candidate !== null &&
        isRecoverableUnknownOwner(candidate, status, stats);
      if (
        candidate &&
        abandonedOwnerKeys.has(abandonedOwnerKey(candidate.lockDirectory, candidate.owner.token))
      ) {
        callback(null, syntheticStaleStat(stats));
        return;
      }
      if (candidate && hasAbandonedOwnerMarker(candidate)) {
        callback(null, syntheticStaleStat(stats));
        return;
      }
      callback(
        null,
        candidate?.owner.token === token ||
          status === "dead" ||
          recoverableForeign ||
          recoverableUnknown ||
          recoverableInterruptedPublication ||
          recoverableAgedUnverifiableOwner ||
          (candidate !== undefined &&
            candidate !== null &&
            isRecoverableUnverifiableOwner(candidate, status))
          ? stats
          : syntheticFreshStat(stats),
      );
    });
  }) as typeof fs.stat;
  lockFs.rmdir = ((
    directoryPath: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => {
    const directory = String(directoryPath);
    const coordinationKey = canonicalLockDirectoryPath(directory);
    const releaseDeadline = Date.now() + COORDINATION_RELEASE_WAIT_MS;
    const acquireForRemoval = (): void => {
      acquireCoordinationClaim(directory, (claimError, coordinationClaim) => {
        if (
          claimError?.code === "ELOCKED" &&
          ownedDirectories.has(coordinationKey) &&
          Date.now() < releaseDeadline
        ) {
          setTimeout(acquireForRemoval, COORDINATION_RELEASE_RETRY_MS);
          return;
        }
        if (claimError || !coordinationClaim) {
          if (ownedDirectories.has(coordinationKey)) {
            abandonOwner(directory);
          }
          callback(
            claimError ??
              Object.assign(new Error("Recorder lock coordination failed."), {
                code: "ELOCKED",
              }),
          );
          return;
        }
        const finish = (error: NodeJS.ErrnoException | null): void => {
          releaseRecoveryClaim(directory, coordinationClaim, () => callback(error));
        };
        const candidate = parseOwner(directoryPath);
        let initialStats: fs.BigIntStats;
        try {
          initialStats = fs.lstatSync(directoryPath, { bigint: true });
          if (!initialStats.isDirectory() || initialStats.isSymbolicLink()) {
            throw lockCleanupError("Recorder lock recovery target is not a directory.");
          }
        } catch (error) {
          finish(error as NodeJS.ErrnoException);
          return;
        }
        if (candidate !== undefined && candidate !== null) {
          interruptedPublicationIdentities.delete(coordinationKey);
        }
        const ownedIdentity = ownedDirectories.get(coordinationKey);
        const ownsPublishedDirectory = directoryIdentityMatches(ownedIdentity, initialStats);
        if (
          (candidate?.owner.token === token && ownsPublishedDirectory) ||
          ((candidate === null || candidate === undefined) && ownsPublishedDirectory)
        ) {
          const tombstonePath = `${coordinationClaim.activePath}.${token}.release`;
          fs.rename(directoryPath, tombstonePath, (renameError) => {
            if (renameError) {
              abandonOwner(directory);
              finish(renameError);
              return;
            }
            ownedDirectories.delete(coordinationKey);
            abandonedDirectoryIdentities.delete(coordinationKey);
            abandonedOwnerKeys.delete(abandonedOwnerKey(directory, token));
            try {
              removeVerifiedLockDirectorySync(tombstonePath, directoryIdentity(initialStats));
              finish(null);
            } catch (error) {
              finish(error as NodeJS.ErrnoException);
            }
          });
          return;
        }
        if (candidate === null && ownedDirectories.has(coordinationKey)) {
          abandonOwner(directory);
          finish(
            Object.assign(
              new Error("Recorder lock owner metadata cannot be verified for release."),
              {
                code: "ELOCKED",
              },
            ),
          );
          return;
        }
        let ownerlessStats: fs.BigIntStats | undefined;
        let foreignStats: fs.BigIntStats | undefined;
        let recoverableAbandoned = false;
        let recoverableInterruptedPublication = false;
        let recoverableAgedUnverifiableOwner = false;
        const status = ownerStatus(candidate);
        const recoverableUnverifiable =
          candidate !== undefined &&
          candidate !== null &&
          isRecoverableUnverifiableOwner(candidate, status);
        const recoverableForeign =
          candidate !== undefined &&
          candidate !== null &&
          isRecoverableForeignOwner(candidate, status, initialStats);
        const recoverableUnknown =
          candidate !== undefined &&
          candidate !== null &&
          isRecoverableUnknownOwner(candidate, status, initialStats);
        if (recoverableForeign) {
          foreignStats = initialStats;
        }
        if (candidate === undefined || candidate === null) {
          ownerlessStats = initialStats;
          recoverableAbandoned = directoryIdentityMatches(
            abandonedDirectoryIdentities.get(coordinationKey),
            ownerlessStats,
          );
          recoverableInterruptedPublication =
            directoryIdentityMatches(
              interruptedPublicationIdentities.get(coordinationKey),
              ownerlessStats,
            ) && Date.now() - statMtimeMs(ownerlessStats) >= OWNERLESS_LOCK_RECOVERY_MS;
          recoverableAgedUnverifiableOwner =
            isRecoverableOwnerlessClaim(ownerlessStats) &&
            (candidate === undefined ||
              (candidate === null && hasRecoverableMalformedOwner(directoryPath)));
        }
        if (
          status !== "dead" &&
          !recoverableForeign &&
          !recoverableUnknown &&
          !recoverableUnverifiable &&
          !recoverableAbandoned &&
          !recoverableInterruptedPublication &&
          !recoverableAgedUnverifiableOwner
        ) {
          finish(
            Object.assign(new Error("Recorder lock owner is still active or cannot be verified."), {
              code: "ELOCKED",
            }),
          );
          return;
        }
        const refreshed = parseOwner(directoryPath);
        const refreshedStatus = ownerStatus(refreshed, recoverableUnknown);
        let refreshedStats: fs.BigIntStats | undefined;
        try {
          const current = fs.lstatSync(directoryPath, { bigint: true });
          if (
            current.isDirectory() &&
            !current.isSymbolicLink() &&
            current.dev === initialStats.dev &&
            current.ino === initialStats.ino &&
            current.mtimeMs === initialStats.mtimeMs
          ) {
            refreshedStats = current;
          }
        } catch {
          // A changed recovery target fails authorization below.
        }
        let recoveryStillAuthorized =
          candidate !== undefined &&
          candidate !== null &&
          refreshedStats !== undefined &&
          lockOwnerMatches(candidate, refreshed) &&
          (refreshedStatus === "dead" ||
            (recoverableForeign &&
              refreshed !== undefined &&
              refreshed !== null &&
              foreignStats !== undefined &&
              refreshedStats.dev === foreignStats.dev &&
              refreshedStats.ino === foreignStats.ino &&
              refreshedStats.mtimeMs === foreignStats.mtimeMs &&
              isRecoverableForeignOwner(refreshed, refreshedStatus, refreshedStats)) ||
            (recoverableUnknown &&
              refreshed !== undefined &&
              refreshed !== null &&
              isRecoverableUnknownOwner(refreshed, refreshedStatus, refreshedStats)) ||
            (refreshed !== undefined &&
              refreshed !== null &&
              isRecoverableUnverifiableOwner(refreshed, refreshedStatus)));
        if (recoverableAbandoned && ownerlessStats) {
          try {
            recoveryStillAuthorized =
              refreshedStats !== undefined &&
              directoryIdentityMatches(
                abandonedDirectoryIdentities.get(coordinationKey),
                refreshedStats,
              );
          } catch {
            recoveryStillAuthorized = false;
          }
        }
        if (recoverableInterruptedPublication && ownerlessStats) {
          try {
            recoveryStillAuthorized =
              refreshedStats !== undefined &&
              refreshed === undefined &&
              refreshedStats.dev === ownerlessStats.dev &&
              refreshedStats.ino === ownerlessStats.ino &&
              refreshedStats.mtimeMs === ownerlessStats.mtimeMs &&
              directoryIdentityMatches(
                interruptedPublicationIdentities.get(coordinationKey),
                refreshedStats,
              ) &&
              Date.now() - statMtimeMs(refreshedStats) >= OWNERLESS_LOCK_RECOVERY_MS;
          } catch {
            recoveryStillAuthorized = false;
          }
        }
        if (recoverableAgedUnverifiableOwner && ownerlessStats) {
          try {
            recoveryStillAuthorized =
              refreshedStats !== undefined &&
              (candidate === undefined ? refreshed === undefined : refreshed === null) &&
              (candidate !== null || hasRecoverableMalformedOwner(directoryPath)) &&
              refreshedStats.dev === ownerlessStats.dev &&
              refreshedStats.ino === ownerlessStats.ino &&
              refreshedStats.mtimeMs === ownerlessStats.mtimeMs &&
              isRecoverableOwnerlessClaim(refreshedStats);
          } catch {
            recoveryStillAuthorized = false;
          }
        }
        if (!recoveryStillAuthorized) {
          finish(
            Object.assign(new Error("Recorder lock owner changed during recovery."), {
              code: "ELOCKED",
            }),
          );
          return;
        }
        const tombstonePath = `${coordinationClaim.activePath}.${token}.lock`;
        fs.rename(directoryPath, tombstonePath, (renameError) => {
          if (renameError) {
            finish(renameError);
            return;
          }
          try {
            removeVerifiedLockDirectorySync(tombstonePath, directoryIdentity(initialStats));
            if (candidate) {
              abandonedOwnerKeys.delete(
                abandonedOwnerKey(candidate.lockDirectory, candidate.owner.token),
              );
            }
            interruptedPublicationIdentities.delete(coordinationKey);
            const abandonedIdentity = abandonedDirectoryIdentities.get(coordinationKey);
            if (abandonedIdentity) {
              abandonedOwnerKeys.delete(
                abandonedOwnerKey(directory, abandonedIdentity.ownerGenerationKey),
              );
              abandonedDirectoryIdentities.delete(coordinationKey);
            }
            retainedCoordinationClaims.set(
              canonicalLockDirectoryPath(directory),
              coordinationClaim,
            );
            callback(null);
          } catch (error) {
            finish(error as NodeJS.ErrnoException);
          }
        });
      });
    };
    acquireForRemoval();
  }) as typeof fs.rmdir;
  lockFs.rmdirSync = ((directoryPath: fs.PathLike) => {
    const directory = String(directoryPath);
    const claimPath = recoveryClaimPath(directory);
    fs.mkdirSync(claimPath, { mode: 0o700 });
    const createdClaim = fs.lstatSync(claimPath, { bigint: true });
    if (!createdClaim.isDirectory() || createdClaim.isSymbolicLink()) {
      throw lockCleanupError("Recorder lock recovery claim changed during creation.");
    }
    const coordinationClaim: RecoveryClaim = {
      activeIdentity: directoryIdentity(createdClaim),
      activePath: claimPath,
      ownerGenerationKey: token,
      supersededPaths: [],
    };
    try {
      publishOwner(claimPath);
      if (!verifiedLockDirectoryStats(claimPath, coordinationClaim.activeIdentity)) {
        throw lockCleanupError("Recorder lock recovery claim disappeared during publication.");
      }
      const candidate = parseOwner(directoryPath);
      if (candidate?.owner.token !== token) {
        throw Object.assign(new Error("Recorder lock is not owned by this process."), {
          code: "ELOCKED",
        });
      }
      const ownedIdentity = ownedDirectories.get(canonicalLockDirectoryPath(directory));
      const ownedDirectory = fs.lstatSync(directoryPath, { bigint: true });
      if (
        !ownedDirectory.isDirectory() ||
        ownedDirectory.isSymbolicLink() ||
        !directoryIdentityMatches(ownedIdentity, ownedDirectory)
      ) {
        throw lockCleanupError("Recorder lock ownership changed before release.");
      }
      const tombstonePath = `${claimPath}.${token}.release`;
      fs.renameSync(directoryPath, tombstonePath);
      removeVerifiedLockDirectorySync(tombstonePath, directoryIdentity(ownedDirectory));
      ownedDirectories.delete(canonicalLockDirectoryPath(directory));
    } finally {
      try {
        removeVerifiedLockDirectorySync(
          coordinationClaim.activePath,
          coordinationClaim.activeIdentity,
        );
      } catch {
        // Exit cleanup is best-effort; a live coordination claim is safer than an ABA race.
      }
    }
  }) as typeof fs.rmdirSync;
  return lockFs;
}
