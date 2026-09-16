import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordServerEvent, withServerRecorderSnapshot } from "../src/servers/recorder.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "crabline-recorder-snapshot-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("server recorder snapshots", () => {
  it("blocks a later append until the snapshot read reaches a record boundary", async () => {
    const directory = await createTemporaryDirectory();
    const recorderPath = path.join(directory, "provider.jsonl");
    await writeFile(recorderPath, "", { mode: 0o600 });

    let enterSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enterSnapshot = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });

    const snapshot = withServerRecorderSnapshot({
      read: async () => {
        enterSnapshot();
        await snapshotReleased;
        return await readFile(recorderPath, "utf8");
      },
      recorderPath,
    });
    await snapshotEntered;

    let appendSettled = false;
    const append = recordServerEvent({
      event: {
        at: "2026-09-15T12:00:00.000Z",
        method: "GET",
        path: "/probe",
        query: {},
        type: "api",
      },
      onEvent: undefined,
      recorderPath,
    }).finally(() => {
      appendSettled = true;
    });

    await Promise.resolve();
    expect(appendSettled).toBe(false);
    releaseSnapshot();
    await expect(snapshot).resolves.toBe("");
    await append;

    const lines = (await readFile(recorderPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ path: "/probe" });
  });
});
