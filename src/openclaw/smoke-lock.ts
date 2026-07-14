import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsSync, { readFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isCrablineServerChannel, type CrablineServerChannel } from "../servers/index.js";
import { resolveWindowsPowerShellPath, securePrivateDirectory } from "./private-file.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "./shared.js";

type LegacySmokeLockOwner = {
  channel: CrablineServerChannel;
  pid: number;
  token: string;
};

type ProcessIdentifiedSmokeLockOwner = LegacySmokeLockOwner & {
  createdAtMs: number;
  processIdentity?: string;
  processIdentityV2?: string;
  processStartedAtMs: number;
};

type RenewableSmokeLockOwner = ProcessIdentifiedSmokeLockOwner & {
  leaseVersion: 1;
};

type SmokeLockOwner =
  | LegacySmokeLockOwner
  | ProcessIdentifiedSmokeLockOwner
  | RenewableSmokeLockOwner;

type SmokeLockRecord = {
  owner: SmokeLockOwner;
  renewedAtMs: number;
};

export type OpenClawCrablineSmokeRunLock = {
  assertOwned(): Promise<void>;
  commitFileAtomically(params: {
    contents: string;
    destinationPath: string;
    // The directory is an identity fence; temporary contents remain lock-claim-local.
    stageDirectory?: string;
    stageFile(filePath: string, contents: string): Promise<void>;
  }): Promise<void>;
  release(): Promise<void>;
};

type HeartbeatController = {
  assertHealthy(): void;
  settle(): Promise<void>;
  stop(): Promise<void>;
};
type RemoveLockDirectory = (lockDirectory: string) => Promise<void>;
type Sleep = (delayMs: number) => Promise<void>;
type IsProcessAlive = (pid: number) => boolean;
type GetProcessIdentity = (pid: number) => string | null;
type StartHeartbeat = (renew: () => Promise<void>, intervalMs: number) => HeartbeatController;
type BeforeRecoveryClaim = () => Promise<void>;
type BeforeRecoveryDeleteClaim = () => Promise<void>;
type BeforeCompatibilityMarkerRenew = () => Promise<void>;
type BeforeReleaseClaim = () => Promise<void>;
type BeforeReleaseRename = () => Promise<void>;
type BeforeReleaseRemove = () => Promise<void>;
type BeforeCommitClaim = () => Promise<void>;
type BeforeCommitFileRename = () => Promise<void>;
type BeforeCommitRename = () => Promise<void>;
type SecureWindowsDirectory = (directoryPath: string) => Promise<void>;
type AfterLockDirectoryWrite = (directoryPath: string) => Promise<void>;
type LockClaimKind = "commit" | "owned" | "recovering" | "release";
type LockClaim = {
  directoryPath: string;
  kind: LockClaimKind;
};
type DirectoryIdentity = {
  device: bigint;
  inode: bigint;
};
type FileIdentity = DirectoryIdentity;

type SmokeLockRuntime = {
  currentProcessIdentity: string | null;
  currentProcessIdentityV2: string | null;
  currentPid: number;
  currentProcessStartedAtMs: number;
  getProcessIdentity: GetProcessIdentity;
  getProcessIdentityV2: GetProcessIdentity;
  isProcessAlive: IsProcessAlive;
  leaseMs: number;
  now: () => number;
  sleep: Sleep;
};

const LOCK_OWNER_FILE = "owner.json";
const LOCK_LEASE_FILE_PREFIX = "lease.";
const LOCK_COMMIT_STAGE_FILE_PREFIX = "commit-stage.";
const LOCK_STAGED_FILE_PREFIX = ".commit-file.";
const LEGACY_RECOVERY_SUFFIX = ".recovering";
const COMMIT_CLAIM_SUFFIX = ".commit";
const OWNED_CLAIM_SUFFIX = ".owned";
const RELEASE_CLAIM_SUFFIX = ".release";
const LOCK_LEASE_MS = 10 * 60 * 1000;
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 10;
const MAX_PROCESS_ID = 2_147_483_647;
const CURRENT_PROCESS_STARTED_AT_MS = processStartedAtMsFromTimeOrigin(performance.timeOrigin);

export function processStartedAtMsFromTimeOrigin(timeOrigin: number): number {
  if (
    !Number.isFinite(timeOrigin) ||
    timeOrigin <= 0 ||
    !Number.isSafeInteger(Math.trunc(timeOrigin))
  ) {
    throw new Error("Process time origin is invalid.");
  }
  return Math.trunc(timeOrigin);
}

