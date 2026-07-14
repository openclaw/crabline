import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerRequestEvent } from "../src/servers/http.js";
import { recordServerEvent } from "../src/servers/recorder.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverEvent(pathname: string): ServerRequestEvent {
  return {
    at: "2026-07-14T12:00:00.000Z",
    method: "POST",
    path: pathname,
    query: {},
    type: "api",
  };
}

it.skipIf(process.platform === "win32")(
  "rejects a FIFO recorder without waiting for a writer",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    execFileSync("mkfifo", [recorderPath]);

    await expect(
      recordServerEvent({
        event: {
          at: new Date().toISOString(),
          method: "POST",
          path: "/fifo",
          query: {},
          type: "api",
        },
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toThrow("Server recorder path is not a regular file.");
  },
  1_000,
);

it.runIf(process.platform === "win32")(
  "appends through a validated existing Windows handle",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    await writeFile(recorderPath, JSON.stringify(serverEvent("/existing")), "utf8");

    await recordServerEvent({
      event: serverEvent("/appended"),
      onEvent: undefined,
      recorderPath,
    });

    const events = (await readFile(recorderPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { path: string });
    expect(events.map((event) => event.path)).toEqual(["/existing", "/appended"]);
  },
);

it.skipIf(process.platform === "win32")(
  "reacquires the matching lock when a recorder symlink is retargeted",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    const firstTarget = path.join(directory, "first.jsonl");
    const secondTarget = path.join(directory, "second.jsonl");
    await writeFile(firstTarget, "", "utf8");
    await writeFile(secondTarget, "", "utf8");
    await symlink(firstTarget, recorderPath, "file");

    let releaseFirst: (() => Promise<void>) | undefined = await lock(firstTarget, {
      realpath: false,
    });
    let releaseSecond: (() => Promise<void>) | undefined = await lock(secondTarget, {
      realpath: false,
    });
    let settled = false;
    const recording = recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/retargeted",
        query: {},
        type: "api",
      },
      onEvent: undefined,
      recorderPath,
    });
    void recording.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await delay(150);
      await rm(recorderPath);
      await symlink(secondTarget, recorderPath, "file");
      await releaseFirst();
      releaseFirst = undefined;

      await delay(150);
      expect(settled).toBe(false);

      await releaseSecond();
      releaseSecond = undefined;
      await recording;
    } finally {
      await releaseFirst?.();
      await releaseSecond?.();
    }

    expect(await readFile(firstTarget, "utf8")).toBe("");
    expect(await readFile(secondTarget, "utf8")).toContain('"path":"/retargeted"');
  },
);

it.skipIf(process.platform === "win32")(
  "revalidates a recorder symlink after waiting for its identity lock",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    const firstTarget = path.join(directory, "first.jsonl");
    const secondTarget = path.join(directory, "second.jsonl");
    await writeFile(firstTarget, "", "utf8");
    await writeFile(secondTarget, "", "utf8");
    await symlink(firstTarget, recorderPath, "file");
    const identity = await stat(firstTarget, { bigint: true });
    const lockRoot = path.join(directory, "shared-locks");
    await mkdir(lockRoot, { mode: 0o700, recursive: true });
    await chmod(lockRoot, 0o700);
    const canonicalLockRoot = await realpath(lockRoot);
    vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);

    let releaseIdentity: (() => Promise<void>) | undefined = await lock(
      path.join(canonicalLockRoot, `recorder-${identity.ino}`),
      { realpath: false },
    );
    const recording = recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/retargeted-during-identity-wait",
        query: {},
        type: "api",
      },
      onEvent: undefined,
      recorderPath,
    });
    try {
      await expect
        .poll(async () => {
          try {
            await stat(`${firstTarget}.lock`);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await rm(recorderPath);
      await symlink(secondTarget, recorderPath, "file");
      await releaseIdentity();
      releaseIdentity = undefined;
      await recording;
    } finally {
      await releaseIdentity?.();
    }

    expect(await readFile(firstTarget, "utf8")).toBe("");
    expect(await readFile(secondTarget, "utf8")).toContain(
      '"path":"/retargeted-during-identity-wait"',
    );
  },
);

it.skipIf(process.platform === "win32")(
  "preserves observer start order when a recorder symlink is retargeted",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    const firstTarget = path.join(directory, "first.jsonl");
    const secondTarget = path.join(directory, "second.jsonl");
    await writeFile(firstTarget, "", "utf8");
    await writeFile(secondTarget, "", "utf8");
    await symlink(firstTarget, recorderPath, "file");

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/first",
        query: {},
        type: "api",
      },
      onEvent: async () => {
        order.push("first:start");
        await firstBlocked;
        order.push("first:end");
      },
      recorderPath,
    });
    await expect.poll(() => [...order]).toEqual(["first:start"]);

    await rm(recorderPath);
    await symlink(secondTarget, recorderPath, "file");
    const second = recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/second",
        query: {},
        type: "api",
      },
      onEvent: () => {
        order.push("second");
      },
      recorderPath,
    });
    await expect
      .poll(async () => await readFile(secondTarget, "utf8"))
      .toContain('"path":"/second"');
    await expect.poll(() => [...order]).toEqual(["first:start", "second"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "second", "first:end"]);
  },
);

