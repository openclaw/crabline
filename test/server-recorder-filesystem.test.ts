import {
  appendFile,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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