const sleep: Sleep = async (delayMs) => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const startHeartbeat: StartHeartbeat = (renew, intervalMs) => {
  let failure: unknown;
  let pending: Promise<void> | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      pending = renew()
        .catch((error: unknown) => {
          failure ??= error;
        })
        .finally(() => {
          pending = undefined;
          schedule();
        });
    }, intervalMs);
    timer.unref();
  };

  schedule();
  return {
    assertHealthy() {
      if (failure !== undefined) {
        throw new Error("OpenClaw Crabline smoke lock heartbeat failed.", { cause: failure });
      }
    },
    async settle() {
      await pending;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await pending;
    },
  };
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function readDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity | null> {
  try {
    const stats = await fs.lstat(directoryPath, { bigint: true });
    if (!stats.isDirectory() || stats.ino <= 0n) {
      throw new Error("OpenClaw Crabline smoke lock claim is not a directory.");
    }
    return {
      device: stats.dev,
      inode: stats.ino,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

async function readFileIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const stats = await fs.lstat(filePath, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n || stats.ino <= 0n) {
      return null;
    }
    return {
      device: stats.dev,
      inode: stats.ino,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function hasSameDirectoryIdentity(
  left: DirectoryIdentity | null,
  right: DirectoryIdentity | null,
): boolean {
  return (
    left !== null && right !== null && left.device === right.device && left.inode === right.inode
  );
}

function isOwnedLockArtifactName(name: string, token: string): boolean {
  const leaseName = leaseFileName(token);
  const commitStageName = `${LOCK_COMMIT_STAGE_FILE_PREFIX}${token}.json`;
  return (
    name === LOCK_OWNER_FILE ||
    name === leaseName ||
    (name.startsWith(`.${leaseName}.`) && name.endsWith(".tmp")) ||
    name === commitStageName ||
    (name.startsWith(`.${LOCK_COMMIT_STAGE_FILE_PREFIX}${token}.`) && name.endsWith(".tmp")) ||
    (name.startsWith(`${LOCK_STAGED_FILE_PREFIX}${token}.`) && name.endsWith(".tmp"))
  );
}

async function removeVerifiedLockDirectory(params: {
  beforeRemove?: BeforeReleaseRemove;
  directoryPath: string;
  expectedIdentity: DirectoryIdentity;
  token: string;
}): Promise<void> {
  if (
    !hasSameDirectoryIdentity(
      params.expectedIdentity,
      await readDirectoryIdentity(params.directoryPath),
    )
  ) {
    throw new Error("OpenClaw Crabline smoke lock cleanup target changed.");
  }
  await params.beforeRemove?.();
  const quarantinePath = `${params.directoryPath}.cleanup.${randomUUID()}`;
  fsSync.renameSync(params.directoryPath, quarantinePath);
  let quarantinedIdentity: DirectoryIdentity | null = null;
  const stats = fsSync.lstatSync(quarantinePath, { bigint: true });
  if (stats.isDirectory() && !stats.isSymbolicLink() && stats.ino > 0n) {
    quarantinedIdentity = { device: stats.dev, inode: stats.ino };
  }
  if (!hasSameDirectoryIdentity(params.expectedIdentity, quarantinedIdentity)) {
    throw new Error("OpenClaw Crabline smoke lock cleanup target changed.");
  }

  const entries = fsSync.readdirSync(quarantinePath);
  const artifacts: Array<{ identity: FileIdentity; path: string }> = [];
  for (const entry of entries) {
    if (!isOwnedLockArtifactName(entry, params.token)) {
      throw new Error("OpenClaw Crabline smoke lock cleanup found an unexpected artifact.");
    }
    const artifactPath = path.join(quarantinePath, entry);
    const artifactStats = fsSync.lstatSync(artifactPath, { bigint: true });
    if (
      !artifactStats.isFile() ||
      artifactStats.isSymbolicLink() ||
      artifactStats.nlink !== 1n ||
      artifactStats.ino <= 0n
    ) {
      throw new Error("OpenClaw Crabline smoke lock cleanup found an unsafe artifact.");
    }
    artifacts.push({
      identity: { device: artifactStats.dev, inode: artifactStats.ino },
      path: artifactPath,
    });
  }
  artifacts.sort(
    (left, right) =>
      Number(path.basename(left.path) === LOCK_OWNER_FILE) -
      Number(path.basename(right.path) === LOCK_OWNER_FILE),
  );
  for (const artifact of artifacts) {
    const directoryStats = fsSync.lstatSync(quarantinePath, { bigint: true });
    const artifactStats = fsSync.lstatSync(artifact.path, { bigint: true });
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      directoryStats.dev !== params.expectedIdentity.device ||
      directoryStats.ino !== params.expectedIdentity.inode ||
      !artifactStats.isFile() ||
      artifactStats.isSymbolicLink() ||
      artifactStats.nlink !== 1n ||
      artifactStats.dev !== artifact.identity.device ||
      artifactStats.ino !== artifact.identity.inode
    ) {
      throw new Error("OpenClaw Crabline smoke lock cleanup artifact changed.");
    }
    fsSync.unlinkSync(artifact.path);
  }
  const finalStats = fsSync.lstatSync(quarantinePath, { bigint: true });
  if (
    !finalStats.isDirectory() ||
    finalStats.isSymbolicLink() ||
    finalStats.dev !== params.expectedIdentity.device ||
    finalStats.ino !== params.expectedIdentity.inode
  ) {
    throw new Error("OpenClaw Crabline smoke lock cleanup target changed.");
  }
  fsSync.rmdirSync(quarantinePath);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isValidProcessId(value: unknown): value is number {
  return isPositiveSafeInteger(value) && Number(value) <= MAX_PROCESS_ID;
}

const LOCK_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function parseLockOwner(contents: string): SmokeLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.");
  }
  const owner = parsed as Partial<RenewableSmokeLockOwner>;
  if (
    typeof owner.channel !== "string" ||
    !isCrablineServerChannel(owner.channel) ||
    !isValidProcessId(owner.pid) ||
    typeof owner.token !== "string" ||
    !LOCK_TOKEN_PATTERN.test(owner.token)
  ) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.");
  }

  const hasCreatedAt = owner.createdAtMs !== undefined;
  const hasProcessStartedAt = owner.processStartedAtMs !== undefined;
  if (!hasCreatedAt && !hasProcessStartedAt && owner.leaseVersion === undefined) {
    return {
      channel: owner.channel,
      pid: owner.pid,
      token: owner.token,
    };
  }
  if (
    !isPositiveSafeInteger(owner.createdAtMs) ||
    !isPositiveSafeInteger(owner.processStartedAtMs) ||
    (owner.processIdentity !== undefined &&
      (typeof owner.processIdentity !== "string" ||
        owner.processIdentity.length === 0 ||
        owner.processIdentity.length > 256)) ||
    (owner.processIdentityV2 !== undefined &&
      (typeof owner.processIdentityV2 !== "string" ||
        owner.processIdentityV2.length === 0 ||
        owner.processIdentityV2.length > 256))
  ) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.");
  }
  if (owner.leaseVersion === undefined) {
    return {
      channel: owner.channel,
      createdAtMs: owner.createdAtMs,
      pid: owner.pid,
      ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
      ...(owner.processIdentityV2 ? { processIdentityV2: owner.processIdentityV2 } : {}),
      processStartedAtMs: owner.processStartedAtMs,
      token: owner.token,
    };
  }
  if (owner.leaseVersion !== 1) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.");
  }
  return {
    channel: owner.channel,
    createdAtMs: owner.createdAtMs,
    leaseVersion: owner.leaseVersion,
    pid: owner.pid,
    ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
    ...(owner.processIdentityV2 ? { processIdentityV2: owner.processIdentityV2 } : {}),
    processStartedAtMs: owner.processStartedAtMs,
    token: owner.token,
  };
}

function leaseFileName(token: string): string {
  return `${LOCK_LEASE_FILE_PREFIX}${token}.json`;
}

async function readLockRecordFromHandle(handle: FileHandle): Promise<SmokeLockRecord> {
  const owner = parseLockOwner(await handle.readFile("utf8"));
  const stats = await handle.stat();
  return {
    owner,
    renewedAtMs: Number.isFinite(stats.mtimeMs) && stats.mtimeMs > 0 ? stats.mtimeMs : 0,
  };
}

type LockRecordReadResult = { kind: "missing" } | { kind: "record"; record: SmokeLockRecord };

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readLockRecord(lockDirectory: string): Promise<LockRecordReadResult> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path.join(lockDirectory, LOCK_OWNER_FILE), "r");
    const record = await readLockRecordFromHandle(handle);
    if (isRenewableOwner(record.owner)) {
      try {
        const leaseStats = await fs.stat(
          path.join(lockDirectory, leaseFileName(record.owner.token)),
        );
        if (Number.isFinite(leaseStats.mtimeMs) && leaseStats.mtimeMs > 0) {
          record.renewedAtMs = Math.max(record.renewedAtMs, leaseStats.mtimeMs);
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
    return { kind: "record", record };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: "missing" };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function hasProcessIdentity(
  owner: SmokeLockOwner,
): owner is ProcessIdentifiedSmokeLockOwner | RenewableSmokeLockOwner {
  return "processStartedAtMs" in owner;
}

function isRenewableOwner(owner: SmokeLockOwner): owner is RenewableSmokeLockOwner {
  return "leaseVersion" in owner && owner.leaseVersion === 1;
}

export const isProcessAlive: IsProcessAlive = (pid) => {
  if (!isValidProcessId(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function processIdentityFromLinuxStat(value: string, bootId: string): string | null {
  const normalizedBootId = bootId.trim();
  if (!/^[0-9a-f-]{16,64}$/iu.test(normalizedBootId)) {
    return null;
  }
  const commandEnd = value.lastIndexOf(") ");
  if (commandEnd < 0) {
    return null;
  }
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/u.test(startTicks)) {
    return null;
  }
  return `linux:${normalizedBootId}:${startTicks}`;
}

export function processIdentityFromDarwin(
  processStartedAt: string,
  bootTime: string,
): string | null {
  const bootMatch = /\bsec = (\d+), usec = (\d+)\b/u.exec(bootTime);
  const launchMatch =
    /^Launch Time:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3,6}) ([+-])(\d{2})(\d{2})$/mu.exec(
      processStartedAt,
    );
  if (bootMatch && launchMatch) {
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
        Math.floor(fractionMicros / 1_000),
      ) - offsetMs;
    if (Number.isSafeInteger(utcMilliseconds) && utcMilliseconds > 0) {
      const startedAtMicros = BigInt(utcMilliseconds) * 1_000n + BigInt(fractionMicros % 1_000);
      return `darwin:${bootMatch[1]}.${bootMatch[2]}:us:${startedAtMicros}`;
    }
  }
  const normalizedStartedAt = processStartedAt.trim().replace(/\s+/gu, " ");
  if (!bootMatch || normalizedStartedAt.length === 0 || normalizedStartedAt.length > 64) {
    return null;
  }
  return `darwin:${bootMatch[1]}.${bootMatch[2]}:${normalizedStartedAt}`;
}

export function darwinProcessIdentityEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...environment, LC_ALL: "C", TZ: "UTC" };
}

