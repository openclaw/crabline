import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename as renamePath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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

async function currentOwnerRecord(): Promise<Record<string, unknown>> {
  const target = await createLockTarget();
  const release = await acquire(target);
  const owner = JSON.parse(
    await readFile(path.join(`${target}.lock`, "crabline-owner.json"), "utf8"),
  ) as Record<string, unknown>;
  await release();
  return owner;
}

async function writeDepartedExecutionOwner(
  lockDirectory: string,
  owner: Record<string, unknown>,
): Promise<string> {
  const token = randomUUID();
  await writeFile(
    path.join(lockDirectory, "crabline-owner.json"),
    `${JSON.stringify({
      ...owner,
      executionIdentity: randomUUID(),
      token,
    })}\n`,
    { mode: 0o600 },
  );
  await utimes(lockDirectory, new Date(0), new Date(0));
  return token;
}

function recoveryClaimPath(lockDirectory: string, fingerprint = "coordination"): string {
  const canonical = path.join(
    fs.realpathSync.native(path.dirname(lockDirectory)),
    path.basename(lockDirectory),
  );
  const canonicalDirectory =
    process.platform === "win32" ? path.win32.normalize(canonical).toLowerCase() : canonical;
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

  it.runIf(process.platform === "darwin")(
    "uses a coarse process identity when attach-based inspection is unavailable",
    async () => {
      const target = await createLockTarget();
      const lockFs = createProcessOwnedLockFileSystem({
        processIdentityReader: () => "darwin:1.1:s:123",
      });
      const release = await lock(target, {
        fs: lockFs,
        realpath: false,
        retries: 0,
        stale: 2000,
        update: 1000,
      });
      const owner = JSON.parse(
        await readFile(path.join(`${target}.lock`, "crabline-owner.json"), "utf8"),
      ) as { processIdentity: string; version: number };

      expect(owner).toMatchObject({
        processIdentity: "darwin:1.1:s:123",
        version: 1,
      });
      await release();
    },
  );

  it.runIf(process.platform === "darwin")(
    "does not reclaim a precise owner observed through a coarse fallback",
    async () => {
      const target = await createLockTarget();
      const lockDirectory = `${target}.lock`;
      const owner = await startIdleProcess();
      const preciseIdentity = `darwin:1.1:us:${owner.processStartedAtMs * 1000}`;
      const coarseIdentity = `darwin:1.1:s:${Math.trunc(owner.processStartedAtMs / 1000)}`;
      await mkdir(lockDirectory);
      await writeOwner(lockDirectory, {
        pid: owner.pid,
        processIdentity: preciseIdentity,
        processStartedAtMs: owner.processStartedAtMs,
      });
      await utimes(lockDirectory, new Date(0), new Date(0));
      const lockFs = createProcessOwnedLockFileSystem({
        processIdentityReader: (pid) =>
          pid === process.pid ? exactIdentityForCurrentPlatform(123) : coarseIdentity,
      });

      await expect(
        lock(target, {
          fs: lockFs,
          realpath: false,
          retries: 0,
          stale: 2000,
          update: 1000,
        }),
      ).rejects.toMatchObject({ code: "ELOCKED" });

      owner.child.stdin.end();
      await once(owner.child, "exit");
    },
    10_000,
  );

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
    const owner = await currentOwnerRecord();
    const baseClaim = recoveryClaimPath(lockDirectory);
    await mkdir(baseClaim);
    const baseToken = await writeDepartedExecutionOwner(baseClaim, owner);
    const takeoverClaim = recoveryClaimPath(baseClaim, `owner:${baseToken}`);
    await mkdir(takeoverClaim);
    const takeoverToken = await writeDepartedExecutionOwner(takeoverClaim, owner);
    const activeClaim = recoveryClaimPath(takeoverClaim, `owner:${takeoverToken}`);
    const removeDirectory = fs.rmdirSync.bind(fs);
    let failedBaseCleanup = false;
    const removeSpy = vi.spyOn(fs, "rmdirSync").mockImplementation(((targetPath: fs.PathLike) => {
      if (String(targetPath).startsWith(`${baseClaim}.cleanup.`) && !failedBaseCleanup) {
        failedBaseCleanup = true;
        throw Object.assign(new Error("base claim cleanup failed"), { code: "EACCES" });
      }
      removeDirectory(targetPath);
    }) as typeof fs.rmdirSync);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
      expect(
        fs
          .readdirSync(path.dirname(baseClaim))
          .some((entry) => entry.startsWith(`${path.basename(baseClaim)}.cleanup.`)),
      ).toBe(true);
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

  it("recovers an aged coordination claim with truncated owner metadata", async () => {
    const target = await createLockTarget();
    const claimPath = recoveryClaimPath(`${target}.lock`);
    await mkdir(claimPath);
    await writeFile(path.join(claimPath, "crabline-owner.json"), "");
    await utimes(claimPath, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
    expect(fs.existsSync(claimPath)).toBe(false);
  });

  it("recovers an aged version-1 coordination claim after its PID is reused", async () => {
    const target = await createLockTarget();
    const claimPath = recoveryClaimPath(`${target}.lock`);
    const owner = await startIdleProcess();
    await mkdir(claimPath);
    const ownerPath = await writeOwner(claimPath, {
      pid: owner.pid,
      processStartedAtMs: 1,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(claimPath, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
    expect(fs.existsSync(claimPath)).toBe(false);

    owner.child.stdin.end();
    await once(owner.child, "exit");
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "exposes failed coordination cleanup to another process",
    async () => {
      const target = await createLockTarget();
      const child = await startLockOwner(target);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 3300));

      const removeDirectory = fs.rmdirSync.bind(fs);
      let claimCleanupCount = 0;
      const removeSpy = vi.spyOn(fs, "rmdirSync").mockImplementation(((targetPath: fs.PathLike) => {
        const claimCleanup =
          path.basename(String(targetPath)).startsWith(".crabline-reclaim-") &&
          String(targetPath).includes(".cleanup.");
        if (claimCleanup && ++claimCleanupCount === 3) {
          throw Object.assign(new Error("claim cleanup failed"), { code: "EACCES" });
        }
        removeDirectory(targetPath);
      }) as typeof fs.rmdirSync);
      try {
        const release = await acquire(target);
        expect(release).toBeTypeOf("function");
        await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
        await release();
        const nextOwner = await startLockOwner(target);
        const nextOwnerExited = once(nextOwner, "exit");
        nextOwner.stdin.end("release\n");
        await nextOwnerExited;
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

  it("does not reuse a replacement coordination claim", async () => {
    const target = await createLockTarget();
    const replacementOwner = await currentOwnerRecord();
    const lockFileSystem = createProcessOwnedLockFileSystem();
    const readDirectory = fs.readdirSync.bind(fs);
    let sentinelPath: string | undefined;
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((directoryPath, options) => {
      const cleanupPath = String(directoryPath);
      const match = /^(.*\.crabline-reclaim-[0-9a-f]{64})\.cleanup\.[0-9a-f-]+$/u.exec(cleanupPath);
      if (sentinelPath === undefined && match !== null) {
        const claimPath = match[1]!;
        fs.mkdirSync(claimPath);
        fs.writeFileSync(
          path.join(claimPath, "crabline-owner.json"),
          `${JSON.stringify({ ...replacementOwner, token: randomUUID() })}\n`,
          { mode: 0o600 },
        );
        const replacementTree = path.join(claimPath, "replacement");
        fs.mkdirSync(replacementTree);
        sentinelPath = path.join(replacementTree, "sentinel");
        fs.writeFileSync(sentinelPath, "preserve");
      }
      return readDirectory(directoryPath, options as never);
    }) as typeof fs.readdirSync);

    try {
      const release = await lock(target, {
        fs: lockFileSystem,
        realpath: false,
        retries: 0,
        stale: 2000,
        update: 1000,
      });
      expect(sentinelPath).toBeDefined();
      expect(fs.readFileSync(sentinelPath!, "utf8")).toBe("preserve");
      await expect(release()).rejects.toMatchObject({ code: "ELOCKED" });
      expect(fs.readFileSync(sentinelPath!, "utf8")).toBe("preserve");
    } finally {
      readdirSpy.mockRestore();
    }
  }, 10_000);

  it("does not bind a stale owner to a replacement coordination claim", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const claimPath = recoveryClaimPath(lockDirectory);
    const originalClaimPath = `${claimPath}.original`;
    await mkdir(claimPath);
    const staleOwnerPath = await writeOwner(claimPath, {
      pid: 2_000_000_000,
      processStartedAtMs: 1,
    });
    await utimes(staleOwnerPath, new Date(0), new Date(0));
    await utimes(claimPath, new Date(0), new Date(0));
    const replacementOwner = await currentOwnerRecord();
    const replacementGenerationKey = String(replacementOwner.token);
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let staleOwnerHandle: number | undefined;
    let replaced = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      const handle = openSync(filePath, flags, mode);
      if (String(filePath) === staleOwnerPath && staleOwnerHandle === undefined) {
        staleOwnerHandle = handle;
      }
      return handle;
    }) as typeof fs.openSync);
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((handle) => {
      closeSync(handle);
      if (handle === staleOwnerHandle && !replaced) {
        replaced = true;
        fs.renameSync(claimPath, originalClaimPath);
        fs.mkdirSync(claimPath);
        fs.writeFileSync(
          path.join(claimPath, "crabline-owner.json"),
          `${JSON.stringify(replacementOwner)}\n`,
          { mode: 0o600 },
        );
      }
    });

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
      await expect(
        readFile(path.join(claimPath, "crabline-owner.json"), "utf8"),
      ).resolves.toContain(replacementGenerationKey);
    } finally {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("releases an active claim when a superseded claim disappears during inspection", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const claimPath = recoveryClaimPath(lockDirectory);
    const detachedClaimPath = `${claimPath}.detached`;
    await mkdir(claimPath);
    await writeOwner(claimPath, {
      pid: 2_000_000_000,
      processStartedAtMs: 1,
    });
    await utimes(claimPath, new Date(0), new Date(0));
    const staleGenerationKey = "test-token-placeholder";
    const takeoverPath = recoveryClaimPath(claimPath, `owner:${staleGenerationKey}`);
    const lstatSync = fs.lstatSync.bind(fs);
    let detached = false;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((filePath, options) => {
      const stats = lstatSync(filePath, options as never);
      if (String(filePath) === claimPath && fs.existsSync(takeoverPath) && !detached) {
        detached = true;
        fs.renameSync(claimPath, detachedClaimPath);
      }
      return stats;
    }) as typeof fs.lstatSync);

    try {
      const release = await acquire(target);
      expect(detached).toBe(true);
      expect(fs.existsSync(claimPath)).toBe(false);
      expect(fs.existsSync(takeoverPath)).toBe(false);
      await release();
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("preserves another wrapper's retained coordination claim", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const claimPath = recoveryClaimPath(lockDirectory);
    const ownerFileSystem = createProcessOwnedLockFileSystem();
    const foreignFileSystem = createProcessOwnedLockFileSystem();
    const readdirSync = fs.readdirSync.bind(fs);
    const openSync = fs.openSync.bind(fs);
    let cleanupFailed = false;
    let abandonmentFailed = false;
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((directoryPath, options) => {
      if (String(directoryPath).startsWith(`${claimPath}.cleanup.`) && !cleanupFailed) {
        cleanupFailed = true;
        throw Object.assign(new Error("claim cleanup failed"), { code: "EACCES" });
      }
      return readdirSync(directoryPath, options as never);
    }) as typeof fs.readdirSync);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (
        /^\.crabline-abandoned-[0-9a-f]{64}$/u.test(path.basename(String(filePath))) &&
        !abandonmentFailed
      ) {
        abandonmentFailed = true;
        throw Object.assign(new Error("claim abandonment failed"), { code: "EACCES" });
      }
      return openSync(filePath, flags, mode);
    }) as typeof fs.openSync);
    let release: (() => Promise<void>) | undefined;

    try {
      release = await lock(target, {
        fs: ownerFileSystem,
        realpath: false,
        retries: 0,
        stale: 2000,
        update: 1000,
      });
    } finally {
      openSpy.mockRestore();
      readdirSpy.mockRestore();
    }

    await expect(
      lock(target, {
        fs: foreignFileSystem,
        realpath: false,
        retries: 0,
        stale: 2000,
        update: 1000,
      }),
    ).rejects.toMatchObject({ code: "ELOCKED" });

    const ownerPath = path.join(claimPath, "crabline-owner.json");
    const openSyncAfterRetention = fs.openSync.bind(fs);
    let inspectionFailed = false;
    const inspectionSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (String(filePath) === ownerPath && !inspectionFailed) {
        inspectionFailed = true;
        throw Object.assign(new Error("claim inspection failed"), { code: "EACCES" });
      }
      return openSyncAfterRetention(filePath, flags, mode);
    }) as typeof fs.openSync);
    try {
      await expect(
        lock(target, {
          fs: foreignFileSystem,
          realpath: false,
          retries: 0,
          stale: 2000,
          update: 1000,
        }),
      ).rejects.toMatchObject({ code: "ELOCKED" });
    } finally {
      inspectionSpy.mockRestore();
    }

    expect(inspectionFailed).toBe(false);
    await expect(release()).resolves.toBeUndefined();
    expect(fs.existsSync(claimPath)).toBe(false);
  }, 15_000);

  it("preserves a replacement tree at a release tombstone path", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const release = await acquire(target);
    const rename = fs.rename.bind(fs);
    let sentinelPath: string | undefined;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(((
      oldPath: fs.PathLike,
      newPath: fs.PathLike,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      rename(oldPath, newPath, (error) => {
        if (!error && String(oldPath) === lockDirectory) {
          const tombstonePath = String(newPath);
          fs.renameSync(tombstonePath, `${tombstonePath}.original`);
          fs.mkdirSync(tombstonePath);
          const replacementTree = path.join(tombstonePath, "replacement");
          fs.mkdirSync(replacementTree);
          sentinelPath = path.join(replacementTree, "sentinel");
          fs.writeFileSync(sentinelPath, "preserve");
        }
        callback(error);
      });
    }) as typeof fs.rename);

    try {
      await expect(release()).rejects.toMatchObject({ code: "ELOCKED" });
      expect(sentinelPath).toBeDefined();
      expect(fs.readFileSync(sentinelPath!, "utf8")).toBe("preserve");
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("fails release when its owned lock path disappears", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const displacedDirectory = `${lockDirectory}.displaced`;
    const release = await acquire(target);
    await renamePath(lockDirectory, displacedDirectory);

    try {
      await expect(release()).rejects.toMatchObject({ code: "ELOCKED" });
      await expect(
        readFile(path.join(displacedDirectory, "crabline-owner.json"), "utf8"),
      ).resolves.toContain(`"pid":${process.pid}`);
    } finally {
      await rm(displacedDirectory, { force: true, recursive: true });
    }
  });

  it("does not quarantine a replacement substituted immediately before removal", async () => {
    const target = await createLockTarget();
    let removalPath: string | undefined;
    let replacementIdentity: fs.BigIntStats | undefined;
    const lockFileSystem = createProcessOwnedLockFileSystem({
      beforeDirectoryRemoval: (directoryPath) => {
        if (removalPath || !directoryPath.endsWith(".release")) {
          return;
        }
        removalPath = directoryPath;
        fs.renameSync(directoryPath, `${directoryPath}.original`);
        fs.mkdirSync(directoryPath);
        replacementIdentity = fs.lstatSync(directoryPath, { bigint: true });
      },
    });
    const release = await lock(target, {
      fs: lockFileSystem,
      realpath: false,
      retries: 0,
      stale: 2000,
      update: 1000,
    });

    await expect(release()).rejects.toMatchObject({ code: "ELOCKED" });
    expect(removalPath).toBeDefined();
    const retained = fs.lstatSync(removalPath!, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({
      dev: replacementIdentity?.dev,
      ino: replacementIdentity?.ino,
    });
    expect(
      fs
        .readdirSync(path.dirname(removalPath!))
        .some((entry) => entry.startsWith(`${path.basename(removalPath!)}.cleanup.`)),
    ).toBe(false);
  });

  it("claims the verified lock directory before removing owner metadata", async () => {
    const target = await createLockTarget();
    let ownerPresentAtClaim = false;
    const readDirectory = fs.readdirSync.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((directoryPath, options) => {
      const cleanupPath = String(directoryPath);
      if (cleanupPath.includes(".release.cleanup.")) {
        ownerPresentAtClaim = fs.existsSync(path.join(cleanupPath, "crabline-owner.json"));
      }
      return readDirectory(directoryPath, options as never);
    }) as typeof fs.readdirSync);
    const lockFileSystem = createProcessOwnedLockFileSystem();
    const release = await lock(target, {
      fs: lockFileSystem,
      realpath: false,
      retries: 0,
      stale: 2000,
      update: 1000,
    });

    try {
      await expect(release()).resolves.toBeUndefined();
      expect(ownerPresentAtClaim).toBe(true);
    } finally {
      readdirSpy.mockRestore();
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

  it("preserves a replacement lock directory after owner publication fails", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const originalDirectory = `${lockDirectory}.original`;
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    const openSync = fs.openSync.bind(fs);
    let replacementIdentity: fs.BigIntStats | undefined;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
      if (String(filePath) === ownerPath) {
        fs.renameSync(lockDirectory, originalDirectory);
        fs.mkdirSync(lockDirectory);
        replacementIdentity = fs.lstatSync(lockDirectory, { bigint: true });
        throw Object.assign(new Error("owner publication failed"), { code: "EACCES" });
      }
      return openSync(filePath, flags, mode);
    }) as typeof fs.openSync);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "EACCES" });
      const retained = fs.lstatSync(lockDirectory, { bigint: true });
      expect({ dev: retained.dev, ino: retained.ino }).toEqual({
        dev: replacementIdentity?.dev,
        ino: replacementIdentity?.ino,
      });
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

  it("abandons a published owner when directory verification fails", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    const lstatSync = fs.lstatSync.bind(fs);
    let verificationFailed = false;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((filePath, options) => {
      if (String(filePath) === lockDirectory && fs.existsSync(ownerPath) && !verificationFailed) {
        verificationFailed = true;
        throw Object.assign(new Error("directory verification failed"), { code: "EIO" });
      }
      return lstatSync(filePath, options as never);
    }) as typeof fs.lstatSync);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "EIO" });
      await expect(readFile(ownerPath, "utf8")).resolves.toContain('"token"');

      const nextOwner = await startLockOwner(target);
      const exited = once(nextOwner, "exit");
      nextOwner.stdin.end("release\n");
      await exited;
    } finally {
      lstatSpy.mockRestore();
      await rm(lockDirectory, { force: true, recursive: true });
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

  it("retries release when a transient coordination claim blocks cleanup", async () => {
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
      await expect(release()).resolves.toBeUndefined();
      expect(fs.existsSync(lockDirectory)).toBe(false);
    } finally {
      mkdirSpy.mockRestore();
    }
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

  it("restores a published replacement displaced by the final stale-owner rename", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const originalDirectory = `${lockDirectory}.original`;
    const owner = await startIdleProcess();
    const replacementOwner = await currentOwnerRecord();
    const replacementGeneration = String(replacementOwner.token);
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, {
      pid: owner.pid,
      processStartedAtMs: 1,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));

    const rename = fs.rename.bind(fs);
    let replacementSentinel = "";
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(((
      oldPath: fs.PathLike,
      newPath: fs.PathLike,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      fs.renameSync(lockDirectory, originalDirectory);
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(
        path.join(lockDirectory, "crabline-owner.json"),
        `${JSON.stringify(replacementOwner)}\n`,
      );
      replacementSentinel = path.join(lockDirectory, "replacement");
      fs.writeFileSync(replacementSentinel, "preserve");
      rename(oldPath, newPath, callback);
    }) as typeof fs.rename);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
      await expect(readFile(replacementSentinel, "utf8")).resolves.toBe("preserve");
      await expect(
        readFile(path.join(lockDirectory, "crabline-owner.json"), "utf8"),
      ).resolves.toContain(replacementGeneration);
    } finally {
      renameSpy.mockRestore();
      await rm(lockDirectory, { force: true, recursive: true });
      await rm(originalDirectory, { force: true, recursive: true });
      owner.child.stdin.end();
      await once(owner.child, "exit");
    }
  }, 10_000);

  it("preserves a displaced replacement when another published directory wins restoration", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const originalDirectory = `${lockDirectory}.original`;
    const owner = await startIdleProcess();
    const displacedOwner = await currentOwnerRecord();
    const winningOwner = await currentOwnerRecord();
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, {
      pid: owner.pid,
      processStartedAtMs: 1,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));

    const rename = fs.rename.bind(fs);
    const renameSync = fs.renameSync.bind(fs);
    let displacedPath = "";
    let displacedSentinel = "";
    let winningSentinel = "";
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(((
      oldPath: fs.PathLike,
      newPath: fs.PathLike,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      displacedPath = String(newPath);
      fs.renameSync(lockDirectory, originalDirectory);
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(
        path.join(lockDirectory, "crabline-owner.json"),
        `${JSON.stringify(displacedOwner)}\n`,
      );
      displacedSentinel = path.join(lockDirectory, "displaced");
      fs.writeFileSync(displacedSentinel, "preserve displaced");
      rename(oldPath, newPath, callback);
    }) as typeof fs.rename);
    const renameSyncSpy = vi.spyOn(fs, "renameSync").mockImplementation(((oldPath, newPath) => {
      if (String(oldPath) === displacedPath && String(newPath) === lockDirectory) {
        fs.mkdirSync(lockDirectory);
        fs.writeFileSync(
          path.join(lockDirectory, "crabline-owner.json"),
          `${JSON.stringify(winningOwner)}\n`,
        );
        winningSentinel = path.join(lockDirectory, "winning");
        fs.writeFileSync(winningSentinel, "preserve winner");
      }
      renameSync(oldPath, newPath);
    }) as typeof fs.renameSync);

    try {
      await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
      await expect(readFile(winningSentinel, "utf8")).resolves.toBe("preserve winner");
      await expect(readFile(path.join(displacedPath, "displaced"), "utf8")).resolves.toBe(
        "preserve displaced",
      );
    } finally {
      renameSyncSpy.mockRestore();
      renameSpy.mockRestore();
      await rm(displacedPath, { force: true, recursive: true });
      await rm(lockDirectory, { force: true, recursive: true });
      await rm(originalDirectory, { force: true, recursive: true });
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

  it("recovers an aged coarse owner from a departed current-process execution context", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    const ownerPath = await writeOwner(lockDirectory, {
      executionIdentity: randomUUID(),
      pid: process.pid,
      processIdentity: `darwin:1.1:s:${Math.trunc(performance.timeOrigin / 1000)}`,
      processStartedAtMs: Math.trunc(performance.timeOrigin),
      version: 1,
    });
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));

    const nextRelease = await acquire(target);
    expect(nextRelease).toBeTypeOf("function");
    await nextRelease();
  });

  it("treats a version-4 owner from another machine as foreign", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await currentOwnerRecord();
    const platform = process.platform === "win32" ? "windows" : process.platform;
    await mkdir(lockDirectory);
    await writeFile(
      path.join(lockDirectory, "crabline-owner.json"),
      `${JSON.stringify({
        ...owner,
        machineIdentity: `${platform}:00000000-0000-0000-0000-000000000000`,
        token: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });

  it("recovers a stale version-4 owner written on another platform", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await currentOwnerRecord();
    const foreignPlatform = process.platform === "linux" ? "windows" : "linux";
    await mkdir(lockDirectory);
    await writeFile(
      path.join(lockDirectory, "crabline-owner.json"),
      `${JSON.stringify({
        ...owner,
        machineIdentity: `${foreignPlatform}:00000000-0000-0000-0000-000000000000`,
        processIdentity:
          foreignPlatform === "linux"
            ? "linux:00000000-0000-0000-0000-000000000000:1"
            : "windows:1",
        processNamespace: foreignPlatform === "linux" ? "pid:[1]" : null,
        token: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });

  it("recovers an ownerless publication left behind with a dead coordination claim", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await currentOwnerRecord();
    await mkdir(lockDirectory);
    await utimes(lockDirectory, new Date(0), new Date(0));
    const claimPath = recoveryClaimPath(lockDirectory);
    await mkdir(claimPath);
    await writeDepartedExecutionOwner(claimPath, owner);

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });

  it("recovers an aged lock with truncated owner metadata", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "crabline-owner.json"), "");
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
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

  it("keeps a recent exact owner when its live PID identity cannot be inspected", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await startIdleProcess();
    const ownerRecord = await currentOwnerRecord();
    await mkdir(lockDirectory);
    await writeFile(
      path.join(lockDirectory, "crabline-owner.json"),
      `${JSON.stringify({
        ...ownerRecord,
        executionIdentity: randomUUID(),
        pid: owner.pid,
        processIdentity: exactIdentityForCurrentPlatform(1),
        processStartedAtMs: 1,
        token: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );
    const identityReader = vi.fn((pid: number) =>
      pid === process.pid ? exactIdentityForCurrentPlatform(2) : null,
    );
    const lockFileSystem = createProcessOwnedLockFileSystem({
      processIdentityReader: identityReader,
    });

    await expect(
      lock(target, {
        fs: lockFileSystem,
        realpath: false,
        retries: 0,
        stale: 2000,
        update: 1000,
      }),
    ).rejects.toMatchObject({ code: "ELOCKED" });

    expect(identityReader.mock.calls.filter(([pid]) => pid === owner.pid)).toHaveLength(1);
    owner.child.stdin.end();
    await once(owner.child, "exit");
  });

  it("recovers an aged exact owner after repeated live PID identity failures", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    const owner = await startIdleProcess();
    const ownerRecord = await currentOwnerRecord();
    await mkdir(lockDirectory);
    const ownerPath = path.join(lockDirectory, "crabline-owner.json");
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        ...ownerRecord,
        executionIdentity: randomUUID(),
        pid: owner.pid,
        processIdentity: exactIdentityForCurrentPlatform(1),
        processStartedAtMs: 1,
        token: randomUUID(),
      })}\n`,
      { mode: 0o600 },
    );
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(lockDirectory, new Date(0), new Date(0));
    const identityReader = vi.fn((pid: number) =>
      pid === process.pid ? exactIdentityForCurrentPlatform(2) : null,
    );
    const lockFileSystem = createProcessOwnedLockFileSystem({
      processIdentityReader: identityReader,
    });

    const release = await lock(target, {
      fs: lockFileSystem,
      realpath: false,
      retries: 0,
      stale: 2000,
      update: 1000,
    });
    expect(
      identityReader.mock.calls.filter(([pid]) => pid === owner.pid).length,
    ).toBeGreaterThanOrEqual(2);
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

  it("recovers stale ownerless locks left by pre-upgrade clients", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });
});
