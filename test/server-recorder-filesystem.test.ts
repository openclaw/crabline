import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, expect, it } from "vitest";
import { recordServerEvent } from "../src/servers/recorder.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const lockRoot = path.join(
      userInfo().homedir,
      ".cache",
      "crabline",
      "locks",
      "server-recorder",
    );
    await mkdir(lockRoot, { mode: 0o700, recursive: true });
    await chmod(lockRoot, 0o700);

    let releaseIdentity: (() => Promise<void>) | undefined = await lock(
      path.join(lockRoot, `recorder-${identity.dev}-${identity.ino}`),
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
