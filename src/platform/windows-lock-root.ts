import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";

export type WindowsLockRootIdentity = {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  securityDescriptor: string;
};

const MAX_WINDOWS_LOCK_ROOT_RECOVERIES = 1;
const MAX_WINDOWS_LOCK_ROOT_SNAPSHOT_ATTEMPTS = 2;

type WindowsLockRootStats = BigIntStats;

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
  readSecurityDescriptor: () => Promise<string>;
  root: string;
}): Promise<WindowsLockRootIdentity> {
  for (let attempt = 0; attempt < MAX_WINDOWS_LOCK_ROOT_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await lstat(options.root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`${options.errorPrefix} is not a private directory.`);
    }
    const securityDescriptor = await options.readSecurityDescriptor();
    const after = await lstat(options.root, { bigint: true });
    if (isSameWindowsLockRoot(after, before) && after.ctimeNs === before.ctimeNs) {
      return {
        birthtimeNs: after.birthtimeNs,
        ctimeNs: after.ctimeNs,
        dev: after.dev,
        ino: after.ino,
        securityDescriptor,
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
  readSecurityDescriptor: () => Promise<string>;
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
    const expected = await secured;
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(options.root, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      if (options.cache.get(options.cacheKey) === secured) {
        options.cache.delete(options.cacheKey);
      }
      if (recoveryAttempts >= MAX_WINDOWS_LOCK_ROOT_RECOVERIES) {
        throw new Error(`${options.errorPrefix} could not be stabilized.`, { cause: error });
      }
      recoveryAttempts += 1;
      continue;
    }
    if (isSameWindowsLockRoot(current, expected)) {
      if (current.ctimeNs === expected.ctimeNs) {
        return options.root;
      }
      const refreshed = await readStableWindowsLockRootIdentity(options);
      if (
        isSameWindowsLockRoot(current, refreshed) &&
        refreshed.dev === expected.dev &&
        refreshed.ino === expected.ino &&
        refreshed.birthtimeNs === expected.birthtimeNs &&
        refreshed.securityDescriptor === expected.securityDescriptor
      ) {
        if (options.cache.get(options.cacheKey) === secured) {
          options.cache.set(options.cacheKey, Promise.resolve(refreshed));
        }
        return options.root;
      }
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
