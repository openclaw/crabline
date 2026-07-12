import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isCrablineServerChannel, type CrablineServerChannel } from "../servers/index.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "./shared.js";

type SmokeLockOwner = {
  channel: CrablineServerChannel;
  pid: number;
  token: string;
};

export type OpenClawCrablineSmokeRunLock = {
  release(): Promise<void>;
};

type RemoveLockDirectory = (lockDirectory: string) => Promise<void>;

const LOCK_OWNER_FILE = "owner.json";

const removeLockDirectory: RemoveLockDirectory = async (lockDirectory) => {
  await fs.rm(lockDirectory, { force: true, recursive: true });
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLockOwner(lockDirectory: string): Promise<SmokeLockOwner | undefined> {
  try {
    const owner = JSON.parse(
      await fs.readFile(path.join(lockDirectory, LOCK_OWNER_FILE), "utf8"),
    ) as Partial<SmokeLockOwner>;
    if (
      typeof owner.channel === "string" &&
      isCrablineServerChannel(owner.channel) &&
      typeof owner.pid === "number" &&
      typeof owner.token === "string"
    ) {
      return owner as SmokeLockOwner;
    }
  } catch {
    // A missing or malformed owner is treated as stale.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
}): Promise<void> {
  const owner = await readLockOwner(params.recoveryDirectory);
  if (owner && isProcessAlive(owner.pid)) {
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
}): Promise<void> {
  if (await pathExists(params.recoveryDirectory)) {
    await resolveRecoveryDirectory(params);
    return;
  }

  const observedOwner = await readLockOwner(params.lockDirectory);
  if (observedOwner && isProcessAlive(observedOwner.pid)) {
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
  const candidateDirectory = `${params.lockDirectory}.${process.pid}.${params.owner.token}.tmp`;
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
    removeDirectory?: RemoveLockDirectory;
  } = {},
): Promise<OpenClawCrablineSmokeRunLock> {
  const outputDir = path.resolve(params.outputDir);
  const lockDirectory = path.join(outputDir, `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`);
  const recoveryDirectory = `${lockDirectory}.recovering`;
  const token = randomUUID();
  const owner: SmokeLockOwner = {
    channel: params.channel,
    pid: process.pid,
    token,
  };

  await fs.mkdir(outputDir, { recursive: true });
  for (;;) {
    if (await pathExists(recoveryDirectory)) {
      await resolveRecoveryDirectory({
        outputDir,
        recoveryDirectory,
        requestedChannel: params.channel,
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
