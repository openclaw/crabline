import { lstat } from "node:fs/promises";

export type WindowsLockRootIdentity = {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
};

const MAX_WINDOWS_LOCK_ROOT_RECOVERIES = 1;

export async function secureCachedWindowsLockRoot(options: {
  cache: Map<string, Promise<WindowsLockRootIdentity>>;
  cacheKey: string;
  createDirectory: () => Promise<void>;
  errorPrefix: string;
  root: string;
}): Promise<string> {
  let recoveryAttempts = 0;
  for (;;) {
    let secured = options.cache.get(options.cacheKey);
    if (!secured) {
      secured = (async () => {
        await options.createDirectory();
        const identity = await lstat(options.root, { bigint: true });
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
          throw new Error(`${options.errorPrefix} is not a private directory.`);
        }
        return {
          birthtimeNs: identity.birthtimeNs,
          ctimeNs: identity.ctimeNs,
          dev: identity.dev,
          ino: identity.ino,
        };
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
    if (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.ctimeNs === expected.ctimeNs &&
      current.birthtimeNs === expected.birthtimeNs
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
