import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { lock } from "proper-lockfile";

export type ReadyFileIdentity = {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  size: bigint;
};

const READY_FILE_LEASE_STALE_MS = 60_000;
const READY_FILE_LEASE_UPDATE_MS = 1_000;

async function readReadyFileIdentity(filePath: string): Promise<ReadyFileIdentity> {
  const stats = await fs.stat(filePath, { bigint: true });
  return {
    birthtimeNs: stats.birthtimeNs,
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
  };
}

function sameReadyFileIdentity(left: ReadyFileIdentity, right: ReadyFileIdentity): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

function sameReadyFileObject(left: ReadyFileIdentity, right: ReadyFileIdentity): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

function readyFileRecoveryError(errors: [unknown, ...unknown[]], message: string): AggregateError {
  return new AggregateError(errors, message, { cause: errors[0] });
}

async function withReadyFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireReadyFileLease(filePath);
  let actionFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (actionFailed) {
      throw readyFileRecoveryError(
        [actionError, releaseError],
        `Ready-file action and lock release both failed for "${filePath}".`,
      );
    }
    throw releaseError;
  }
  if (actionFailed) {
    throw actionError;
  }
  return result as T;
}

export async function acquireReadyFileLease(filePath: string): Promise<() => Promise<void>> {
  await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
  return await lock(filePath, {
    realpath: false,
    retries: {
      factor: 1,
      maxTimeout: 10,
      minTimeout: 10,
      retries: 100,
    },
    stale: READY_FILE_LEASE_STALE_MS,
    update: READY_FILE_LEASE_UPDATE_MS,
  });
}

export async function publishReadyFile(
  filePath: string,
  contents: string,
): Promise<ReadyFileIdentity> {
  let publishedIdentity: ReadyFileIdentity | undefined;
  try {
    return await withReadyFileLock(filePath, async () => {
      publishedIdentity = await publishReadyFileUnlocked(filePath, contents);
      return publishedIdentity;
    });
  } catch (error) {
    if (publishedIdentity) {
      try {
        await removeReadyFileIfOwned(filePath, contents, publishedIdentity);
      } catch (cleanupError) {
        throw readyFileRecoveryError(
          [error, cleanupError],
          `Ready-file publication and compensation both failed for "${filePath}".`,
        );
      }
    }
    throw error;
  }
}

export async function publishReadyFileUnlocked(
  filePath: string,
  contents: string,
): Promise<ReadyFileIdentity> {
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = nodePath.join(
    nodePath.dirname(filePath),
    `.${nodePath.basename(filePath)}.${suffix}`,
  );
  const backupPath = `${temporaryPath}.backup`;
  let manifestPublished = false;
  let destinationBackedUp = false;
  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    destinationBackedUp = await backupReadyFile(filePath, backupPath);
    await fs.rename(temporaryPath, filePath);
    manifestPublished = true;
    const identity = await readReadyFileIdentity(filePath);
    if (destinationBackedUp) {
      await fs.rm(backupPath);
      destinationBackedUp = false;
    }
    return identity;
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    if (manifestPublished && !destinationBackedUp) {
      await fs.rm(filePath, { force: true }).catch((cleanupError: unknown) => {
        recoveryErrors.push(cleanupError);
      });
    }
    if (destinationBackedUp) {
      await fs.rename(backupPath, filePath).catch((restoreError: unknown) => {
        recoveryErrors.push(restoreError);
      });
    }
    if (recoveryErrors.length > 0) {
      throw readyFileRecoveryError(
        [error, ...recoveryErrors],
        `Ready-file replacement and recovery both failed for "${filePath}".`,
      );
    }
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function backupReadyFile(filePath: string, backupPath: string): Promise<boolean> {
  try {
    await fs.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function removeReadyFileIfOwned(
  filePath: string,
  expectedContents: string,
  expectedIdentity: ReadyFileIdentity,
): Promise<void> {
  const tombstonePath = nodePath.join(
    nodePath.dirname(filePath),
    `.${nodePath.basename(filePath)}.${process.pid}.${randomUUID()}.remove`,
  );
  try {
    if (
      (await fs.readFile(filePath, "utf8")) !== expectedContents ||
      !sameReadyFileIdentity(await readReadyFileIdentity(filePath), expectedIdentity)
    ) {
      return;
    }
    await fs.rename(filePath, tombstonePath);
    if (
      (await fs.readFile(tombstonePath, "utf8")) === expectedContents &&
      sameReadyFileObject(await readReadyFileIdentity(tombstonePath), expectedIdentity)
    ) {
      await fs.rm(tombstonePath);
      return;
    }
    try {
      await fs.link(tombstonePath, filePath);
      await fs.rm(tombstonePath);
    } catch (restoreError) {
      throw new Error(
        `Ready-file path changed while removing "${filePath}"; the moved file remains at "${tombstonePath}".`,
        { cause: restoreError },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function removeReadyFile(
  filePath: string,
  expectedContents: string,
  expectedIdentity: ReadyFileIdentity,
): Promise<void> {
  await withReadyFileLock(filePath, async () => {
    await removeReadyFileIfOwned(filePath, expectedContents, expectedIdentity);
  });
}
