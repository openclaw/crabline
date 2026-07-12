import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isCrablineServerChannel, type CrablineServerChannel } from "../servers/index.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "./shared.js";

type SmokeLockOwner = {
  channel: CrablineServerChannel;
  createdAtMs: number;
  pid: number;
  processStartedAtMs: number;
  token: string;
};

export type OpenClawCrablineSmokeRunLock = {
  release(): Promise<void>;
};

type RemoveLockDirectory = (lockDirectory: string) => Promise<void>;
type Sleep = (delayMs: number) => Promise<void>;
type IsProcessAlive = (pid: number) => boolean;

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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function readLockOwner(lockDirectory: string): Promise<SmokeLockOwner | undefined> {
  try {
    const owner = JSON.parse(
      await fs.readFile(path.join(lockDirectory, LOCK_OWNER_FILE), "utf8"),
    ) as Partial<SmokeLockOwner>;
    if (
      typeof owner.channel === "string" &&
      isCrablineServerChannel(owner.channel) &&
      isPositiveSafeInteger(owner.createdAtMs) &&
      isPositiveSafeInteger(owner.pid) &&
      isPositiveSafeInteger(owner.processStartedAtMs) &&
      typeof owner.token === "string" &&
      owner.token.length > 0
    ) {
      return owner as SmokeLockOwner;
    }
  } catch {
    // A missing or malformed owner is treated as stale.
  }
  return undefined;
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

function isLockOwnerActive(owner: SmokeLockOwner, runtime: SmokeLockRuntime): boolean {
  if (!runtime.isProcessAlive(owner.pid)) {
    return false;
  }
  if (
    owner.pid === runtime.currentPid &&
    owner.processStartedAtMs !== runtime.currentProcessStartedAtMs
  ) {
    return false;
  }
  const ageMs = runtime.now() - owner.createdAtMs;
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
  const owner = await readLockOwner(lockDirectory);
  if (owner?.token !== token) {
    return false;
  }
  await removeDirectory(lockDirectory);
  return true;
}

async function resolveRecoveryDirectory(params: {
  outputDir: string;
  recoveryDirectory: string;
  requestedChannel: CrablineServerChannel;
  runtime: SmokeLockRuntime;
}): Promise<void> {
  const owner = await readLockOwner(params.recoveryDirectory);
  if (owner && isLockOwnerActive(owner, params.runtime)) {
    throw activeRunError({
      channel: owner.channel,
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

  const observedOwner = await readLockOwner(params.lockDirectory);
  if (observedOwner && isLockOwnerActive(observedOwner, params.runtime)) {
    throw activeRunError({
      cause: params.cause,
      channel: observedOwner.channel,
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
  owner: SmokeLockOwner;
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
  const owner: SmokeLockOwner = {
    channel: params.channel,
    createdAtMs,
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
    if ((await readLockOwner(lockDirectory))?.token !== token) {
      continue;
    }

    let released = false;
    return {
      async release() {
        if (released) {
          return;
        }
        await removeOwnedLock(lockDirectory, token, dependencies.removeDirectory);
        await removeOwnedLock(recoveryDirectory, token, dependencies.removeDirectory);
        released = true;
      },
    };
  }
}

export async function releaseOpenClawCrablineSmokeRunLock(
  lock: OpenClawCrablineSmokeRunLock,
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
