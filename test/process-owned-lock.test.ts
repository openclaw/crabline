import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessOwnedLockFileSystem } from "../src/platform/process-owned-lock.js";
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

function acquire(target: string): Promise<() => Promise<void>> {
  return lock(target, {
    fs: createProcessOwnedLockFileSystem(),
    realpath: false,
    retries: 0,
    stale: 2000,
    update: 1000,
  });
}

describe("process-owned lock filesystem", () => {
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
  );

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

  it("fails closed for recent locks without verifiable owner metadata", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);

    await expect(acquire(target)).rejects.toMatchObject({ code: "ELOCKED" });
    await rm(lockDirectory, { recursive: true });
  });

  it("reclaims ownerless legacy locks after the migration grace period", async () => {
    const target = await createLockTarget();
    const lockDirectory = `${target}.lock`;
    await mkdir(lockDirectory);
    await utimes(lockDirectory, new Date(0), new Date(0));

    const release = await acquire(target);
    expect(release).toBeTypeOf("function");
    await release();
  });
});
