import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessOwnedLockFileSystem,
  isDeadLinuxProcessState,
} from "../src/platform/process-owned-lock.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createLockTarget(): Promise<string> {
  const directory = await createTempDir();
  directories.push(directory);
  return path.join(directory, "recorder");
}

async function startLockOwner(target: string): Promise<ChildProcessWithoutNullStreams> {
  const moduleUrl = new URL("../src/platform/process-owned-lock.ts", import.meta.url).href;
  const script = `
    import { lock } from "proper-lockfile";
    import { createProcessOwnedLockFileSystem } from ${JSON.stringify(moduleUrl)};
    const release = await lock(process.argv[1], {
      fs: createProcessOwnedLockFileSystem(),
      realpath: false,
      retries: 0,
      stale: 2000,
      update: 1000,
    });
    process.stdout.write("locked\\n");
    process.stdin.once("data", async () => {
      await release();
      process.exit(0);
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, target],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  await expect
    .poll(
      () => {
        if (child.exitCode !== null) {
          throw new Error(`lock owner exited early: ${child.stderr.read()?.toString() ?? ""}`);
        }
        return stdout;
      },
      { timeout: 10_000 },
    )
    .toContain("locked\n");
  return child;
}

async function startIdleProcess(): Promise<{
  child: ChildProcessWithoutNullStreams;
  pid: number;
  processStartedAtMs: number;
}> {
  const script = `
    import { performance } from "node:perf_hooks";
    process.stdout.write(JSON.stringify({
      pid: process.pid,
      processStartedAtMs: Math.trunc(performance.timeOrigin),
    }) + "\\n");
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  await expect.poll(() => stdout, { timeout: 10_000 }).toContain("\n");
  const details = JSON.parse(stdout) as { pid: number; processStartedAtMs: number };
  return { child, ...details };
}

async function writeOwner(
  lockDirectory: string,
  owner: {
    executionIdentity?: string | null;
    pid: number;
    processIdentity?: string | null;
    machineIdentity?: string | null;
    processNamespace?: string | null;
    processStartedAtMs: number;
    version?: 1 | 2 | 3 | 4;
  },
): Promise<string> {
  const ownerPath = path.join(lockDirectory, "crabline-owner.json");
  await writeFile(
    ownerPath,
    `${JSON.stringify({
      ...owner,
      executionIdentity: owner.executionIdentity ?? null,
      machineIdentity: owner.machineIdentity ?? null,
      processIdentity: owner.processIdentity ?? null,
      processNamespace:
        owner.processNamespace !== undefined
          ? owner.processNamespace
          : process.platform === "linux"
            ? fs.readlinkSync("/proc/self/ns/pid")
            : null,
      token: "test-token-placeholder",
      version: owner.version ?? 1,
    })}\n`,
    { mode: 0o600 },
  );
  return ownerPath;
}

function recoveryClaimPath(lockDirectory: string, fingerprint = "coordination"): string {
  const canonicalDirectory = path.join(
    fs.realpathSync.native(path.dirname(lockDirectory)),
    path.basename(lockDirectory),
  );
  const digest = createHash("sha256")
    .update(canonicalDirectory)
    .update("\0")
    .update(fingerprint)
    .digest("hex");
  return path.join(path.dirname(canonicalDirectory), `.crabline-reclaim-${digest}`);
}

function acquire(target: string): Promise<() => Promise<void>> {
  return lock(target, {
    fs: createProcessOwnedLockFileSystem(),
    realpath: false,
    retries: 0,
    stale: 2000,
    update: 1000,
  });
}

function exactIdentityForCurrentPlatform(value: number): string {
  if (process.platform === "linux") {
    return `linux:00000000-0000-0000-0000-000000000000:${value}`;
  }
  if (process.platform === "darwin") {
    return `darwin:1.1:us:${value}`;
  }
  return `windows:${value}`;
}

