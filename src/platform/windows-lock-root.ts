import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import type { WindowsDirectorySecuritySnapshot } from "./windows-acl.js";

export type WindowsLockRootIdentity = {
  handleIdentity: string;
  securityDescriptor: string;
};

const MAX_WINDOWS_LOCK_ROOT_RECOVERIES = 1;
const MAX_WINDOWS_LOCK_ROOT_SNAPSHOT_ATTEMPTS = 2;

type WindowsLockRootStats = BigIntStats;

function isTransientPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPrivateWindowsLockRoot(stats: WindowsLockRootStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

async function readStableWindowsLockRootIdentity(options: {
  errorPrefix: string;
  readSecuritySnapshot: () => Promise<WindowsDirectorySecuritySnapshot>;
  root: string;
}): Promise<WindowsLockRootIdentity> {
  for (let attempt = 0; attempt < MAX_WINDOWS_LOCK_ROOT_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let pathStats: WindowsLockRootStats;
    try {
      pathStats = await lstat(options.root, { bigint: true });
    } catch (error) {
      if (isTransientPathError(error)) {
        continue;
      }
      throw error;
    }
    if (!isPrivateWindowsLockRoot(pathStats)) {
      throw new Error(`${options.errorPrefix} is not a private directory.`);
    }
    try {
      const securitySnapshot = await options.readSecuritySnapshot();
      if (securitySnapshot.pathIdentity !== securitySnapshot.identity) {
        throw new Error(`${options.errorPrefix} path identity does not match its secure handle.`);
      }
      return {
        handleIdentity: securitySnapshot.identity,
        securityDescriptor: securitySnapshot.securityDescriptor,
      };
    } catch (error) {
      if (isTransientPathError(error)) {
        continue;
      }
      throw error;
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
