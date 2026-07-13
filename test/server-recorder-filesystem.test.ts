import { appendFile, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordServerEvent } from "../src/servers/recorder.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
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