it.skipIf(process.platform === "win32")(
  "does not retry a committed append after a recorder symlink is retargeted",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    const firstTarget = path.join(directory, "first.jsonl");
    const secondTarget = path.join(directory, "second.jsonl");
    await writeFile(firstTarget, "", "utf8");
    await writeFile(secondTarget, "", "utf8");
    await symlink(firstTarget, recorderPath, "file");

    const probe = await open(firstTarget, "a+");
    const prototype = Object.getPrototypeOf(probe) as {
      appendFile(data: string, options: { encoding: "utf8" }): Promise<void>;
    };
    await probe.close();
    const originalAppendFile = prototype.appendFile;
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptAppend = true;
    prototype.appendFile = async function (this: FileHandle, data, options) {
      await originalAppendFile.call(this, data, options);
      if (interceptAppend && data.includes('"path":"/retargeted-after-append"')) {
        interceptAppend = false;
        reportWrite();
        await writeReleased;
      }
    };

    const recording = recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/retargeted-after-append",
        query: {},
        type: "api",
      },
      onEvent: undefined,
      recorderPath,
    });
    try {
      await writeReported;
      await rm(recorderPath);
      await symlink(secondTarget, recorderPath, "file");
      releaseWrite();
      await expect(recording).rejects.toMatchObject({
        committed: true,
        name: "ServerRecorderCommittedError",
      });
    } finally {
      releaseWrite();
      prototype.appendFile = originalAppendFile;
    }

    expect((await readFile(firstTarget, "utf8")).trimEnd().split("\n")).toHaveLength(1);
    expect(await readFile(secondTarget, "utf8")).toBe("");
  },
);

it.skipIf(process.platform === "win32")(
  "locks and appends through a dangling recorder symlink target",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    const targetPath = path.join(directory, "target.jsonl");
    await symlink(targetPath, recorderPath, "file");

    await recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/dangling",
        query: {},
        type: "api",
      },
      onEvent: undefined,
      recorderPath,
    });

    const lines = (await readFile(targetPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ path: "/dangling" });
    expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
  },
);

it.skipIf(process.platform === "win32")("preserves an existing recorder file mode", async () => {
  const directory = await createTempDir();
  directories.push(directory);
  const recorderPath = path.join(directory, "server.jsonl");
  await writeFile(recorderPath, "", "utf8");
  await chmod(recorderPath, 0o640);

  await recordServerEvent({
    event: {
      at: new Date().toISOString(),
      method: "POST",
      path: "/existing-mode",
      query: {},
      type: "api",
    },
    onEvent: undefined,
    recorderPath,
  });

  expect((await stat(recorderPath)).mode & 0o777).toBe(0o640);
});

