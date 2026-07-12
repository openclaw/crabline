import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isCrablineServerChannel, type CrablineServerChannel } from "../servers/index.js";
import { securePrivateDirectory } from "./private-file.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "./shared.js";

type LegacySmokeLockOwner = {
  channel: CrablineServerChannel;
  pid: number;
  token: string;
};

type ProcessIdentifiedSmokeLockOwner = LegacySmokeLockOwner & {
  createdAtMs: number;
  processIdentity?: string;
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
type BeforeReleaseClaim = () => Promise<void>;
type BeforeCommitClaim = () => Promise<void>;
type BeforeCommitFileRename = () => Promise<void>;
type BeforeCommitRename = () => Promise<void>;
type SecureWindowsDirectory = (directoryPath: string) => Promise<void>;
type AfterLockDirectoryWrite = (directoryPath: string) => Promise<void>;
type LockClaimKind = "commit" | "recovering" | "release";
type LockClaim = {
  directoryPath: string;
  kind: LockClaimKind;
};
type DirectoryIdentity = {
  device: bigint;
  inode: bigint;
};

type SmokeLockRuntime = {
  currentProcessIdentity: string | null;
  currentPid: number;
  currentProcessStartedAtMs: number;
  getProcessIdentity: GetProcessIdentity;
  isProcessAlive: IsProcessAlive;
  leaseMs: number;
  now: () => number;
  sleep: Sleep;
};

const LOCK_OWNER_FILE = "owner.json";
const LOCK_COMMIT_STAGE_FILE_PREFIX = "commit-stage";
const LOCK_LEASE_FILE_PREFIX = "lease.";
const LEGACY_RECOVERY_SUFFIX = ".recovering";
const COMMIT_CLAIM_SUFFIX = ".commit";
const RELEASE_CLAIM_SUFFIX = ".release";
const LOCK_LEASE_MS = 10 * 60 * 1000;
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 10;
const CURRENT_PROCESS_STARTED_AT_MS = Math.trunc(Date.now() - process.uptime() * 1000);

function parseCommitStagePath(contents: string, token: string): string {
  let value: { path?: unknown; token?: unknown };
  try {
    value = JSON.parse(contents) as { path?: unknown; token?: unknown };
  } catch (error) {
    throw new Error("OpenClaw Crabline smoke lock commit stage metadata is malformed.", {
      cause: error,
    });
  }
  const expectedPrefix = `.commit-file.${token}.`;
  if (
    value.token !== token ||
    typeof value.path !== "string" ||
    !path.isAbsolute(value.path) ||
    !path.basename(value.path).startsWith(expectedPrefix) ||
    !path.basename(value.path).endsWith(".tmp")
  ) {
    throw new Error("OpenClaw Crabline smoke lock commit stage metadata is malformed.");
  }
  return value.path;
}

async function readCommitStagePath(lockDirectory: string, token: string): Promise<string | null> {
  try {
    return parseCommitStagePath(
      await fs.readFile(path.join(lockDirectory, commitStageFileName(token)), "utf8"),
      token,
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function commitStageFileName(token: string): string {
  return `${LOCK_COMMIT_STAGE_FILE_PREFIX}.${token}.json`;
}

async function writeCommitStagePath(
  lockDirectory: string,
  stagedFilePath: string,
  token: string,
): Promise<void> {
  const temporaryPath = path.join(
    lockDirectory,
    `.${commitStageFileName(token)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify({ path: stagedFilePath, token })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, path.join(lockDirectory, commitStageFileName(token)));
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

const removeLockDirectory: RemoveLockDirectory = async (lockDirectory) => {
  await fs.rm(lockDirectory, { force: true, recursive: true });
};

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

function hasSameDirectoryIdentity(
  left: DirectoryIdentity | null,
  right: DirectoryIdentity | null,
): boolean {
  return (
    left !== null && right !== null && left.device === right.device && left.inode === right.inode
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

const LOCK_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function parseLockOwner(contents: string): SmokeLockOwner {
  let owner: Partial<RenewableSmokeLockOwner>;
  try {
    owner = JSON.parse(contents) as Partial<RenewableSmokeLockOwner>;
  } catch (error) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.", {
      cause: error,
    });
  }
  if (
    typeof owner.channel !== "string" ||
    !isCrablineServerChannel(owner.channel) ||
    !isPositiveSafeInteger(owner.pid) ||
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
        owner.processIdentity.length > 256))
  ) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.");
  }
  if (owner.leaseVersion === undefined) {
    return {
      channel: owner.channel,
      createdAtMs: owner.createdAtMs,
      pid: owner.pid,
      ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
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

const isProcessAlive: IsProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
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
      timeout: 1_000,
    };
    const startedAt = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], options);
    const bootTime = spawnSync("sysctl", ["-n", "kern.boottime"], options);
    return startedAt.status === 0 && bootTime.status === 0
      ? processIdentityFromDarwin(startedAt.stdout, bootTime.stdout)
      : null;
  }
  if (process.platform !== "win32") {
    return null;
  }
  const result = spawnSync(
    "powershell.exe",
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

function hasExactProcessIdentity(owner: SmokeLockOwner): owner is (
  | ProcessIdentifiedSmokeLockOwner
  | RenewableSmokeLockOwner
) & {
  processIdentity: string;
} {
  return hasProcessIdentity(owner) && typeof owner.processIdentity === "string";
}

function hasProcessIdentityMismatch(owner: SmokeLockOwner, runtime: SmokeLockRuntime): boolean {
  if (!hasExactProcessIdentity(owner)) {
    return (
      hasProcessIdentity(owner) &&
      owner.pid === runtime.currentPid &&
      owner.processStartedAtMs !== runtime.currentProcessStartedAtMs
    );
  }
  const actualProcessIdentity =
    owner.pid === runtime.currentPid
      ? runtime.currentProcessIdentity
      : runtime.getProcessIdentity(owner.pid);
  return actualProcessIdentity === null
    ? owner.pid === runtime.currentPid &&
        owner.processStartedAtMs !== runtime.currentProcessStartedAtMs
    : owner.processIdentity !== actualProcessIdentity;
}

function isLockOwnerActive(record: SmokeLockRecord, runtime: SmokeLockRuntime): boolean {
  const { owner } = record;
  if (!runtime.isProcessAlive(owner.pid)) {
    return false;
  }
  if (hasProcessIdentityMismatch(owner, runtime)) {
    return false;
  }
  if (!isRenewableOwner(owner)) {
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

async function observedOwnerChangedDuringConfirmation(
  lockDirectory: string,
  observed: SmokeLockRecord,
  runtime: SmokeLockRuntime,
): Promise<boolean> {
  if (!needsLiveOwnerConfirmation(observed, runtime)) {
    return false;
  }
  await runtime.sleep(runtime.leaseMs);
  const revalidated = await readLockRecord(lockDirectory);
  return (
    revalidated.kind === "record" &&
    (revalidated.record.owner.token !== observed.owner.token ||
      revalidated.record.renewedAtMs !== observed.renewedAtMs ||
      isLockOwnerActive(revalidated.record, runtime))
  );
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

async function removeOwnedLock(params: {
  beforeClaim?: () => Promise<void>;
  lockDirectory: string;
  onOwnedDirectoryChange?: (directoryPath: string) => void;
  ownedDirectory: string;
  removeDirectory?: RemoveLockDirectory;
  runtime?: SmokeLockRuntime;
  token: string;
}): Promise<boolean> {
  const observed = await readLockRecord(params.ownedDirectory);
  if (observed.kind === "missing" || observed.record.owner.token !== params.token) {
    return false;
  }
  const observedIdentity = await readDirectoryIdentity(params.ownedDirectory);
  if (observedIdentity === null) {
    return false;
  }

  await params.beforeClaim?.();
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

  const stagedFilePath = await readCommitStagePath(releaseClaim, params.token);
  if (stagedFilePath) {
    const revokedStagePath = path.join(
      path.dirname(stagedFilePath),
      `.revoked-commit-file.${params.token}.${randomUUID()}.tmp`,
    );
    try {
      await fs.rename(stagedFilePath, revokedStagePath);
      await fs.rm(revokedStagePath, { force: true });
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }

  await (params.removeDirectory ?? removeLockDirectory)(releaseClaim);
  return true;
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
  if (
    await observedOwnerChangedDuringConfirmation(
      params.claim.directoryPath,
      observed.record,
      params.runtime,
    )
  ) {
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
  if (
    observed.kind === "record" &&
    (await observedOwnerChangedDuringConfirmation(
      params.lockDirectory,
      observed.record,
      params.runtime,
    ))
  ) {
    await resolveLockContention(params);
    return;
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
  lockDirectory: string;
  owner: RenewableSmokeLockOwner;
  platform?: NodeJS.Platform;
  secureWindowsDirectory?: SecureWindowsDirectory;
}): Promise<{
  candidateDirectory: string;
  securedDirectory: Awaited<ReturnType<typeof securePrivateDirectory>>;
}> {
  const candidateDirectory = `${params.lockDirectory}.${params.owner.pid}.${params.owner.token}.tmp`;
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
    afterLockOwnerWrite?: AfterLockDirectoryWrite;
    getProcessIdentity?: GetProcessIdentity;
    isProcessAlive?: IsProcessAlive;
    leaseMs?: number;
    now?: () => number;
    pid?: number;
    processIdentity?: string | null;
    processStartedAtMs?: number;
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: SecureWindowsDirectory;
    beforeCommitClaim?: BeforeCommitClaim;
    beforeCommitFileRename?: BeforeCommitFileRename;
    beforeCommitRename?: BeforeCommitRename;
    beforeRecoveryDeleteClaim?: BeforeRecoveryDeleteClaim;
    beforeRecoveryClaim?: BeforeRecoveryClaim;
    beforeReleaseClaim?: BeforeReleaseClaim;
    removeDirectory?: RemoveLockDirectory;
    sleep?: Sleep;
    startHeartbeat?: StartHeartbeat;
  } = {},
): Promise<OpenClawCrablineSmokeRunLock> {
  const outputDir = path.resolve(params.outputDir);
  const lockDirectory = path.join(outputDir, `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`);
  const token = randomUUID();
  const currentPid = dependencies.pid ?? process.pid;
  const getRuntimeProcessIdentity = dependencies.getProcessIdentity ?? getProcessIdentity;
  const runtime: SmokeLockRuntime = {
    currentPid,
    currentProcessIdentity:
      dependencies.processIdentity === undefined
        ? getRuntimeProcessIdentity(currentPid)
        : dependencies.processIdentity,
    currentProcessStartedAtMs: dependencies.processStartedAtMs ?? CURRENT_PROCESS_STARTED_AT_MS,
    getProcessIdentity: getRuntimeProcessIdentity,
    isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
    leaseMs: dependencies.leaseMs ?? LOCK_LEASE_MS,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? sleep,
  };
  const createdAtMs = runtime.now();
  if (
    !isPositiveSafeInteger(runtime.currentPid) ||
    (runtime.currentProcessIdentity !== null &&
      (runtime.currentProcessIdentity.length === 0 ||
        runtime.currentProcessIdentity.length > 256)) ||
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
    processStartedAtMs: runtime.currentProcessStartedAtMs,
    token,
  };

  await fs.mkdir(outputDir, { recursive: true });
  for (;;) {
    const lockClaims = await listLockClaims(lockDirectory);
    if (lockClaims.length > 0 || (await pathExists(`${lockDirectory}${LEGACY_RECOVERY_SUFFIX}`))) {
      await resolveLockClaims({
        beforeRecoveryDeleteClaim:
          dependencies.beforeRecoveryDeleteClaim ?? (async () => undefined),
        lockDirectory,
        outputDir,
        requestedChannel: params.channel,
        runtime,
      });
      continue;
    }

    const { candidateDirectory, securedDirectory } = await createLockCandidate({
      ...(dependencies.afterLockOwnerWrite
        ? { afterOwnerWrite: dependencies.afterLockOwnerWrite }
        : {}),
      lockDirectory,
      owner,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.secureWindowsDirectory
        ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
        : {}),
    });
    try {
      await fs.rename(candidateDirectory, lockDirectory);
    } catch (error) {
      await fs.rm(candidateDirectory, { force: true, recursive: true }).catch(() => undefined);
      await resolveLockContention({
        beforeRecoveryDeleteClaim:
          dependencies.beforeRecoveryDeleteClaim ?? (async () => undefined),
        cause: error,
        lockDirectory,
        outputDir,
        requestedChannel: params.channel,
        runtime,
        beforeRecoveryClaim: dependencies.beforeRecoveryClaim ?? (async () => undefined),
      });
      continue;
    }
    await dependencies.afterLockCandidateInstall?.(lockDirectory);
    await securedDirectory.assertIdentityAt(lockDirectory);

    if (
      (await listLockClaims(lockDirectory)).length > 0 ||
      (await pathExists(`${lockDirectory}${LEGACY_RECOVERY_SUFFIX}`))
    ) {
      await removeOwnedLock({
        lockDirectory,
        ownedDirectory: lockDirectory,
        token,
      });
      await resolveLockClaims({
        beforeRecoveryDeleteClaim:
          dependencies.beforeRecoveryDeleteClaim ?? (async () => undefined),
        lockDirectory,
        outputDir,
        requestedChannel: params.channel,
        runtime,
      });
      continue;
    }
    const installed = await readLockRecord(lockDirectory);
    if (installed.kind !== "record" || installed.record.owner.token !== token) {
      continue;
    }

    let ownedDirectory = lockDirectory;
    let commitFenceConsumed = false;
    let heartbeat: HeartbeatController;
    const renew = async () => {
      const renewedAtMs = runtime.now();
      if (!(await renewOwnedLock(ownedDirectory, token, renewedAtMs))) {
        throw new Error("OpenClaw Crabline smoke lock ownership was lost.");
      }
    };
    try {
      heartbeat = (dependencies.startHeartbeat ?? startHeartbeat)(
        renew,
        Math.max(1, Math.floor(runtime.leaseMs / 3)),
      );
    } catch (error) {
      await removeOwnedLock({
        lockDirectory,
        ownedDirectory: lockDirectory,
        token,
      });
      throw error;
    }
    let heartbeatStopped = false;
    let released = false;
    return {
      async assertOwned() {
        if (released) {
          throw new Error("OpenClaw Crabline smoke lock has already been released.");
        }
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();
      },
      async commitFileAtomically({ contents, destinationPath, stageDirectory, stageFile }) {
        if (released) {
          throw new Error("OpenClaw Crabline smoke lock has already been released.");
        }
        if (commitFenceConsumed || heartbeatStopped || ownedDirectory !== lockDirectory) {
          throw new Error("OpenClaw Crabline smoke lock has already committed its fence.");
        }
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();

        const stagedFileName = `.commit-file.${token}.${randomUUID()}.tmp`;
        const stagedFilePath = path.join(stageDirectory ?? lockDirectory, stagedFileName);
        let committed = false;
        try {
          await stageFile(stagedFilePath, contents);
          if (stageDirectory) {
            await writeCommitStagePath(lockDirectory, stagedFilePath, token);
          }
          heartbeat.assertHealthy();
          await renew();
          heartbeat.assertHealthy();

          const observedIdentity = await readDirectoryIdentity(lockDirectory);
          const observed = await readLockRecord(lockDirectory);
          if (
            observedIdentity === null ||
            observed.kind === "missing" ||
            observed.record.owner.token !== token
          ) {
            throw new Error("OpenClaw Crabline smoke lock ownership was lost.");
          }

          await dependencies.beforeCommitClaim?.();
          const commitClaim = `${lockDirectory}${COMMIT_CLAIM_SUFFIX}.${token}.${randomUUID()}`;
          try {
            await fs.rename(lockDirectory, commitClaim);
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
            if (!(await pathExists(lockDirectory))) {
              try {
                await fs.rename(commitClaim, lockDirectory);
                ownedDirectory = lockDirectory;
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
          await fs.rename(
            stageDirectory ? stagedFilePath : path.join(commitClaim, stagedFileName),
            destinationPath,
          );
          committed = true;
        } finally {
          if (!committed && stageDirectory) {
            await fs.rm(stagedFilePath, { force: true }).catch(() => undefined);
          }
        }
      },
      async release() {
        if (released) {
          return;
        }
        if (!heartbeatStopped) {
          await heartbeat.stop();
          heartbeatStopped = true;
        }
        await removeOwnedLock({
          ...(dependencies.beforeReleaseClaim
            ? { beforeClaim: dependencies.beforeReleaseClaim }
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