const getProcessIdentity: GetProcessIdentity = (pid) => {
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
      env: darwinProcessIdentityEnvironment(process.env),
      maxBuffer: 512 * 1024,
      timeout: 1_000,
    };
    const bootTime = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], options);
    if (bootTime.status !== 0) {
      return null;
    }
    const startedAt = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], options);
    return startedAt.status === 0
      ? processIdentityFromDarwin(startedAt.stdout, bootTime.stdout)
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
    { encoding: "utf8", timeout: 1_000, windowsHide: true },
  );
  const ticks = result.status === 0 ? result.stdout.trim() : "";
  return /^\d+$/u.test(ticks) ? `windows:${ticks}` : null;
};

const getProcessIdentityV2: GetProcessIdentity = (pid) => {
  if (process.platform !== "darwin") {
    return null;
  }
  const options = {
    encoding: "utf8" as const,
    env: darwinProcessIdentityEnvironment(process.env),
    maxBuffer: 512 * 1024,
    timeout: 3_000,
  };
  const bootTime = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], options);
  const processDetails = spawnSync("/usr/bin/vmmap", ["-summary", String(pid)], options);
  if (bootTime.status !== 0 || processDetails.status !== 0) {
    return null;
  }
  const identity = processIdentityFromDarwin(processDetails.stdout, bootTime.stdout);
  return identity?.includes(":us:") ? identity : null;
};

let cachedCurrentProcessIdentity: string | null = null;
let cachedCurrentProcessIdentityV2: string | null = null;

function getCachedCurrentProcessIdentity(): string | null {
  return (cachedCurrentProcessIdentity ??= getProcessIdentity(process.pid));
}

function getCachedCurrentProcessIdentityV2(): string | null {
  return (cachedCurrentProcessIdentityV2 ??= getProcessIdentityV2(process.pid));
}

function hasExactProcessIdentity(owner: SmokeLockOwner): owner is (
  | ProcessIdentifiedSmokeLockOwner
  | RenewableSmokeLockOwner
) & {
  processIdentity: string;
} {
  return hasProcessIdentity(owner) && typeof owner.processIdentity === "string";
}

function hasCoarseDarwinProcessIdentity(owner: SmokeLockOwner): owner is (
  | ProcessIdentifiedSmokeLockOwner
  | RenewableSmokeLockOwner
) & {
  processIdentity: string;
} {
  if (!hasExactProcessIdentity(owner)) {
    return false;
  }
  return /^darwin:\d+\.\d+:(?!us:).+$/u.test(owner.processIdentity);
}

type ProcessIdentityMatch = "legacy" | "mismatch" | "unknown" | "v2";

function compareProcessIdentity(
  owner: SmokeLockOwner,
  runtime: SmokeLockRuntime,
): ProcessIdentityMatch {
  if (
    hasProcessIdentity(owner) &&
    owner.pid === runtime.currentPid &&
    owner.processStartedAtMs !== runtime.currentProcessStartedAtMs
  ) {
    return "mismatch";
  }
  if (!hasExactProcessIdentity(owner)) {
    return "unknown";
  }
  if (hasProcessIdentity(owner) && typeof owner.processIdentityV2 === "string") {
    const actualProcessIdentityV2 =
      owner.pid === runtime.currentPid
        ? runtime.currentProcessIdentityV2
        : runtime.getProcessIdentityV2(owner.pid);
    if (actualProcessIdentityV2 !== null) {
      return owner.processIdentityV2 === actualProcessIdentityV2 ? "v2" : "mismatch";
    }
  }
  const actualProcessIdentity =
    owner.pid === runtime.currentPid
      ? runtime.currentProcessIdentity
      : runtime.getProcessIdentity(owner.pid);
  if (actualProcessIdentity === null) {
    return "unknown";
  }
  return owner.processIdentity === actualProcessIdentity ? "legacy" : "mismatch";
}

function hasProcessIdentityMismatch(owner: SmokeLockOwner, runtime: SmokeLockRuntime): boolean {
  return compareProcessIdentity(owner, runtime) === "mismatch";
}

function isLockOwnerActive(record: SmokeLockRecord, runtime: SmokeLockRuntime): boolean {
  const { owner } = record;
  if (!runtime.isProcessAlive(owner.pid)) {
    return false;
  }
  const identityMatch = compareProcessIdentity(owner, runtime);
  if (identityMatch === "mismatch") {
    return false;
  }
  if (!isRenewableOwner(owner)) {
    if (
      owner.pid !== runtime.currentPid &&
      hasCoarseDarwinProcessIdentity(owner) &&
      identityMatch !== "v2"
    ) {
      const ageMs = runtime.now() - Math.max(owner.createdAtMs, record.renewedAtMs);
      return ageMs >= -runtime.leaseMs && ageMs <= runtime.leaseMs;
    }
    return true;
  }
  const ageMs = runtime.now() - Math.max(owner.createdAtMs, record.renewedAtMs);
  return ageMs >= -runtime.leaseMs && ageMs <= runtime.leaseMs;
}

function needsLiveOwnerConfirmation(record: SmokeLockRecord, runtime: SmokeLockRuntime): boolean {
  return (
    isRenewableOwner(record.owner) &&
    runtime.isProcessAlive(record.owner.pid) &&
    !hasProcessIdentityMismatch(record.owner, runtime) &&
    !isLockOwnerActive(record, runtime)
  );
}

type OwnerConfirmation = "changed" | "renewed" | "unchanged";

async function confirmObservedOwner(
  lockDirectory: string,
  observed: SmokeLockRecord,
  runtime: SmokeLockRuntime,
): Promise<OwnerConfirmation> {
  if (!needsLiveOwnerConfirmation(observed, runtime)) {
    return "unchanged";
  }
  await runtime.sleep(runtime.leaseMs);
  const revalidated = await readLockRecord(lockDirectory);
  if (revalidated.kind !== "record") {
    return "unchanged";
  }
  if (revalidated.record.owner.token !== observed.owner.token) {
    return "changed";
  }
  return revalidated.record.renewedAtMs !== observed.renewedAtMs ||
    isLockOwnerActive(revalidated.record, runtime)
    ? "renewed"
    : "unchanged";
}

function activeRunError(params: {
  cause?: unknown;
  channel?: CrablineServerChannel;
  outputDir: string;
  requestedChannel: CrablineServerChannel;
}): Error {
  return new Error(
    `OpenClaw Crabline smoke is already running for channel "${params.channel ?? "unknown"}" in "${params.outputDir}"; cannot start channel "${params.requestedChannel}".`,
    params.cause === undefined ? undefined : { cause: params.cause },
  );
}