describe("process-owned lock filesystem", () => {
  it("retries transient current-process identity failures", () => {
    const identityReader = vi
      .fn<(pid: number) => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(exactIdentityForCurrentPlatform(123));

    expect(() =>
      createProcessOwnedLockFileSystem({ processIdentityReader: identityReader }),
    ).not.toThrow();
    expect(identityReader).toHaveBeenCalledTimes(2);
    expect(identityReader).toHaveBeenCalledWith(process.pid);
  });

  it("fails closed after bounded current-process identity retries", () => {
    const identityReader = vi.fn<(pid: number) => string | null>().mockReturnValue(null);

    expect(() =>
      createProcessOwnedLockFileSystem({ processIdentityReader: identityReader }),
    ).toThrow("Recorder lock process identity is unavailable.");
    expect(identityReader).toHaveBeenCalledTimes(3);
  });

  it("distinguishes dead Linux process states from stopped owners", () => {
    expect(isDeadLinuxProcessState("123 (worker) Z 1 2 3")).toBe(true);
    expect(isDeadLinuxProcessState("123 (worker) X 1 2 3")).toBe(true);
    expect(isDeadLinuxProcessState("123 (worker) x 1 2 3")).toBe(true);
    expect(isDeadLinuxProcessState("123 (worker) T 1 2 3")).toBe(false);
    expect(isDeadLinuxProcessState("malformed")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not reclaim a live owner paused beyond the stale threshold",
    async () => {
      const target = await createLockTarget();
      const child = await startLockOwner(target);
      child.kill("SIGSTOP");
      await new Promise((resolve) => setTimeout(resolve, 2300));

      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });

      child.kill("SIGCONT");
      const exited = once(child, "exit");
      child.stdin.end("release\n");
      await exited;
    },
    10_000,
  );

  it("discards a detached recovery claim after partial chain cleanup", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const child = await startLockOwner(target);
    const baseClaim = recoveryClaimPath(lockDirectory);
    await mkdir(baseClaim);
    await writeOwner(baseClaim, { pid: 2_147_483_647, processStartedAtMs: 1 });
    const takeoverClaim = recoveryClaimPath(baseClaim, "owner:test-token-placeholder");
    await mkdir(takeoverClaim);
    await writeOwner(takeoverClaim, { pid: 2_147_483_647, processStartedAtMs: 1 });
    const activeClaim = recoveryClaimPath(takeoverClaim, "owner:test-token-placeholder");
    const remove = fs.rm.bind(fs);
    let failedBaseCleanup = false;
    const removeSpy = vi.spyOn(fs, "rm").mockImplementation(((
      targetPath: fs.PathLike,
      options: fs.RmDirOptions,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      if (String(targetPath) === baseClaim && !failedBaseCleanup) {
        failedBaseCleanup = true;
        callback(Object.assign(new Error("base claim cleanup failed"), { code: "EACCES" }));
        return;
      }
      remove(targetPath, options, callback);
    }) as typeof fs.rm);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
      expect(fs.existsSync(baseClaim)).toBe(true);
      expect(fs.existsSync(takeoverClaim)).toBe(false);
      expect(fs.existsSync(activeClaim)).toBe(false);
    } finally {
      removeSpy.mockRestore();
    }

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
    expect(fs.existsSync(baseClaim)).toBe(false);
    child.stdin.end("release\n");
    await once(child, "exit");
  });

  it.skipIf(process.platform === "win32")("reclaims a dead identified owner", async () => {
    const target = await createLockTarget();
    const child = await startLockOwner(target);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 3300));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });

  it.skipIf(process.platform === "win32")(
    "allows only one contender to reclaim the same dead owner",
    async () => {
      const target = await createLockTarget();
      const child = await startLockOwner(target);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 3300));

      const results = await Promise.allSettled([acquire(target), acquire(target)]);
      const acquired = results.filter(
        (result): result is PromiseFulfilledResult<() => Promise<void>> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );

      expect(acquired).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "ELOCKED" });

      await acquired[0]?.value();
      expect(await readdir(path.dirname(target))).toEqual([]);
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "shares one recovery fence across parent-directory aliases",
    async () => {
      const target = await createLockTarget();
      const parent = path.dirname(target);
      const alias = `${parent}-alias`;
      await symlink(parent, alias, "dir");
      const aliasedTarget = path.join(alias, path.basename(target));
      try {
        const child = await startLockOwner(target);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        await new Promise((resolve) => setTimeout(resolve, 3300));

        const results = await Promise.allSettled([acquire(target), acquire(aliasedTarget)]);
        const acquired = results.filter(
          (result): result is PromiseFulfilledResult<() => Promise<void>> =>
            result.status === "fulfilled",
        );

        expect(acquired).toHaveLength(1);
        await acquired[0]?.value();
      } finally {
        await rm(alias, { force: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "takes over a recovery claim whose owner died",
    async () => {
      const target = await createLockTarget();
      const lockDirectory = `${target}.lock`;
      const child = await startLockOwner(target);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 3300));

      const claimPath = recoveryClaimPath(lockDirectory);
      await mkdir(claimPath);
      await writeOwner(claimPath, { pid: child.pid ?? 1, processStartedAtMs: 1 });

      const release = await acquire(target);
      await release();

      expect(await readdir(path.dirname(target))).toEqual([]);
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "reuses a process-wide coordination claim after final cleanup fails",
    async () => {
      const target = await createLockTarget();
      const child = await startLockOwner(target);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 3300));

      const remove = fs.rm.bind(fs);
      let claimCleanupCount = 0;
      const removeSpy = vi.spyOn(fs, "rm").mockImplementation(((
        targetPath: fs.PathLike,
        options: fs.RmDirOptions,
        callback: (error: NodeJS.ErrnoException | null) => void,
      ) => {
        const claimCleanup = /^\.crabline-reclaim-[0-9a-f]{64}$/u.test(
          path.basename(String(targetPath)),
        );
        if (claimCleanup && ++claimCleanupCount === 3) {
          callback(Object.assign(new Error("claim cleanup failed"), { code: "EACCES" }));
          return;
        }
        remove(targetPath, options, callback);
      }) as typeof fs.rm);
      try {
        const release = await acquire(target);
        expect(release).toBeTypeOf("function");
        await release();
        const nextRelease = await acquire(target);
        expect(nextRelease).toBeTypeOf("function");
        await nextRelease();
      } finally {
        removeSpy.mockRestore();
      }
    },
    15_000,
  );

  it("does not delete a successor when owner publication loses a race", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const lockFileSystem = createProcessOwnedLockFileSystem();
    const createDirectory = fs.mkdir.bind(fs);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(((
      directoryPath: fs.PathLike,
      optionsOrCallback: fs.MakeDirectoryOptions | ((error: NodeJS.ErrnoException | null) => void),
      possibleCallback?: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : possibleCallback!;
      if (String(directoryPath) !== lockDirectory) {
        if (typeof optionsOrCallback === "function") {
          createDirectory(directoryPath, optionsOrCallback);
        } else {
          createDirectory(directoryPath, optionsOrCallback, callback);
        }
        return;
      }
      fs.mkdirSync(directoryPath);
      fs.writeFileSync(
        path.join(String(directoryPath), "crabline-owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          processIdentity: "test:successor",
          processStartedAtMs: Math.trunc(performance.timeOrigin),
          token: "test-token-placeholder",
          version: 1,
        })}\n`,
        { mode: 0o600 },
      );
      callback(null);
    }) as typeof fs.mkdir);

    try {
      await expect(
        lock(target, {
          fs: lockFileSystem,
          realpath: false,
          retries: 0,
          stale: 2000,
          update: 1000,
        }),
      ).rejects.toMatchObject({ code: "ELOCKED" });
      await expect(
        readFile(path.join(lockDirectory, "crabline-owner.json"), "utf8"),
      ).resolves.toContain("test-token-placeholder");
    } finally {
      mkdirSpy.mockRestore();
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  it("removes an empty lock directory after owner publication fails", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    const openSync = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (String(filePath) === ownerPath) {
        throw Object.assign(new Error("owner publication failed"), { code: "EACCES" });
      }
      return openSync(filePath, flags, mode);
    }) as typeof fs.openSync);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "EACCES" });
      expect(fs.existsSync(lockDirectory)).toBe(false);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rolls back owner publication when close reports an error", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let ownerHandle: number | undefined;
    let closeFailed = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      const handle = openSync(filePath, flags, mode);
      if (String(filePath) === ownerPath) {
        ownerHandle = handle;
      }
      return handle;
    }) as typeof fs.openSync);
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((handle) => {
      if (handle === ownerHandle && !closeFailed) {
        closeFailed = true;
        throw Object.assign(new Error("owner close failed"), { code: "EIO" });
      }
      closeSync(handle);
    });

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "EIO" });
      expect(fs.existsSync(lockDirectory)).toBe(false);
    } finally {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("recovers an owner-preserving release failure in the same process", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const release = await acquire(target);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(((
      _oldPath: fs.PathLike,
      _newPath: fs.PathLike,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      callback(Object.assign(new Error("release rename failed"), { code: "EBUSY" }));
    }) as typeof fs.rename);

    try {
      await expect(release()).rejects.toMatchObject({ code: "EBUSY" });
      await expect(
        readFile(path.join(lockDirectory, "crabline-owner.json"), "utf8"),
      ).resolves.toContain('"token"');
    } finally {
      renameSpy.mockRestore();
    }

    const nextRelease = await acquire(target);
    await nextRelease();
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("recovers when release cannot acquire the coordination claim", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const release = await acquire(target);
    const createDirectory = fs.mkdir.bind(fs);
    let blocked = false;
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(((
      directoryPath: fs.PathLike,
      optionsOrCallback: fs.MakeDirectoryOptions | ((error: NodeJS.ErrnoException | null) => void),
      possibleCallback?: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : possibleCallback!;
      if (
        !blocked &&
        /^\.crabline-reclaim-[0-9a-f]{64}$/u.test(path.basename(String(directoryPath)))
      ) {
        blocked = true;
        callback(Object.assign(new Error("coordination busy"), { code: "EEXIST" }));
        return;
      }
      if (typeof optionsOrCallback === "function") {
        createDirectory(directoryPath, optionsOrCallback);
      } else {
        createDirectory(directoryPath, optionsOrCallback, callback);
      }
    }) as typeof fs.mkdir);

    try {
      await expect(release()).rejects.toMatchObject({ code: "ELOCKED" });
      await expect(
        readFile(path.join(lockDirectory, "crabline-owner.json"), "utf8"),
      ).resolves.toContain('"token"');
    } finally {
      mkdirSpy.mockRestore();
    }

    const nextRelease = await acquire(target);
    await nextRelease();
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("releases the published directory when owner metadata cannot be parsed", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    const release = await acquire(target);
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    const readFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
    let parsedOwnerHandle: number | undefined;
    let closeFailed = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      const handle = openSync(filePath, flags, mode);
      if (String(filePath) === ownerPath && flags === readFlags) {
        parsedOwnerHandle = handle;
      }
      return handle;
    }) as typeof fs.openSync);
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((handle) => {
      closeSync(handle);
      if (handle === parsedOwnerHandle && !closeFailed) {
        closeFailed = true;
        throw Object.assign(new Error("owner parse close failed"), { code: "EIO" });
      }
    });

    try {
      await expect(release()).resolves.toBeUndefined();
    } finally {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(fs.existsSync(lockDirectory)).toBe(false);
    const nextRelease = await acquire(target);
    await nextRelease();
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("fences new acquisitions through the final stale-owner rename", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await startIdleProcess();
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, {
      pid: owner.pid,
      processStartedAtMs: 1,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));

    const rename = fs.rename.bind(fs);
    let contender: Promise<() => Promise<void>> | undefined;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(((
      oldPath: fs.PathLike,
      newPath: fs.PathLike,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      contender = acquire(target);
      void contender.catch(() => undefined);
      setImmediate(() => rename(oldPath, newPath, callback));
    }) as typeof fs.rename);

    try {
      const release = await acquire(target);
      await expect(contender).rejects.toMatchObject({ code: "ELOCKED" });
      await release();
    } finally {
      renameSpy.mockRestore();
      owner.child.stdin.end();
      await once(owner.child, "exit");
    }
  }, 10_000);

  it.runIf(process.platform === "darwin")(
    "publishes a sub-second Darwin process identity",
    async () => {
      const target = await createLockTarget();
      const child = await startLockOwner(target);
      const owner = JSON.parse(
        await readFile(path.join(`${target}.lock`, "crabline-owner.json"), "utf8"),
      ) as { processIdentity: string | null };

      expect(owner.processIdentity).toMatch(/^darwin:\d+\.\d+:us:\d+$/u);

      const exited = once(child, "exit");
      child.stdin.end("release\n");
      await exited;
    },
    10_000,
  );

  it.runIf(process.platform === "linux")("publishes the Linux PID namespace identity", async () => {
    const target = await createLockTarget();
    const release = await acquire(target);
    const owner = JSON.parse(
      await readFile(path.join(`${target}.lock`, "crabline-owner.json"), "utf8"),
    ) as {
      executionIdentity: string | null;
      machineIdentity: string | null;
      processNamespace: string | null;
      version: number;
    };

    expect(owner.executionIdentity).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(owner.machineIdentity).toMatch(/^linux:[0-9a-f-]{16,64}$/u);
    expect(owner.processNamespace).toMatch(/^pid:\[\d+\]$/u);
    expect(owner.version).toBe(4);
    await release();
  });

  it("recovers a stale lock from a departed execution context in the current process", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const release = await acquire(target);
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    await release();

    await mkdir(lockDirectory);
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        ...owner,
        executionIdentity: randomUUID(),
        token: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );
    await utimes(lockDirectory, new Date(0), new Date(0));

    const nextRelease = await acquire(target);
    expect(nextRelease).toBeTypeOf("function");
    await nextRelease();
  });

  it.runIf(process.platform === "linux")(
    "fails closed when an owner belongs to another PID namespace",
    async () => {
      const target = await createLockTarget();
      const lockDirectory = `${target}.lock`;
      const child = await startLockOwner(target);
      child.kill("SIGSTOP");
      const ownerPath = path.join(lockDirectory, "crabline-owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      await writeFile(ownerPath, `${JSON.stringify({ ...owner, processNamespace: "pid:[1]" })}\n`);

      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });

      child.kill("SIGCONT");
      const exited = once(child, "exit");
      child.stdin.end("release\n");
      await exited;
    },
    10_000,
  );

  it.runIf(process.platform === "linux")(
    "recovers a stale lock after its PID namespace stops heartbeating",
    async () => {
      const target = await createLockTarget();
      const lockDirectory = `${target}.lock`;
      const child = await startLockOwner(target);
      child.kill("SIGSTOP");
      const ownerPath = path.join(lockDirectory, "crabline-owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      await writeFile(ownerPath, `${JSON.stringify({ ...owner, processNamespace: "pid:[1]" })}\n`);
      await utimes(lockDirectory, new Date(0), new Date(0));

      const release = await acquire(target);
      expect(release).toBeTypeOf("function");
      await release();

      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
    10_000,
  );

  it("keeps a live unverifiable owner when its process start still matches", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await startIdleProcess();
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, owner);
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));
    if (process.platform !== "win32") {
      owner.child.kill("SIGSTOP");
    }

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });

    if (process.platform !== "win32") {
      owner.child.kill("SIGCONT");
    }
    owner.child.stdin.end();
    await once(owner.child, "exit");
  });

  it("reclaims an unverifiable owner after its PID has been reused", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await startIdleProcess();
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, {
      pid: owner.pid,
      processStartedAtMs: 1,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();

    owner.child.stdin.end();
    await once(owner.child, "exit");
  });

  it("fails closed for a version-2 owner without an exact identity", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await startIdleProcess();
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, {
      pid: owner.pid,
      processIdentity: null,
      processStartedAtMs: owner.processStartedAtMs,
      version: 2,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });

    owner.child.stdin.end();
    await once(owner.child, "exit");
  });

  it("rejects a mismatched exact identity for the current PID", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    await writeOwner(lockDirectory, {
      pid: process.pid,
      processIdentity: exactIdentityForCurrentPlatform(1),
      processStartedAtMs: Math.trunc(performance.timeOrigin),
      version: 2,
    });
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });

  it("fails closed for recent locks without verifiable owner metadata", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
    await rm(lockDirectory, { recursive: true });
  });

  it("rejects oversized owner metadata without reading its contents", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    await writeFile(ownerPath, Buffer.alloc(4097));
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));
    const readSpy = vi.spyOn(fs, "readSync");

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      await rm(lockDirectory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not follow owner metadata symlinks", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const ownerTarget = path.join(path.dirname(target), "outside-owner.json");
    await mkdir(lockDirectory);
    await writeFile(ownerTarget, Buffer.alloc(4097));
    await symlink(ownerTarget, path.join(lockDirectory, "crabline-owner.json"));

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
    await rm(lockDirectory, { force: true, recursive: true });
    await rm(ownerTarget, { force: true });
  });

  it("fails closed for ownerless legacy locks that cannot be fenced from old clients", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    await utimes(lockDirectory, new Date(0), new Date(0));

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
    await rm(lockDirectory, { recursive: true });
  });
});