it.skipIf(process.platform === "win32")(
  "serializes torn-tail repair with a writer through the rotated pathname",
  async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "server.jsonl");
    const rotatedPath = `${recorderPath}.rotated`;
    const completed = `${JSON.stringify({
      at: new Date().toISOString(),
      method: "POST",
      path: "/completed",
      query: {},
      type: "api",
    })}\n`;
    await writeFile(recorderPath, `${completed}{"path":"/torn"`, "utf8");

    const probe = await open(recorderPath, "a+");
    const prototype = Object.getPrototypeOf(probe) as {
      appendFile(data: string, options: { encoding: "utf8" }): Promise<void>;
      truncate(length: number): Promise<void>;
    };
    await probe.close();
    const originalAppendFile = prototype.appendFile;
    const originalTruncate = prototype.truncate;
    let releaseRepair!: () => void;
    let reportRepair!: () => void;
    const repairReported = new Promise<void>((resolve) => {
      reportRepair = resolve;
    });
    const repairReleased = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    let releaseSecondAppend!: () => void;
    const secondAppendReleased = new Promise<void>((resolve) => {
      releaseSecondAppend = resolve;
    });
    let secondAppendStarted = false;
    let pauseRepair = true;
    prototype.appendFile = async function (this: FileHandle, data, options) {
      if (data.includes('"path":"/second-through-rotated-path"')) {
        secondAppendStarted = true;
        await secondAppendReleased;
      }
      await originalAppendFile.call(this, data, options);
    };
    prototype.truncate = async function (this: FileHandle, length) {
      if (pauseRepair) {
        pauseRepair = false;
        reportRepair();
        await repairReleased;
      }
      await originalTruncate.call(this, length);
    };

    const first = recordServerEvent({
      event: {
        at: new Date().toISOString(),
        method: "POST",
        path: "/first-after-repair",
        query: {},
        type: "api",
      },
      onEvent: undefined,
      recorderPath,
    });
    try {
      await repairReported;
      await rename(recorderPath, rotatedPath);
      const second = recordServerEvent({
        event: {
          at: new Date().toISOString(),
          method: "POST",
          path: "/second-through-rotated-path",
          query: {},
          type: "api",
        },
        onEvent: undefined,
        recorderPath: rotatedPath,
      });
      await expect
        .poll(async () => {
          try {
            await stat(`${rotatedPath}.lock`);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      expect(secondAppendStarted).toBe(false);

      releaseRepair();
      releaseSecondAppend();
      await Promise.all([first, second]);
    } finally {
      releaseRepair();
      releaseSecondAppend();
      prototype.appendFile = originalAppendFile;
      prototype.truncate = originalTruncate;
    }

    const recordedPaths = (await readFile(rotatedPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { path: string }).path);
    expect(recordedPaths).toEqual(["/completed", "/second-through-rotated-path"]);
    expect(await readFile(recorderPath, "utf8")).toContain('"path":"/first-after-repair"');
  },
);

it("never truncates a rotated inode after a later writer appends", async () => {
  const directory = await createTempDir();
  directories.push(directory);
  const recorderPath = path.join(directory, "server.jsonl");
  const rotatedPath = `${recorderPath}.rotated`;
  await writeFile(recorderPath, "", "utf8");

  const probe = await open(recorderPath, "a+");
  const prototype = Object.getPrototypeOf(probe) as {
    appendFile(data: string, options: { encoding: "utf8" }): Promise<void>;
  };
  await probe.close();
  const originalAppendFile = prototype.appendFile;
  let release!: () => void;
  let appended!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const appendObserved = new Promise<void>((resolve) => {
    appended = resolve;
  });
  let pause = true;
  prototype.appendFile = async function (this: FileHandle, data, options) {
    await originalAppendFile.call(this, data, options);
    if (pause && data.includes('"path":"/owned"')) {
      pause = false;
      appended();
      await released;
    }
  };

  const recording = recordServerEvent({
    event: { at: new Date().toISOString(), method: "POST", path: "/owned", query: {}, type: "api" },
    onEvent: undefined,
    recorderPath,
  });
  try {
    await appendObserved;
    await rename(recorderPath, rotatedPath);
    await writeFile(recorderPath, "", "utf8");
    await appendFile(rotatedPath, '{"path":"/later"}\n', "utf8");
    release();
    await expect(recording).rejects.toMatchObject({
      committed: true,
      name: "ServerRecorderCommittedError",
    });
  } finally {
    release();
    prototype.appendFile = originalAppendFile;
  }

  expect(await readFile(rotatedPath, "utf8")).toContain('"path":"/owned"');
  expect(await readFile(rotatedPath, "utf8")).toContain('"path":"/later"');
  expect(await readFile(recorderPath, "utf8")).toBe("");
});
