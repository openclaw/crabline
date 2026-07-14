import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import type { WindowsDirectorySecuritySnapshot } from "./windows-acl.js";

export type WindowsLockRootIdentity = {
  birthtimeNs: bigint;
  dev: bigint;
  handleIdentity: string;
  ino: bigint;
  securityDescriptor: string;
};

const MAX_WINDOWS_LOCK_ROOT_RECOVERIES = 1;
const MAX_WINDOWS_LOCK_ROOT_SNAPSHOT_ATTEMPTS = 2;

type WindowsLockRootStats = BigIntStats;

function isTransientPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isSameWindowsLockRoot(
  left: WindowsLockRootStats,
  right: Pick<WindowsLockRootIdentity, "birthtimeNs" | "dev" | "ino">,
): boolean {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function readStableWindowsLockRootIdentity(options: {
  errorPrefix: string;
  readSecuritySnapshot: () => Promise<WindowsDirectorySecuritySnapshot>;
  root: string;
}): Promise<WindowsLockRootIdentity> {
  for (let attempt = 0; attempt < MAX_WINDOWS_LOCK_ROOT_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let before: WindowsLockRootStats;
    try {
      before = await lstat(options.root, { bigint: true });
    } catch (error) {
      if (isTransientPathError(error)) {
        continue;
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`${options.errorPrefix} is not a private directory.`);
    }
    let securitySnapshot: WindowsDirectorySecuritySnapshot;
    try {
      securitySnapshot = await options.readSecuritySnapshot();
    } catch (error) {
      let afterFailure: WindowsLockRootStats;
      try {
        afterFailure = await lstat(options.root, { bigint: true });
      } catch (pathError) {
        if (isTransientPathError(pathError)) {
          continue;
        }
        throw pathError;
      }
      if (!isSameWindowsLockRoot(afterFailure, before)) {
        continue;
      }
      throw error;
    }
    let after: WindowsLockRootStats;
    try {
      after = await lstat(options.root, { bigint: true });
    } catch (error) {
      if (isTransientPathError(error)) {
        continue;
      }
      throw error;
    }
    if (isSameWindowsLockRoot(after, before)) {
      return {
        birthtimeNs: before.birthtimeNs,
        dev: before.dev,
        handleIdentity: securitySnapshot.identity,
        ino: before.ino,
        securityDescriptor: securitySnapshot.securityDescriptor,
      };
    }
  }
  throw new Error(`${options.errorPrefix} could not be stabilized.`);
}

export async function secureCachedWindowsLockRoot(options: {
  cache: Map<string, Promise<WindowsLockRootIdentity>>;
  cacheKey: string;
  createDirectory: () => Promise<void>;
  errorPrefix: string;
  readSecuritySnapshot: () => Promise<WindowsDirectorySecuritySnapshot>;
  root: string;
}): Promise<string> {
  let recoveryAttempts = 0;
  for (;;) {
    let secured = options.cache.get(options.cacheKey);
    if (!secured) {
      secured = (async () => {
        await options.createDirectory();
        return readStableWindowsLockRootIdentity(options);
      })();
      options.cache.set(options.cacheKey, secured);
      void secured.catch(() => {
        if (options.cache.get(options.cacheKey) === secured) {
          options.cache.delete(options.cacheKey);
        }
      });
    }
    let expected: WindowsLockRootIdentity;
    try {
      expected = await secured;
    } catch (error) {
      if (options.cache.get(options.cacheKey) === secured) {
        options.cache.delete(options.cacheKey);
      }
      throw error;
    }
    let current: WindowsLockRootIdentity;
    try {
      current = await readStableWindowsLockRootIdentity(options);
    } catch (error) {
      if (options.cache.get(options.cacheKey) === secured) {
        options.cache.delete(options.cacheKey);
      }
      if (recoveryAttempts >= MAX_WINDOWS_LOCK_ROOT_RECOVERIES) {
        throw error;
      }
      recoveryAttempts += 1;
      continue;
    }
    if (
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.birthtimeNs === expected.birthtimeNs &&
      current.handleIdentity === expected.handleIdentity &&
      current.securityDescriptor === expected.securityDescriptor
    ) {
      return options.root;
    }
    if (options.cache.get(options.cacheKey) === secured) {
      options.cache.delete(options.cacheKey);
    }
    if (recoveryAttempts >= MAX_WINDOWS_LOCK_ROOT_RECOVERIES) {
      throw new Error(`${options.errorPrefix} could not be stabilized.`);
    }
    recoveryAttempts += 1;
  }
}