function isPathConfinedTo(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function resolveConfinedPath(
  rootPath: string,
  candidatePath: string,
  description: string,
  candidateKind: "directory" | "file",
): Promise<string> {
  const resolvedPath = path.resolve(candidatePath);
  if (resolvedPath !== candidatePath) {
    throw new Error(`OpenClaw Crabline smoke lock ${description} escapes its output directory.`);
  }
  const parentPath = candidateKind === "directory" ? resolvedPath : path.dirname(resolvedPath);
  let realParentPath: string;
  try {
    realParentPath = await fs.realpath(parentPath);
  } catch {
    throw new Error(`OpenClaw Crabline smoke lock ${description} is invalid.`);
  }
  if (!isPathConfinedTo(rootPath, realParentPath)) {
    throw new Error(`OpenClaw Crabline smoke lock ${description} escapes its output directory.`);
  }
  return candidateKind === "directory"
    ? realParentPath
    : path.join(realParentPath, path.basename(resolvedPath));
}

async function removeOwnedLock(params: {
  beforeClaim?: () => Promise<void>;
  beforeRename?: () => Promise<void>;
  beforeRemove?: BeforeReleaseRemove;
  lockDirectory: string;
  onOwnedDirectoryChange?: (directoryPath: string) => void;
  ownedDirectory: string;
  removeDirectory?: RemoveLockDirectory;
  runtime?: SmokeLockRuntime;
  token: string;
}): Promise<boolean> {
  await params.beforeClaim?.();
  const observed = await readLockRecord(params.ownedDirectory);
  if (observed.kind === "missing" || observed.record.owner.token !== params.token) {
    return false;
  }
  const observedIdentity = await readDirectoryIdentity(params.ownedDirectory);
  if (observedIdentity === null) {
    return false;
  }
  const revalidated = await readLockRecord(params.ownedDirectory);
  const revalidatedIdentity = await readDirectoryIdentity(params.ownedDirectory);
  if (
    revalidated.kind === "missing" ||
    revalidated.record.owner.token !== params.token ||
    !hasSameDirectoryIdentity(observedIdentity, revalidatedIdentity) ||
    (params.runtime !== undefined && isLockOwnerActive(revalidated.record, params.runtime))
  ) {
    return false;
  }

  await params.beforeRename?.();
  const releaseClaim = `${params.lockDirectory}${RELEASE_CLAIM_SUFFIX}.${params.token}.${randomUUID()}`;
  try {
    await fs.rename(params.ownedDirectory, releaseClaim);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
  params.onOwnedDirectoryChange?.(releaseClaim);

  const claimed = await readLockRecord(releaseClaim);
  const claimedIdentity = await readDirectoryIdentity(releaseClaim);
  if (
    claimed.kind === "missing" ||
    claimed.record.owner.token !== params.token ||
    !hasSameDirectoryIdentity(observedIdentity, claimedIdentity) ||
    (params.runtime !== undefined && isLockOwnerActive(claimed.record, params.runtime))
  ) {
    if (!(await pathExists(params.ownedDirectory))) {
      try {
        await fs.rename(releaseClaim, params.ownedDirectory);
        params.onOwnedDirectoryChange?.(params.ownedDirectory);
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
    return false;
  }

  if (params.removeDirectory) {
    await params.removeDirectory(releaseClaim);
  } else {
    await removeVerifiedLockDirectory({
      ...(params.beforeRemove ? { beforeRemove: params.beforeRemove } : {}),
      directoryPath: releaseClaim,
      expectedIdentity: observedIdentity,
      token: params.token,
    });
  }
  return true;
}

async function renewCompatibilityMarker(params: {
  handle: FileHandle;
  lockDirectory: string;
  renewedAtMs: number;
  securedDirectory: Awaited<ReturnType<typeof securePrivateDirectory>>;
  token: string;
}): Promise<boolean> {
  await params.securedDirectory.assertIdentityAt(params.lockDirectory);
  const observed = await readLockRecord(params.lockDirectory);
  if (observed.kind === "missing" || observed.record.owner.token !== params.token) {
    return false;
  }
  const renewedAt = new Date(params.renewedAtMs);
  await params.handle.utimes(renewedAt, renewedAt);
  await params.handle.sync();
  await params.securedDirectory.assertIdentityAt(params.lockDirectory);
  const revalidated = await readLockRecord(params.lockDirectory);
  return revalidated.kind === "record" && revalidated.record.owner.token === params.token;
}

async function assertCompatibilityMarkerOwned(params: {
  lockDirectory: string;
  securedDirectory: Awaited<ReturnType<typeof securePrivateDirectory>>;
  token: string;
}): Promise<void> {
  await params.securedDirectory.assertIdentityAt(params.lockDirectory);
  const observed = await readLockRecord(params.lockDirectory);
  if (observed.kind === "missing" || observed.record.owner.token !== params.token) {
    throw new Error("OpenClaw Crabline smoke lock compatibility marker was lost.");
  }
}

async function retireCompatibilityMarker(
  handle: FileHandle,
  owner: RenewableSmokeLockOwner,
): Promise<void> {
  const retiredOwner: RenewableSmokeLockOwner = {
    ...owner,
    createdAtMs: 1,
    pid: MAX_PROCESS_ID,
    ...(owner.processIdentity ? { processIdentity: "retired" } : {}),
    ...(owner.processIdentityV2 ? { processIdentityV2: "retired" } : {}),
    processStartedAtMs: 1,
  };
  const originalBytes = Buffer.byteLength(`${JSON.stringify(owner)}\n`, "utf8");
  const retiredJson = JSON.stringify(retiredOwner);
  const retiredBytes = Buffer.byteLength(retiredJson, "utf8") + 1;
  const targetBytes = Math.max(originalBytes, retiredBytes);
  const paddingBytes = targetBytes - retiredBytes;
  const retiredContents = `${retiredJson}${" ".repeat(paddingBytes)}\n`;
  const written = await handle.write(retiredContents, 0, "utf8");
  if (written.bytesWritten !== targetBytes) {
    throw new Error("OpenClaw Crabline smoke lock compatibility marker retirement was incomplete.");
  }
  const retiredAt = new Date(1);
  await handle.utimes(retiredAt, retiredAt);
  await handle.sync();
}

async function renewOwnedLock(
  lockDirectory: string,
  token: string,
  renewedAtMs: number,
): Promise<boolean> {
  const temporaryLeasePath = path.join(
    lockDirectory,
    `.${leaseFileName(token)}.${randomUUID()}.tmp`,
  );
  try {
    const observed = await readLockRecord(lockDirectory);
    if (
      observed.kind === "missing" ||
      observed.record.owner.token !== token ||
      !isRenewableOwner(observed.record.owner)
    ) {
      return false;
    }
    await fs.writeFile(temporaryLeasePath, `${JSON.stringify({ renewedAtMs, token })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.chmod(temporaryLeasePath, 0o600);
    const renewedAt = new Date(renewedAtMs);
    await fs.utimes(temporaryLeasePath, renewedAt, renewedAt);
    const revalidated = await readLockRecord(lockDirectory);
    if (
      revalidated.kind === "missing" ||
      revalidated.record.owner.token !== token ||
      !isRenewableOwner(revalidated.record.owner)
    ) {
      return false;
    }
    await fs.rename(temporaryLeasePath, path.join(lockDirectory, leaseFileName(token)));
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(temporaryLeasePath, { force: true }).catch(() => undefined);
  }
}

function claimPrefix(lockDirectory: string, suffix: string): string {
  return `${path.basename(lockDirectory)}${suffix}.`;
}

async function listLockClaims(lockDirectory: string): Promise<LockClaim[]> {
  const directory = path.dirname(lockDirectory);
  const prefixes: Array<{ kind: LockClaimKind; prefix: string }> = [
    { kind: "recovering", prefix: claimPrefix(lockDirectory, LEGACY_RECOVERY_SUFFIX) },
    { kind: "commit", prefix: claimPrefix(lockDirectory, COMMIT_CLAIM_SUFFIX) },
    { kind: "owned", prefix: claimPrefix(lockDirectory, OWNED_CLAIM_SUFFIX) },
    { kind: "release", prefix: claimPrefix(lockDirectory, RELEASE_CLAIM_SUFFIX) },
  ];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const claims: LockClaim[] = [];
  for (const entry of entries) {
    const match = prefixes.find(({ prefix }) => entry.name.startsWith(prefix));
    if (!match) {
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error("OpenClaw Crabline smoke lock claim is not a directory.");
    }
    claims.push({
      directoryPath: path.join(directory, entry.name),
      kind: match.kind,
    });
  }
  return claims.sort((left, right) => left.directoryPath.localeCompare(right.directoryPath));
}

async function claimLegacyRecoveryDirectory(
  lockDirectory: string,
  expectedToken?: string,
): Promise<void> {
  const legacyRecoveryDirectory = `${lockDirectory}${LEGACY_RECOVERY_SUFFIX}`;
  if (!(await pathExists(legacyRecoveryDirectory))) {
    return;
  }
  if (expectedToken !== undefined) {
    const observed = await readLockRecord(legacyRecoveryDirectory);
    if (observed.kind === "missing" || observed.record.owner.token !== expectedToken) {
      return;
    }
  }
  try {
    await fs.rename(
      legacyRecoveryDirectory,
      `${lockDirectory}${LEGACY_RECOVERY_SUFFIX}.${randomUUID()}`,
    );
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

async function resolveLockClaim(params: {
  beforeRecoveryDeleteClaim: BeforeRecoveryDeleteClaim;
  claim: LockClaim;
  lockDirectory: string;
  outputDir: string;
  requestedChannel: CrablineServerChannel;
  runtime: SmokeLockRuntime;
}): Promise<void> {
  const observed = await readLockRecord(params.claim.directoryPath);
  if (observed.kind === "missing") {
    const discardDirectory = `${params.lockDirectory}.discard.${randomUUID()}`;
    try {
      await fs.rename(params.claim.directoryPath, discardDirectory);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    const claimed = await readLockRecord(discardDirectory);
    if (claimed.kind === "record") {
      await fs.rename(discardDirectory, params.claim.directoryPath);
      await resolveLockClaim(params);
      return;
    }
    await fs.rm(discardDirectory, { force: true, recursive: true });
    return;
  }
  if (isLockOwnerActive(observed.record, params.runtime)) {
    if (params.claim.kind === "recovering") {
      try {
        await fs.rename(params.claim.directoryPath, params.lockDirectory);
      } catch (error) {
        if (!(await pathExists(params.lockDirectory))) {
          throw error;
        }
      }
    }
    throw activeRunError({
      channel: observed.record.owner.channel,
      outputDir: params.outputDir,
      requestedChannel: params.requestedChannel,
    });
  }
  const confirmation = await confirmObservedOwner(
    params.claim.directoryPath,
    observed.record,
    params.runtime,
  );
  if (confirmation === "renewed") {
    if (params.claim.kind === "recovering") {
      try {
        await fs.rename(params.claim.directoryPath, params.lockDirectory);
      } catch (error) {
        if (!(await pathExists(params.lockDirectory))) {
          throw error;
        }
      }
    }
    throw activeRunError({
      channel: observed.record.owner.channel,
      outputDir: params.outputDir,
      requestedChannel: params.requestedChannel,
    });
  }
  if (confirmation === "changed") {
    await resolveLockClaim(params);
    return;
  }

  const revalidated = await readLockRecord(params.claim.directoryPath);
  if (revalidated.kind === "missing") {
    await resolveLockClaim(params);
    return;
  }
  if (
    revalidated.record.owner.token !== observed.record.owner.token ||
    isLockOwnerActive(revalidated.record, params.runtime)
  ) {
    await resolveLockClaim(params);
    return;
  }
  if (
    !(await removeOwnedLock({
      beforeClaim: params.beforeRecoveryDeleteClaim,
      lockDirectory: params.lockDirectory,
      ownedDirectory: params.claim.directoryPath,
      runtime: params.runtime,
      token: revalidated.record.owner.token,
    }))
  ) {
    await resolveLockClaim(params);
  }
}

async function resolveLockClaims(params: {
  beforeRecoveryDeleteClaim: BeforeRecoveryDeleteClaim;
  lockDirectory: string;
  outputDir: string;
  requestedChannel: CrablineServerChannel;
  runtime: SmokeLockRuntime;
}): Promise<void> {
  await claimLegacyRecoveryDirectory(params.lockDirectory);
  for (const claim of await listLockClaims(params.lockDirectory)) {
    await resolveLockClaim({
      ...params,
      claim,
    });
  }
}

async function resolveLockContention(params: {
  beforeRecoveryDeleteClaim: BeforeRecoveryDeleteClaim;
  cause: unknown;
  lockDirectory: string;
  outputDir: string;
  requestedChannel: CrablineServerChannel;
  runtime: SmokeLockRuntime;
  beforeRecoveryClaim: BeforeRecoveryClaim;
}): Promise<void> {
  const observed = await readLockRecord(params.lockDirectory);
  if (observed.kind === "record" && isLockOwnerActive(observed.record, params.runtime)) {
    throw activeRunError({
      cause: params.cause,
      channel: observed.record.owner.channel,
      outputDir: params.outputDir,
      requestedChannel: params.requestedChannel,
    });
  }
  if (observed.kind === "record") {
    const confirmation = await confirmObservedOwner(
      params.lockDirectory,
      observed.record,
      params.runtime,
    );
    if (confirmation === "renewed") {
      throw activeRunError({
        channel: observed.record.owner.channel,
        outputDir: params.outputDir,
        requestedChannel: params.requestedChannel,
      });
    }
    if (confirmation === "changed") {
      await resolveLockContention(params);
      return;
    }
  }

  await params.beforeRecoveryClaim();
  const claimDirectory = `${params.lockDirectory}${LEGACY_RECOVERY_SUFFIX}.${randomUUID()}`;
  try {
    await fs.rename(params.lockDirectory, claimDirectory);
  } catch (error) {
    if (!(await pathExists(params.lockDirectory))) {
      await resolveLockClaims(params);
      return;
    }
    throw error;
  }

  await resolveLockClaim({
    ...params,
    claim: {
      directoryPath: claimDirectory,
      kind: "recovering",
    },
  });
}

async function createLockCandidate(params: {
  afterOwnerWrite?: AfterLockDirectoryWrite;
  candidateDirectory?: string;
  includeLease?: boolean;
  lockDirectory: string;
  owner: RenewableSmokeLockOwner;
  platform?: NodeJS.Platform;
  secureWindowsDirectory?: SecureWindowsDirectory;
}): Promise<{
  candidateDirectory: string;
  securedDirectory: Awaited<ReturnType<typeof securePrivateDirectory>>;
}> {
  const candidateDirectory =
    params.candidateDirectory ??
    `${params.lockDirectory}.${params.owner.pid}.${params.owner.token}.tmp`;
  await fs.mkdir(candidateDirectory, { mode: 0o700 });
  try {
    const securedDirectory = await securePrivateDirectory(candidateDirectory, {
      ...(params.platform ? { platform: params.platform } : {}),
      ...(params.secureWindowsDirectory
        ? { secureWindowsDirectory: params.secureWindowsDirectory }
        : {}),
    });
    await securedDirectory.assertIdentityAt();
    const ownerPath = path.join(candidateDirectory, LOCK_OWNER_FILE);
    await fs.writeFile(ownerPath, `${JSON.stringify(params.owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.chmod(ownerPath, 0o600);
    const createdAt = new Date(params.owner.createdAtMs);
    await fs.utimes(ownerPath, createdAt, createdAt);
    await params.afterOwnerWrite?.(candidateDirectory);
    await securedDirectory.assertIdentityAt();

    if (params.includeLease !== false) {
      const leasePath = path.join(candidateDirectory, leaseFileName(params.owner.token));
      await fs.writeFile(
        leasePath,
        `${JSON.stringify({ renewedAtMs: params.owner.createdAtMs, token: params.owner.token })}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
      await fs.chmod(leasePath, 0o600);
      await fs.utimes(leasePath, createdAt, createdAt);
    }
    await securedDirectory.assertIdentityAt();
    return { candidateDirectory, securedDirectory };
  } catch (error) {
    await fs.rm(candidateDirectory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function acquireOpenClawCrablineSmokeRunLock(
  params: {
    channel: CrablineServerChannel;
    outputDir: string;
  },
  dependencies: {
    afterLockCandidateInstall?: AfterLockDirectoryWrite;
    afterLockOwnerClaimInstall?: AfterLockDirectoryWrite;
    afterLockOwnerWrite?: AfterLockDirectoryWrite;
    getProcessIdentity?: GetProcessIdentity;
    getProcessIdentityV2?: GetProcessIdentity;
    isProcessAlive?: IsProcessAlive;
    leaseMs?: number;
    now?: () => number;
    pid?: number;
    processIdentity?: string | null;
    processIdentityV2?: string | null;
    processStartedAtMs?: number;
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: SecureWindowsDirectory;
    beforeCommitClaim?: BeforeCommitClaim;
    beforeCommitFileRename?: BeforeCommitFileRename;
    beforeCommitRename?: BeforeCommitRename;
    beforeCompatibilityMarkerRenew?: BeforeCompatibilityMarkerRenew;
    beforeRecoveryDeleteClaim?: BeforeRecoveryDeleteClaim;
    beforeRecoveryClaim?: BeforeRecoveryClaim;
    beforeReleaseClaim?: BeforeReleaseClaim;
    beforeReleaseRename?: BeforeReleaseRename;
    beforeReleaseRemove?: BeforeReleaseRemove;
    removeDirectory?: RemoveLockDirectory;
    sleep?: Sleep;
    startHeartbeat?: StartHeartbeat;
  } = {},
): Promise<OpenClawCrablineSmokeRunLock> {
  const requestedOutputDir = path.resolve(params.outputDir);
  await fs.mkdir(requestedOutputDir, { recursive: true });
  const outputDir = await fs.realpath(requestedOutputDir);
  const privateDirectoryOptions = {
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.secureWindowsDirectory
      ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
      : {}),
  };
  const securedOutputDirectory = await securePrivateDirectory(outputDir, privateDirectoryOptions);
  await securedOutputDirectory.assertIdentityAt(outputDir);
  const outputDirectoryIdentity = await readDirectoryIdentity(outputDir);
  if (outputDirectoryIdentity === null) {
    throw new Error("OpenClaw Crabline smoke lock output directory is invalid.");
  }
  const lockDirectory = path.join(outputDir, `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`);
  const token = randomUUID();
  const currentPid = dependencies.pid ?? process.pid;
  const getRuntimeProcessIdentity =
    dependencies.getProcessIdentity ??
    ((pid) => (pid === process.pid ? getCachedCurrentProcessIdentity() : getProcessIdentity(pid)));
  const getRuntimeProcessIdentityV2 =
    dependencies.getProcessIdentityV2 ??
    ((pid) =>
      pid === process.pid ? getCachedCurrentProcessIdentityV2() : getProcessIdentityV2(pid));
  const runtime: SmokeLockRuntime = {
    currentPid,
    currentProcessIdentity:
      dependencies.processIdentity === undefined
        ? getRuntimeProcessIdentity(currentPid)
        : dependencies.processIdentity,
    currentProcessIdentityV2:
      dependencies.processIdentityV2 === undefined
        ? getRuntimeProcessIdentityV2(currentPid)
        : dependencies.processIdentityV2,
    currentProcessStartedAtMs: dependencies.processStartedAtMs ?? CURRENT_PROCESS_STARTED_AT_MS,
    getProcessIdentity: getRuntimeProcessIdentity,
    getProcessIdentityV2: getRuntimeProcessIdentityV2,
    isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
    leaseMs: dependencies.leaseMs ?? LOCK_LEASE_MS,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? sleep,
  };
  const createdAtMs = runtime.now();
  if (
    !isValidProcessId(runtime.currentPid) ||
    (runtime.currentProcessIdentity !== null &&
      (runtime.currentProcessIdentity.length === 0 ||
        runtime.currentProcessIdentity.length > 256)) ||
    (runtime.currentProcessIdentityV2 !== null &&
      (runtime.currentProcessIdentityV2.length === 0 ||
        runtime.currentProcessIdentityV2.length > 256)) ||
    !isPositiveSafeInteger(runtime.currentProcessStartedAtMs) ||
    !isPositiveSafeInteger(runtime.leaseMs) ||
    !isPositiveSafeInteger(createdAtMs)
  ) {
    throw new Error("Invalid OpenClaw Crabline smoke lock runtime.");
  }
  const owner: RenewableSmokeLockOwner = {
    channel: params.channel,
    createdAtMs,
    leaseVersion: 1,
    pid: runtime.currentPid,
    ...(runtime.currentProcessIdentity ? { processIdentity: runtime.currentProcessIdentity } : {}),
    ...(runtime.currentProcessIdentityV2
      ? { processIdentityV2: runtime.currentProcessIdentityV2 }
      : {}),
    processStartedAtMs: runtime.currentProcessStartedAtMs,
    token,
  };
  const compatibilityOwner: RenewableSmokeLockOwner = {
    ...owner,
    createdAtMs: 1,
  };

  for (;;) {
    const lockClaims = await listLockClaims(lockDirectory);
    if (lockClaims.length > 0 || (await pathExists(`${lockDirectory}${LEGACY_RECOVERY_SUFFIX}`))) {
      await resolveLockClaims({
        beforeRecoveryDeleteClaim:
          dependencies.beforeRecoveryDeleteClaim ?? (async () => undefined),
        lockDirectory,
        outputDir: requestedOutputDir,
        requestedChannel: params.channel,
        runtime,
      });
      continue;
    }

    const ownerDirectory = `${lockDirectory}${OWNED_CLAIM_SUFFIX}.${token}`;
    const { candidateDirectory, securedDirectory } = await createLockCandidate({
      ...(dependencies.afterLockOwnerWrite
        ? { afterOwnerWrite: dependencies.afterLockOwnerWrite }
        : {}),
      includeLease: false,
      lockDirectory,
      owner: compatibilityOwner,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.secureWindowsDirectory
        ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
        : {}),
    });
    let ownerCandidate: Awaited<ReturnType<typeof createLockCandidate>>;
    try {
      ownerCandidate = await createLockCandidate({
        candidateDirectory: `${lockDirectory}.${runtime.currentPid}.${token}.owned.tmp`,
        lockDirectory: ownerDirectory,
        owner,
        ...(dependencies.platform ? { platform: dependencies.platform } : {}),
        ...(dependencies.secureWindowsDirectory
          ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
          : {}),
      });
    } catch (error) {
      await fs.rm(candidateDirectory, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
    let compatibilityMarkerHandle: FileHandle | undefined;
    try {
      compatibilityMarkerHandle = await fs.open(
        path.join(candidateDirectory, LOCK_OWNER_FILE),
        "r+",
      );
      const compatibilityRecord = await readLockRecordFromHandle(compatibilityMarkerHandle);
      if (compatibilityRecord.owner.token !== token) {
        throw new Error("OpenClaw Crabline smoke lock compatibility marker was replaced.");
      }
      const activeAt = new Date(createdAtMs);
      await compatibilityMarkerHandle.utimes(activeAt, activeAt);
      await compatibilityMarkerHandle.sync();
    } catch (error) {
      await compatibilityMarkerHandle?.close().catch(() => undefined);
      await fs.rm(candidateDirectory, { force: true, recursive: true }).catch(() => undefined);
      await fs
        .rm(ownerCandidate.candidateDirectory, { force: true, recursive: true })
        .catch(() => undefined);
      throw error;
    }
    if (!compatibilityMarkerHandle) {
      throw new Error("OpenClaw Crabline smoke lock compatibility marker was not opened.");
    }
    const markerHandle = compatibilityMarkerHandle;
    try {
      await fs.rename(candidateDirectory, lockDirectory);
    } catch (error) {
      await markerHandle.close().catch(() => undefined);
      await fs.rm(candidateDirectory, { force: true, recursive: true }).catch(() => undefined);
      await fs
        .rm(ownerCandidate.candidateDirectory, { force: true, recursive: true })
        .catch(() => undefined);
      await resolveLockContention({
        beforeRecoveryDeleteClaim:
          dependencies.beforeRecoveryDeleteClaim ?? (async () => undefined),
        cause: error,
        lockDirectory,
        outputDir: requestedOutputDir,
        requestedChannel: params.channel,
        runtime,
        beforeRecoveryClaim: dependencies.beforeRecoveryClaim ?? (async () => undefined),
      });
      continue;
    }
    let ownerInstalled = false;
    try {
      await dependencies.afterLockCandidateInstall?.(lockDirectory);
      await securedDirectory.assertIdentityAt(lockDirectory);
      const installed = await readLockRecord(lockDirectory);
      if (installed.kind !== "record" || installed.record.owner.token !== token) {
        await retireCompatibilityMarker(markerHandle, compatibilityOwner);
        await markerHandle.close();
        await fs.rm(ownerCandidate.candidateDirectory, { force: true, recursive: true });
        continue;
      }
      await fs.rename(ownerCandidate.candidateDirectory, ownerDirectory);
      ownerInstalled = true;
      await dependencies.afterLockOwnerClaimInstall?.(ownerDirectory);
      await ownerCandidate.securedDirectory.assertIdentityAt(ownerDirectory);
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (ownerInstalled) {
          await removeOwnedLock({
            lockDirectory,
            ownedDirectory: ownerDirectory,
            token,
          });
        } else {
          await fs.rm(ownerCandidate.candidateDirectory, { force: true, recursive: true });
        }
        await retireCompatibilityMarker(markerHandle, compatibilityOwner);
      } catch (caughtCleanupError) {
        cleanupError = caughtCleanupError;
      }
      try {
        await markerHandle.close();
      } catch (closeError) {
        cleanupError =
          cleanupError === undefined
            ? closeError
            : new AggregateError(
                [cleanupError, closeError],
                "OpenClaw Crabline smoke lock setup cleanup also failed.",
              );
      }
      if (cleanupError !== undefined) {
        const aggregateError = new AggregateError(
          [error, cleanupError],
          "OpenClaw Crabline smoke lock setup and cleanup failed.",
        );
        aggregateError.cause = error;
        throw aggregateError;
      }
      throw error;
    }

    const competingClaims = (await listLockClaims(lockDirectory)).filter(
      (claim) => claim.directoryPath !== ownerDirectory,
    );
    if (
      competingClaims.length > 0 ||
      (await pathExists(`${lockDirectory}${LEGACY_RECOVERY_SUFFIX}`))
    ) {
      const removed = await removeOwnedLock({
        lockDirectory,
        ownedDirectory: ownerDirectory,
        token,
      });
      if (!removed) {
        await markerHandle.close();
        throw new Error("OpenClaw Crabline smoke lock ownership was lost.");
      }
      try {
        await retireCompatibilityMarker(markerHandle, compatibilityOwner);
      } finally {
        await markerHandle.close();
      }
      await resolveLockClaims({
        beforeRecoveryDeleteClaim:
          dependencies.beforeRecoveryDeleteClaim ?? (async () => undefined),
        lockDirectory,
        outputDir: requestedOutputDir,
        requestedChannel: params.channel,
        runtime,
      });
      continue;
    }

    let ownedDirectory = ownerDirectory;
    let clockRegressed = false;
    let lastObservedNowMs = createdAtMs;
    let lastRenewedAtMs = createdAtMs;
    let pendingRenewal = Promise.resolve();
    let commitFenceConsumed = false;
    let markerClosed = false;
    let markerRetired = false;
    let heartbeat: HeartbeatController;
    const retireMarker = async () => {
      if (!markerRetired) {
        await retireCompatibilityMarker(markerHandle, compatibilityOwner);
        markerRetired = true;
      }
      if (!markerClosed) {
        await markerHandle.close();
        markerClosed = true;
      }
    };
    const renew = async () => {
      const renewal = pendingRenewal
        .catch(() => undefined)
        .then(async () => {
          const nowMs = runtime.now();
          if (nowMs < lastObservedNowMs) {
            clockRegressed = true;
          } else if (clockRegressed && nowMs >= lastRenewedAtMs) {
            clockRegressed = false;
          }
          lastObservedNowMs = nowMs;
          const renewedAtMs = clockRegressed ? lastRenewedAtMs + 1 : nowMs;
          if (!Number.isSafeInteger(renewedAtMs)) {
            throw new Error("OpenClaw Crabline smoke lock renewal timestamp overflowed.");
          }
          if (!(await renewOwnedLock(ownedDirectory, token, renewedAtMs))) {
            throw new Error("OpenClaw Crabline smoke lock ownership was lost.");
          }
          await dependencies.beforeCompatibilityMarkerRenew?.();
          if (
            !(await renewCompatibilityMarker({
              handle: markerHandle,
              lockDirectory,
              renewedAtMs,
              securedDirectory,
              token,
            }))
          ) {
            throw new Error("OpenClaw Crabline smoke lock compatibility marker was lost.");
          }
          lastRenewedAtMs = renewedAtMs;
        });
      pendingRenewal = renewal;
      await renewal;
    };
    try {
      heartbeat = (dependencies.startHeartbeat ?? startHeartbeat)(
        renew,
        Math.max(1, Math.floor(runtime.leaseMs / 3)),
      );
    } catch (error) {
      try {
        await removeOwnedLock({
          lockDirectory,
          ownedDirectory: ownerDirectory,
          token,
        });
        await retireMarker();
      } catch (cleanupError) {
        const aggregateError = new AggregateError(
          [error, cleanupError],
          "OpenClaw Crabline smoke lock heartbeat startup and cleanup failed.",
        );
        aggregateError.cause = error;
        throw aggregateError;
      }
      throw error;
    }
    let heartbeatStopped = false;
    let released = false;
    return {
      async assertOwned() {
        if (released || heartbeatStopped) {
          throw new Error("OpenClaw Crabline smoke lock has already been released.");
        }
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();
        await assertCompatibilityMarkerOwned({
          lockDirectory,
          securedDirectory,
          token,
        });
      },
      async commitFileAtomically({ contents, destinationPath, stageDirectory, stageFile }) {
        if (released) {
          throw new Error("OpenClaw Crabline smoke lock has already been released.");
        }
        if (commitFenceConsumed || heartbeatStopped || ownedDirectory !== ownerDirectory) {
          throw new Error("OpenClaw Crabline smoke lock has already committed its fence.");
        }
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();

        const resolvedDestinationPath = await resolveConfinedPath(
          outputDir,
          destinationPath,
          "commit destination",
          "file",
        );
        const destinationDirectory = path.dirname(resolvedDestinationPath);
        const securedDestinationDirectory =
          destinationDirectory === outputDir
            ? securedOutputDirectory
            : await securePrivateDirectory(destinationDirectory, privateDirectoryOptions);
        await securedDestinationDirectory.assertIdentityAt(destinationDirectory);
        const destinationDirectoryIdentity = await readDirectoryIdentity(destinationDirectory);
        if (destinationDirectoryIdentity === null) {
          throw new Error("OpenClaw Crabline smoke lock commit destination is invalid.");
        }
        if (destinationDirectoryIdentity.device !== outputDirectoryIdentity.device) {
          throw new Error(
            "OpenClaw Crabline smoke lock commit destination is on another filesystem.",
          );
        }
        const resolvedStageDirectory = stageDirectory
          ? await resolveConfinedPath(
              outputDir,
              stageDirectory,
              "commit stage directory",
              "directory",
            )
          : ownerDirectory;
        let stageDirectoryIdentity: DirectoryIdentity | null = null;
        if (stageDirectory) {
          try {
            stageDirectoryIdentity = await readDirectoryIdentity(resolvedStageDirectory);
          } catch (error) {
            throw new Error("OpenClaw Crabline smoke lock commit stage directory is invalid.", {
              cause: error,
            });
          }
        }
        if (stageDirectory && stageDirectoryIdentity === null) {
          throw new Error("OpenClaw Crabline smoke lock commit stage directory is invalid.");
        }
        if (
          stageDirectoryIdentity !== null &&
          stageDirectoryIdentity.device !== outputDirectoryIdentity.device
        ) {
          throw new Error(
            "OpenClaw Crabline smoke lock commit stage directory is on another filesystem.",
          );
        }
        const stagedFileName = `.commit-file.${token}.${randomUUID()}.tmp`;
        const stagedFilePath = path.join(ownerDirectory, stagedFileName);
        await stageFile(stagedFilePath, contents);
        if (stageDirectory) {
          if (
            !hasSameDirectoryIdentity(
              stageDirectoryIdentity,
              await readDirectoryIdentity(resolvedStageDirectory),
            )
          ) {
            throw new Error(
              "OpenClaw Crabline smoke lock commit stage directory identity changed.",
            );
          }
        }
        const stagedFileIdentity = await readFileIdentity(stagedFilePath);
        if (stagedFileIdentity === null) {
          throw new Error("OpenClaw Crabline smoke lock commit stage file is invalid.");
        }
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();

        await dependencies.beforeCommitClaim?.();
        await assertCompatibilityMarkerOwned({
          lockDirectory,
          securedDirectory,
          token,
        });
        const commitClaim = `${lockDirectory}${COMMIT_CLAIM_SUFFIX}.${token}.${randomUUID()}`;
        const observedIdentity = await readDirectoryIdentity(ownerDirectory);
        const observed = await readLockRecord(ownerDirectory);
        if (
          observedIdentity === null ||
          observed.kind === "missing" ||
          observed.record.owner.token !== token
        ) {
          throw new Error("OpenClaw Crabline smoke lock ownership was lost.");
        }

        try {
          await fs.rename(ownerDirectory, commitClaim);
        } catch (error) {
          if (isMissingPathError(error)) {
            throw new Error("OpenClaw Crabline smoke lock ownership was lost.", {
              cause: error,
            });
          }
          throw error;
        }
        ownedDirectory = commitClaim;
        commitFenceConsumed = true;

        const claimed = await readLockRecord(commitClaim);
        const claimedIdentity = await readDirectoryIdentity(commitClaim);
        if (
          claimed.kind === "missing" ||
          claimed.record.owner.token !== token ||
          !hasSameDirectoryIdentity(observedIdentity, claimedIdentity)
        ) {
          if (!(await pathExists(ownerDirectory))) {
            try {
              await fs.rename(commitClaim, ownerDirectory);
              ownedDirectory = ownerDirectory;
            } catch (error) {
              if (!isMissingPathError(error)) {
                throw error;
              }
            }
          }
          throw new Error("OpenClaw Crabline smoke lock commit fence was lost.");
        }

        await dependencies.beforeCommitFileRename?.();
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();
        await heartbeat.settle();
        heartbeat.assertHealthy();
        await dependencies.beforeCommitRename?.();
        await assertCompatibilityMarkerOwned({
          lockDirectory,
          securedDirectory,
          token,
        });
        const claimedStagedFilePath = path.join(commitClaim, stagedFileName);
        if (stageDirectory) {
          const currentDirectoryIdentity = await readDirectoryIdentity(resolvedStageDirectory);
          const currentFileIdentity = await readFileIdentity(claimedStagedFilePath);
          if (
            !hasSameDirectoryIdentity(stageDirectoryIdentity, currentDirectoryIdentity) ||
            !hasSameDirectoryIdentity(stagedFileIdentity, currentFileIdentity)
          ) {
            const error = new Error("OpenClaw Crabline smoke lock commit stage identity changed.");
            Object.assign(error, { code: "ENOENT", path: claimedStagedFilePath });
            throw error;
          }
        } else if (
          !hasSameDirectoryIdentity(
            stagedFileIdentity,
            await readFileIdentity(claimedStagedFilePath),
          )
        ) {
          throw new Error("OpenClaw Crabline smoke lock commit stage identity changed.");
        }
        if (
          !hasSameDirectoryIdentity(outputDirectoryIdentity, await readDirectoryIdentity(outputDir))
        ) {
          throw new Error("OpenClaw Crabline smoke lock output directory identity changed.");
        }
        await securedOutputDirectory.assertIdentityAt(outputDir);
        let currentDestinationDirectoryIdentity: DirectoryIdentity | null = null;
        try {
          currentDestinationDirectoryIdentity = await readDirectoryIdentity(destinationDirectory);
        } catch {
          // A replaced directory or symlink is an identity mismatch.
        }
        if (
          !hasSameDirectoryIdentity(
            destinationDirectoryIdentity,
            currentDestinationDirectoryIdentity,
          )
        ) {
          throw new Error(
            "OpenClaw Crabline smoke lock commit destination directory identity changed.",
          );
        }
        await securedDestinationDirectory.assertIdentityAt(destinationDirectory);
        const revalidatedDestinationPath = await resolveConfinedPath(
          outputDir,
          resolvedDestinationPath,
          "commit destination",
          "file",
        );
        if (revalidatedDestinationPath !== resolvedDestinationPath) {
          throw new Error("OpenClaw Crabline smoke lock commit destination path identity changed.");
        }
        // The owner-only output tree and smoke lock serialize supported writers; confinement does
        // not treat another process running as the same OS user as a lower-privilege adversary.
        await fs.rename(claimedStagedFilePath, revalidatedDestinationPath);
      },
      async release() {
        if (released) {
          return;
        }
        if (!heartbeatStopped) {
          heartbeatStopped = true;
          try {
            await heartbeat.stop();
          } finally {
            await pendingRenewal.catch(() => undefined);
          }
        } else {
          await pendingRenewal.catch(() => undefined);
        }
        await removeOwnedLock({
          ...(dependencies.beforeReleaseClaim
            ? { beforeClaim: dependencies.beforeReleaseClaim }
            : {}),
          ...(dependencies.beforeReleaseRename
            ? { beforeRename: dependencies.beforeReleaseRename }
            : {}),
          ...(dependencies.beforeReleaseRemove
            ? { beforeRemove: dependencies.beforeReleaseRemove }
            : {}),
          lockDirectory,
          onOwnedDirectoryChange: (directoryPath) => {
            ownedDirectory = directoryPath;
          },
          ownedDirectory,
          ...(dependencies.removeDirectory
            ? { removeDirectory: dependencies.removeDirectory }
            : {}),
          token,
        });
        await claimLegacyRecoveryDirectory(lockDirectory, token);
        for (const claim of await listLockClaims(lockDirectory)) {
          await removeOwnedLock({
            lockDirectory,
            ownedDirectory: claim.directoryPath,
            ...(dependencies.removeDirectory
              ? { removeDirectory: dependencies.removeDirectory }
              : {}),
            token,
          });
        }
        await retireMarker();
        released = true;
      },
    };
  }
}

export async function releaseOpenClawCrablineSmokeRunLock(
  lock: Pick<OpenClawCrablineSmokeRunLock, "release">,
  dependencies: {
    sleep?: Sleep;
  } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await lock.release();
      return;
    } catch (error) {
      if (attempt === RELEASE_ATTEMPTS) {
        throw error;
      }
      await (dependencies.sleep ?? sleep)(RELEASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
