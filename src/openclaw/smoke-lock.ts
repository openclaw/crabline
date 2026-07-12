import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isCrablineServerChannel, type CrablineServerChannel } from "../servers/index.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "./shared.js";

type LegacySmokeLockOwner = {
  channel: CrablineServerChannel;
  pid: number;
  token: string;
};

type ProcessIdentifiedSmokeLockOwner = LegacySmokeLockOwner & {
  createdAtMs: number;
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
  prepareForRelease(): Promise<void>;
  release(): Promise<void>;
};

type HeartbeatController = {
  assertHealthy(): void;
  stop(): Promise<void>;
};
type RemoveLockDirectory = (lockDirectory: string) => Promise<void>;
type Sleep = (delayMs: number) => Promise<void>;
type IsProcessAlive = (pid: number) => boolean;
type StartHeartbeat = (renew: () => Promise<void>, intervalMs: number) => HeartbeatController;

type SmokeLockRuntime = {
  currentPid: number;
  currentProcessStartedAtMs: number;
  isProcessAlive: IsProcessAlive;
  leaseMs: number;
  now: () => number;
};

const LOCK_OWNER_FILE = "owner.json";
const LOCK_LEASE_MS = 10 * 60 * 1000;
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 10;
const CURRENT_PROCESS_STARTED_AT_MS = Math.trunc(Date.now() - process.uptime() * 1000);

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

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

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
    owner.token.length === 0
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
    !isPositiveSafeInteger(owner.processStartedAtMs)
  ) {
    throw new Error("OpenClaw Crabline smoke lock owner metadata is malformed.");
  }
  if (owner.leaseVersion === undefined) {
    return {
      channel: owner.channel,
      createdAtMs: owner.createdAtMs,
      pid: owner.pid,
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
    processStartedAtMs: owner.processStartedAtMs,
    token: owner.token,
  };
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
    return { kind: "record", record: await readLockRecordFromHandle(handle) };
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

function isLockOwnerActive(record: SmokeLockRecord, runtime: SmokeLockRuntime): boolean {
  const { owner } = record;
  if (!runtime.isProcessAlive(owner.pid)) {
    return false;
  }
  if (
    hasProcessIdentity(owner) &&
    owner.pid === runtime.currentPid &&
    owner.processStartedAtMs !== runtime.currentProcessStartedAtMs
  ) {
    return false;
  }
  if (!isRenewableOwner(owner)) {
    return true;
  }
  const ageMs = runtime.now() - Math.max(owner.createdAtMs, record.renewedAtMs);
  return ageMs >= -runtime.leaseMs && ageMs <= runtime.leaseMs;
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

async function removeOwnedLock(
  lockDirectory: string,
  token: string,
  removeDirectory: RemoveLockDirectory = removeLockDirectory,
): Promise<boolean> {
  const result = await readLockRecord(lockDirectory);
  if (result.kind === "missing" || result.record.owner.token !== token) {
    return false;
  }
  await removeDirectory(lockDirectory);
  return true;
}

async function renewOwnedLock(
  lockDirectory: string,
  token: string,
  renewedAtMs: number,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path.join(lockDirectory, LOCK_OWNER_FILE), "r+");
    const record = await readLockRecordFromHandle(handle);
    if (record.owner.token !== token || !isRenewableOwner(record.owner)) {
      return false;
    }
    const renewedAt = new Date(renewedAtMs);
    await handle.utimes(renewedAt, renewedAt);
    await handle.sync();
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function resolveRecoveryDirectory(params: {
  outputDir: string;
  recoveryDirectory: string;
  requestedChannel: CrablineServerChannel;
  runtime: SmokeLockRuntime;
}): Promise<void> {
  const result = await readLockRecord(params.recoveryDirectory);
  if (result.kind === "record" && isLockOwnerActive(result.record, params.runtime)) {
    throw activeRunError({
      channel: result.record.owner.channel,
      outputDir: params.outputDir,
      requestedChannel: params.requestedChannel,
    });
  }
  await fs.rm(params.recoveryDirectory, { force: true, recursive: true });
}

async function resolveLockContention(params: {
  cause: unknown;
  lockDirectory: string;
  outputDir: string;
  recoveryDirectory: string;
  requestedChannel: CrablineServerChannel;
  runtime: SmokeLockRuntime;
}): Promise<void> {
  if (await pathExists(params.recoveryDirectory)) {
    await resolveRecoveryDirectory(params);
    return;
  }

  const observed = await readLockRecord(params.lockDirectory);
  if (observed.kind === "record" && isLockOwnerActive(observed.record, params.runtime)) {
    throw activeRunError({
      cause: params.cause,
      channel: observed.record.owner.channel,
      outputDir: params.outputDir,
      requestedChannel: params.requestedChannel,
    });
  }

  try {
    await fs.rename(params.lockDirectory, params.recoveryDirectory);
  } catch (error) {
    if (
      !(await pathExists(params.lockDirectory)) &&
      !(await pathExists(params.recoveryDirectory))
    ) {
      return;
    }
    if (await pathExists(params.recoveryDirectory)) {
      await resolveRecoveryDirectory(params);
      return;
    }
    throw error;
  }

  await resolveRecoveryDirectory(params);
}

async function createLockCandidate(params: {
  lockDirectory: string;
  owner: RenewableSmokeLockOwner;
}): Promise<string> {
  const candidateDirectory = `${params.lockDirectory}.${params.owner.pid}.${params.owner.token}.tmp`;
  await fs.mkdir(candidateDirectory, { mode: 0o700 });
  try {
    await fs.chmod(candidateDirectory, 0o700);
    const ownerPath = path.join(candidateDirectory, LOCK_OWNER_FILE);
    await fs.writeFile(ownerPath, `${JSON.stringify(params.owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.chmod(ownerPath, 0o600);
    const createdAt = new Date(params.owner.createdAtMs);
    await fs.utimes(ownerPath, createdAt, createdAt);
    return candidateDirectory;
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
    isProcessAlive?: IsProcessAlive;
    leaseMs?: number;
    now?: () => number;
    pid?: number;
    processStartedAtMs?: number;
    removeDirectory?: RemoveLockDirectory;
    startHeartbeat?: StartHeartbeat;
  } = {},
): Promise<OpenClawCrablineSmokeRunLock> {
  const outputDir = path.resolve(params.outputDir);
  const lockDirectory = path.join(outputDir, `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`);
  const recoveryDirectory = `${lockDirectory}.recovering`;
  const token = randomUUID();
  const runtime: SmokeLockRuntime = {
    currentPid: dependencies.pid ?? process.pid,
    currentProcessStartedAtMs: dependencies.processStartedAtMs ?? CURRENT_PROCESS_STARTED_AT_MS,
    isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
    leaseMs: dependencies.leaseMs ?? LOCK_LEASE_MS,
    now: dependencies.now ?? Date.now,
  };
  const createdAtMs = runtime.now();
  if (
    !isPositiveSafeInteger(runtime.currentPid) ||
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
    processStartedAtMs: runtime.currentProcessStartedAtMs,
    token,
  };

  await fs.mkdir(outputDir, { recursive: true });
  for (;;) {
    if (await pathExists(recoveryDirectory)) {
      await resolveRecoveryDirectory({
        outputDir,
        recoveryDirectory,
        requestedChannel: params.channel,
        runtime,
      });
      continue;
    }

    const candidateDirectory = await createLockCandidate({
      lockDirectory,
      owner,
    });
    try {
      await fs.rename(candidateDirectory, lockDirectory);
    } catch (error) {
      await fs.rm(candidateDirectory, { force: true, recursive: true }).catch(() => undefined);
      await resolveLockContention({
        cause: error,
        lockDirectory,
        outputDir,
        recoveryDirectory,
        requestedChannel: params.channel,
        runtime,
      });
      continue;
    }

    if (await pathExists(recoveryDirectory)) {
      await removeOwnedLock(lockDirectory, token);
      continue;
    }
    const installed = await readLockRecord(lockDirectory);
    if (installed.kind !== "record" || installed.record.owner.token !== token) {
      continue;
    }

    let heartbeat: HeartbeatController;
    const renew = async () => {
      const renewedAtMs = runtime.now();
      if (
        !(await renewOwnedLock(lockDirectory, token, renewedAtMs)) &&
        !(await renewOwnedLock(recoveryDirectory, token, renewedAtMs))
      ) {
        throw new Error("OpenClaw Crabline smoke lock ownership was lost.");
      }
    };
    try {
      heartbeat = (dependencies.startHeartbeat ?? startHeartbeat)(
        renew,
        Math.max(1, Math.floor(runtime.leaseMs / 3)),
      );
    } catch (error) {
      await removeOwnedLock(lockDirectory, token);
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
      async prepareForRelease() {
        if (released) {
          throw new Error("OpenClaw Crabline smoke lock has already been released.");
        }
        if (!heartbeatStopped) {
          await heartbeat.stop();
          heartbeatStopped = true;
        }
        heartbeat.assertHealthy();
        await renew();
        heartbeat.assertHealthy();
      },
      async release() {
        if (released) {
          return;
        }
        if (!heartbeatStopped) {
          await heartbeat.stop();
          heartbeatStopped = true;
        }
        await removeOwnedLock(lockDirectory, token, dependencies.removeDirectory);
        await removeOwnedLock(recoveryDirectory, token, dependencies.removeDirectory);
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
