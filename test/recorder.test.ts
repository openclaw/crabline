import {
  appendFile,
  chmod,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRecordedInbound,
  appendRecordedInboundBatch,
  cloneRecordedInboundCursor,
  createRecordedInboundCursor,
  readRecordedInbound,
  waitForRecordedInbound,
  watchRecordedInbound,
} from "../src/providers/recorder.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createRecorderPath(): Promise<string> {
  const directory = await createTempDir();
  directories.push(directory);
  return path.join(directory, "inbound.jsonl");
}

function runAfterDelay<T>(operation: () => Promise<T>, delayMs = 25): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      void operation().then(resolve, reject);
    }, delayMs);
  });
}

describe("recorder", () => {
  it("returns an empty list for a missing recorder file", async () => {
    const filePath = await createRecorderPath();
    await expect(readRecordedInbound(filePath)).resolves.toEqual([]);
  });

  it("does not create a recorder for an empty batch", async () => {
    const filePath = await createRecorderPath();
    await expect(appendRecordedInboundBatch(filePath, [])).resolves.toEqual([]);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends and reads recorded inbound events", async () => {
    const filePath = await createRecorderPath();

    await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "evt-1",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "hello",
      threadId: "slack:C123",
    });

    const events = await readRecordedInbound(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]?.recordedAt).toBeTypeOf("string");
    expect(events[0]?.text).toBe("hello");
  });

  it.skipIf(process.platform === "win32")(
    "creates owner-only recorder files without changing existing permissions",
    async () => {
      const filePath = await createRecorderPath();
      const event = {
        author: "assistant" as const,
        id: "private-recorder",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "private",
        threadId: "slack:C123",
      };

      await appendRecordedInbound(filePath, event);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);

      await chmod(filePath, 0o640);
      await appendRecordedInbound(filePath, { ...event, id: "preserve-mode" });
      expect((await stat(filePath)).mode & 0o777).toBe(0o640);
    },
  );

  it("round-trips empty message text", async () => {
    const filePath = await createRecorderPath();
    const recorded = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "empty-text",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "",
      threadId: "slack:C123",
    });

    await expect(readRecordedInbound(filePath)).resolves.toEqual([recorded]);
  });

  it("rejects an oversized single append before it reaches the recorder", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "assistant" as const,
      id: "oversized-single",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "x".repeat(4 * 1024 * 1024),
      threadId: "slack:C123",
    };

    await expect(appendRecordedInbound(filePath, event)).rejects.toThrow(
      "Recorder record exceeded",
    );
    await expect(
      appendRecordedInbound(filePath, { ...event, id: "after-oversized", text: "small" }),
    ).resolves.toMatchObject({ id: "after-oversized" });
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "after-oversized" }),
    ]);
  });

  it("deduplicates inbound and outbound directions independently", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const sentAt = new Date().toISOString();
    const base = {
      id: "same-id",
      provider: "slack",
      sentAt,
      threadId: "slack:C123",
    };
    const outbound = await appendRecordedInbound(filePath, {
      ...base,
      author: "user",
      recordedDirection: "outbound",
      text: "outbound",
    });
    const inbound = await appendRecordedInbound(filePath, {
      ...base,
      author: "assistant",
      recordedDirection: "inbound",
      text: "inbound",
    });

    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(outbound);
    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(inbound);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => true,
        recordedDirection: "inbound",
        timeoutMs: 30,
      }),
    ).resolves.toEqual(inbound);
  });

  it("clears cursor deduplication when the recorder generation changes", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const event = {
      author: "assistant" as const,
      id: "reused-after-rotation",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first generation",
      threadId: "slack:C123",
    };
    await appendRecordedInbound(filePath, event);
    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toMatchObject({ text: "first generation" });

    await rename(filePath, `${filePath}.old`);
    await appendRecordedInbound(filePath, { ...event, text: "second generation" });

    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toMatchObject({ text: "second generation" });
  });

  it("runtime-validates parsed recorder envelopes", async () => {
    const filePath = await createRecorderPath();
    await writeFile(
      filePath,
      `${JSON.stringify({
        author: "assistant",
        id: "invalid-envelope",
        provider: "slack",
        recordedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        text: 42,
        threadId: "slack:C123",
      })}\n`,
      "utf8",
    );

    await expect(readRecordedInbound(filePath)).rejects.toThrow(/envelope text must be a string/u);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/envelope text must be a string/u);
  });

  it("appends retry-idempotent batches without partial duplicates", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const batch = [
      {
        author: "user" as const,
        id: "evt-batch-1",
        provider: "whatsapp",
        sentAt,
        text: "first",
        threadId: "15551234567",
      },
      {
        author: "user" as const,
        id: "evt-batch-2",
        provider: "whatsapp",
        sentAt,
        text: "second",
        threadId: "15551234567",
      },
    ];

    const results = await Promise.all([
      appendRecordedInboundBatch(filePath, batch),
      appendRecordedInboundBatch(filePath, batch),
    ]);
    expect(results.map((result) => result.length).toSorted()).toEqual([0, 2]);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "evt-batch-1" }),
      expect.objectContaining({ id: "evt-batch-2" }),
    ]);
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      events: [{ id: "evt-batch-1" }, { id: "evt-batch-2" }],
      recordType: "crabline.recorder.batch",
      recorderBatchVersion: 1,
    });
  });

  it("deduplicates a valid recorder tail that is missing its final newline", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = {
      author: "user" as const,
      id: "unterminated-retry",
      provider: "whatsapp",
      sentAt,
      text: "retry",
      threadId: "15551234567",
    };
    await writeFile(
      filePath,
      JSON.stringify({
        ...event,
        recordedAt: sentAt,
      }),
      "utf8",
    );

    await expect(appendRecordedInboundBatch(filePath, [event])).resolves.toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(
      `${JSON.stringify({ ...event, recordedAt: sentAt })}\n`,
    );
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "unterminated-retry" }),
    ]);
  });

  it("rejects a complete invalid recorder tail instead of sealing it", async () => {
    const filePath = await createRecorderPath();
    const invalidTail = JSON.stringify({
      author: "assistant",
      id: "invalid-tail",
      provider: "slack",
      recordedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      text: 42,
      threadId: "slack:C123",
    });
    await writeFile(filePath, invalidTail, "utf8");

    await expect(
      appendRecordedInbound(filePath, {
        author: "assistant",
        id: "after-invalid-tail",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "must not append",
        threadId: "slack:C123",
      }),
    ).rejects.toThrow(/envelope text must be a string/u);
    expect(await readFile(filePath, "utf8")).toBe(invalidTail);
  });

  it("rejects a batch record larger than the incremental reader limit", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "user" as const,
      id: "oversized-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "x".repeat(4 * 1024 * 1024),
      threadId: "15551234567",
    };

    await expect(appendRecordedInboundBatch(filePath, [event])).rejects.toThrow(
      "Recorder record exceeded",
    );
    await expect(
      appendRecordedInboundBatch(filePath, [{ ...event, id: "after-oversized", text: "small" }]),
    ).resolves.toEqual([expect.objectContaining({ id: "after-oversized" })]);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "after-oversized" }),
    ]);
  });

  it("hides partial batch appends before retrying", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: id,
      threadId: "15551234567",
    });
    await appendRecordedInboundBatch(filePath, [event("existing")]);

    const probeHandle = await open(filePath, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      writeFile(data: string, encoding: BufferEncoding): Promise<void>;
    };
    await probeHandle.close();
    const originalWriteFile = fileHandlePrototype.writeFile;
    const partialAppendError = Object.assign(new Error("simulated partial append"), {
      code: "ENOSPC",
    });
    let failNextWrite = true;
    let releasePartialWrite!: () => void;
    let reportPartialWrite!: () => void;
    const partialWriteReported = new Promise<void>((resolve) => {
      reportPartialWrite = resolve;
    });
    const partialWriteReleased = new Promise<void>((resolve) => {
      releasePartialWrite = resolve;
    });
    fileHandlePrototype.writeFile = async function (
      this: FileHandle,
      data: string,
      encoding: BufferEncoding,
    ) {
      if (failNextWrite) {
        failNextWrite = false;
        await originalWriteFile.call(this, data.slice(0, Math.ceil(data.length / 2)), encoding);
        reportPartialWrite();
        await partialWriteReleased;
        throw partialAppendError;
      }
      await originalWriteFile.call(this, data, encoding);
    };

    const batch = [event("retry-1"), event("retry-2")];
    const failedAppend = appendRecordedInboundBatch(filePath, batch);
    try {
      await partialWriteReported;
      await expect(readRecordedInbound(filePath)).resolves.toEqual([
        expect.objectContaining({ id: "existing" }),
      ]);
      releasePartialWrite();
      await expect(failedAppend).rejects.toMatchObject({
        cause: partialAppendError,
        committed: true,
        indeterminate: true,
        name: "ProviderRecorderCommittedError",
      });
    } finally {
      releasePartialWrite();
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    await expect(appendRecordedInboundBatch(filePath, batch)).resolves.toEqual([
      expect.objectContaining({ id: "retry-1" }),
      expect.objectContaining({ id: "retry-2" }),
    ]);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "existing" }),
      expect.objectContaining({ id: "retry-1" }),
      expect.objectContaining({ id: "retry-2" }),
    ]);
  });

  it("retries a batch against a recorder rotated during append", async () => {
    const filePath = await createRecorderPath();
    const rotatedPath = `${filePath}.rotated`;
    const event = {
      author: "user" as const,
      id: "rotated-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "preserve both generations",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [{ ...event, id: "existing", text: "existing" }]);

    const probeHandle = await open(filePath, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      writeFile(data: string, encoding: BufferEncoding): Promise<void>;
    };
    await probeHandle.close();
    const originalWriteFile = fileHandlePrototype.writeFile;
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptBatch = true;
    fileHandlePrototype.writeFile = async function (
      this: FileHandle,
      data: string,
      encoding: BufferEncoding,
    ) {
      await originalWriteFile.call(this, data, encoding);
      if (interceptBatch && data.includes('"recorderBatchVersion"')) {
        interceptBatch = false;
        reportWrite();
        await writeReleased;
      }
    };

    const append = appendRecordedInboundBatch(filePath, [event]);
    try {
      await writeReported;
      await rename(filePath, rotatedPath);
      await writeFile(filePath, "", "utf8");
      releaseWrite();
      await expect(append).resolves.toEqual([expect.objectContaining({ id: "rotated-batch" })]);
    } finally {
      releaseWrite();
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "rotated-batch" }),
    ]);
    await expect(readRecordedInbound(rotatedPath)).resolves.toEqual([
      expect.objectContaining({ id: "existing" }),
      expect.objectContaining({ id: "rotated-batch" }),
    ]);
  });

  it("retries a single append against a recorder rotated during append", async () => {
    const filePath = await createRecorderPath();
    const rotatedPath = `${filePath}.rotated`;
    const event = {
      author: "assistant" as const,
      id: "rotated-single",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "preserve both generations",
      threadId: "slack:C123",
    };

    const probeHandle = await open(filePath, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      writeFile(data: string, encoding: BufferEncoding): Promise<void>;
    };
    await probeHandle.close();
    const originalWriteFile = fileHandlePrototype.writeFile;
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptAppend = true;
    fileHandlePrototype.writeFile = async function (
      this: FileHandle,
      data: string,
      encoding: BufferEncoding,
    ) {
      await originalWriteFile.call(this, data, encoding);
      if (interceptAppend && data.includes('"id":"rotated-single"')) {
        interceptAppend = false;
        reportWrite();
        await writeReleased;
      }
    };

    const append = appendRecordedInbound(filePath, event);
    try {
      await writeReported;
      await rename(filePath, rotatedPath);
      await writeFile(filePath, "", "utf8");
      releaseWrite();
      await expect(append).resolves.toMatchObject({ id: event.id });
    } finally {
      releaseWrite();
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
    await expect(readRecordedInbound(rotatedPath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("retries against a symlinked recorder retargeted during append", async () => {
    const filePath = await createRecorderPath();
    const firstTarget = path.join(path.dirname(filePath), "first-target.jsonl");
    const secondTarget = path.join(path.dirname(filePath), "second-target.jsonl");
    await writeFile(firstTarget, "", "utf8");
    await writeFile(secondTarget, "", "utf8");
    await symlink(firstTarget, filePath, "file");
    const event = {
      author: "user" as const,
      id: "symlink-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "detect retargeting",
      threadId: "15551234567",
    };

    const probeHandle = await open(firstTarget, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      writeFile(data: string, encoding: BufferEncoding): Promise<void>;
    };
    await probeHandle.close();
    const originalWriteFile = fileHandlePrototype.writeFile;
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptBatch = true;
    fileHandlePrototype.writeFile = async function (
      this: FileHandle,
      data: string,
      encoding: BufferEncoding,
    ) {
      await originalWriteFile.call(this, data, encoding);
      if (interceptBatch && data.includes('"recorderBatchVersion"')) {
        interceptBatch = false;
        reportWrite();
        await writeReleased;
      }
    };

    const append = appendRecordedInboundBatch(filePath, [event]);
    try {
      await writeReported;
      await rm(filePath);
      await symlink(secondTarget, filePath, "file");
      releaseWrite();
      await expect(append).resolves.toEqual([expect.objectContaining({ id: "symlink-batch" })]);
    } finally {
      releaseWrite();
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "symlink-batch" }),
    ]);
    await expect(readRecordedInbound(firstTarget)).resolves.toEqual([
      expect.objectContaining({ id: "symlink-batch" }),
    ]);
  });

  it("serializes the first batch through a dangling recorder symlink", async () => {
    const filePath = await createRecorderPath();
    const targetPath = path.join(path.dirname(filePath), "dangling-target.jsonl");
    await symlink(targetPath, filePath, "file");
    const event = {
      author: "user" as const,
      id: "dangling-symlink-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "deduplicate the first concurrent append",
      threadId: "15551234567",
    };

    const probeHandle = await open(path.dirname(filePath), "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      writeFile(data: string, encoding: BufferEncoding): Promise<void>;
    };
    await probeHandle.close();
    const originalWriteFile = fileHandlePrototype.writeFile;
    let releaseFirstWrite!: () => void;
    let reportFirstWrite!: () => void;
    const firstWriteReported = new Promise<void>((resolve) => {
      reportFirstWrite = resolve;
    });
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let pauseFirstBatch = true;
    fileHandlePrototype.writeFile = async function (
      this: FileHandle,
      data: string,
      encoding: BufferEncoding,
    ) {
      if (pauseFirstBatch && data.includes('"recorderBatchVersion"')) {
        pauseFirstBatch = false;
        reportFirstWrite();
        await firstWriteReleased;
      }
      await originalWriteFile.call(this, data, encoding);
    };

    const first = appendRecordedInboundBatch(filePath, [event]);
    try {
      await firstWriteReported;
      const second = appendRecordedInboundBatch(filePath, [event]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseFirstWrite();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.length).toSorted()).toEqual([0, 1]);
    } finally {
      releaseFirstWrite();
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("deduplicates concurrent batches through real and symlink aliases", async () => {
    const filePath = await createRecorderPath();
    const aliasPath = `${filePath}.alias`;
    await writeFile(filePath, "", "utf8");
    await symlink(filePath, aliasPath, "file");
    const event = {
      author: "user" as const,
      id: "alias-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "one logical recorder",
      threadId: "15551234567",
    };

    const results = await Promise.all([
      appendRecordedInboundBatch(filePath, [event]),
      appendRecordedInboundBatch(aliasPath, [event]),
    ]);

    expect(results.flat()).toHaveLength(1);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("repairs an interrupted recorder tail before publishing a batch", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: id,
      threadId: "15551234567",
    });
    await appendRecordedInboundBatch(filePath, [event("existing")]);
    await appendFile(filePath, '{"id":"interrupted"', "utf8");

    await appendRecordedInboundBatch(filePath, [event("after-recovery")]);

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "existing" }),
      expect.objectContaining({ id: "after-recovery" }),
    ]);
  });

  it("bounds batch identity memory to a recent retry window", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: id,
      threadId: "15551234567",
    });
    const history = Array.from({ length: 4097 }, (_, index) => event(`history-${index}`));

    await expect(appendRecordedInboundBatch(filePath, history)).resolves.toHaveLength(
      history.length,
    );
    await expect(appendRecordedInboundBatch(filePath, [history[0]!])).resolves.toHaveLength(1);
    await expect(appendRecordedInboundBatch(filePath, [history.at(-1)!])).resolves.toEqual([]);
  });

  it("indexes batch identities without rescanning completed recorder history", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: "x".repeat(128),
      threadId: "15551234567",
    });
    await appendRecordedInboundBatch(
      filePath,
      Array.from({ length: 64 }, (_, index) => event(`history-${index}`)),
    );
    await appendRecordedInboundBatch(filePath, [event("tail-1")]);

    const handle = await open(filePath, "r+");
    try {
      await handle.write("!", 0, "utf8");
    } finally {
      await handle.close();
    }

    await expect(appendRecordedInboundBatch(filePath, [event("tail-2")])).resolves.toEqual([
      expect.objectContaining({ id: "tail-2" }),
    ]);
    expect(await readFile(filePath, "utf8")).toContain('"id":"tail-2"');
  });

  it("resets batch identities when the recorder is replaced", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "user" as const,
      id: "reused-after-rotation",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "accepted in each recorder generation",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [event]);
    await rename(filePath, `${filePath}.old`);
    await writeFile(filePath, "", "utf8");

    await expect(appendRecordedInboundBatch(filePath, [event])).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("rebuilds batch identities when a replacement preserves the consumed prefix", async () => {
    const filePath = await createRecorderPath();
    const replacementPath = `${filePath}.replacement`;
    const event = {
      author: "user" as const,
      id: "same-prefix-replacement",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "deduplicate after inode replacement",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [event]);
    const contents = await readFile(filePath, "utf8");
    await writeFile(replacementPath, contents, "utf8");
    await rename(replacementPath, filePath);

    await expect(appendRecordedInboundBatch(filePath, [event])).resolves.toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(contents);
  });

  it("retries duplicate suppression when the recorder rotates during indexing", async () => {
    const filePath = await createRecorderPath();
    const rotatedPath = `${filePath}.old`;
    const event = {
      author: "user" as const,
      id: "duplicate-during-rotation",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "preserve the acknowledged event",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [event]);

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      stat(...args: unknown[]): Promise<unknown>;
    };
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    let statCalls = 0;
    let releaseIndexStat!: () => void;
    let reportIndexStat!: () => void;
    const indexStatReported = new Promise<void>((resolve) => {
      reportIndexStat = resolve;
    });
    const indexStatReleased = new Promise<void>((resolve) => {
      releaseIndexStat = resolve;
    });
    fileHandlePrototype.stat = async function (...args: unknown[]) {
      const stats = await Reflect.apply(originalStat, this, args);
      if (++statCalls === 3) {
        reportIndexStat();
        await indexStatReleased;
      }
      return stats;
    };

    const append = appendRecordedInboundBatch(filePath, [event]);
    try {
      await indexStatReported;
      await rename(filePath, rotatedPath);
      await writeFile(filePath, "", "utf8");
      releaseIndexStat();
      await expect(append).resolves.toEqual([expect.objectContaining({ id: event.id })]);
    } finally {
      releaseIndexStat();
      fileHandlePrototype.stat = originalStat;
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("keeps valid events when the final record is truncated", async () => {
    const filePath = await createRecorderPath();
    const recorded = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "evt-valid",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "keep me",
      threadId: "slack:C123",
    });
    await appendFile(filePath, '{"id":"evt-truncated"', "utf8");

    await expect(readRecordedInbound(filePath)).resolves.toEqual([recorded]);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: (event) => event.id === "evt-valid",
        timeoutMs: 30,
      }),
    ).resolves.toEqual(recorded);

    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.id === "evt-valid",
      pollMs: 10,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: recorded,
    });
  });

  it("reads a valid final record without a trailing newline", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "assistant",
      id: "evt-final",
      provider: "slack",
      recordedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      text: "complete",
      threadId: "slack:C123",
    } as const;
    await writeFile(filePath, JSON.stringify(event), "utf8");

    await expect(readRecordedInbound(filePath)).resolves.toEqual([event]);
  });

  it("rejects a malformed final record once it is newline terminated", async () => {
    const filePath = await createRecorderPath();
    await appendFile(filePath, '{"id":"malformed"} trailing\n', "utf8");

    await expect(readRecordedInbound(filePath)).rejects.toThrow(SyntaxError);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(SyntaxError);

    const iterator = watchRecordedInbound({
      filePath,
      matches: () => true,
      pollMs: 10,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(SyntaxError);
  });

  it("does not hide a completed malformed record behind a blank tail", async () => {
    const filePath = await createRecorderPath();
    await appendFile(filePath, '{"id":"malformed"} trailing\n   ', "utf8");

    await expect(readRecordedInbound(filePath)).rejects.toThrow(SyntaxError);
  });

  it("does not advance an incremental cursor past a malformed completed partial record", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const partial = '{"author":"assistant"';
    await writeFile(filePath, partial, "utf8");

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => false,
        pollMs: 5,
        timeoutMs: 15,
      }),
    ).resolves.toBeNull();
    const beforeFailure = cloneRecordedInboundCursor(cursor);

    const recovered = {
      author: "assistant",
      id: "recovered-after-malformed",
      provider: "slack",
      recordedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      text: "recover me",
      threadId: "slack:C123",
    } as const;
    await appendFile(filePath, ` trailing\n${JSON.stringify(recovered)}\n`, "utf8");

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(SyntaxError);
    expect(cursor).toEqual(beforeFailure);

    await writeFile(filePath, `${JSON.stringify(recovered)}\n`, "utf8");
    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).resolves.toEqual(recovered);
  });

  it("waits for a matching inbound event", async () => {
    const filePath = await createRecorderPath();
    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.threadId === "slack:C123",
      timeoutMs: 500,
    });

    const append = runAfterDelay(() =>
      appendRecordedInbound(filePath, {
        author: "assistant",
        id: "evt-2",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "match me",
        threadId: "slack:C123",
      }),
    );

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-2",
      text: "match me",
    });
    await append;
  });

  it("retains unread events when a cursor returns an earlier match", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const first = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "first",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "slack:C123",
    });
    const second = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "second",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "slack:C123",
    });

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).resolves.toEqual(first);
    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).resolves.toEqual(second);
  });

  it("deduplicates recent appended retries without rescanning consumed records", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const duplicate = {
      author: "assistant" as const,
      id: "duplicate",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "duplicate",
      threadId: "slack:C123",
    };
    const first = await appendRecordedInbound(filePath, duplicate);
    await appendRecordedInbound(filePath, duplicate);
    const next = await appendRecordedInbound(filePath, { ...duplicate, id: "next", text: "next" });

    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(first);
    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(next);
  });

  it("retains incremental wait progress across large recorder histories", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const now = new Date().toISOString();
    const eventCount = 4100;
    await writeFile(
      filePath,
      Array.from(
        { length: eventCount },
        (_, index) =>
          `${JSON.stringify({
            author: "assistant",
            id: `bounded-${index}`,
            provider: "slack",
            recordedAt: now,
            sentAt: now,
            text: "bounded",
            threadId: "slack:C123",
          })}\n`,
      ).join(""),
      "utf8",
    );

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: (event) => event.id === `bounded-${eventCount - 1}`,
        timeoutMs: 30,
      }),
    ).resolves.toMatchObject({ id: `bounded-${eventCount - 1}` });
    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: (event) => event.id === `bounded-${eventCount - 1}`,
        timeoutMs: 30,
      }),
    ).resolves.toBeNull();
  });

  it("does not collapse distinct records whose fields contain delimiters", async () => {
    const filePath = await createRecorderPath();
    await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "c",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "a:b",
    });
    const expected = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "b:c",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "a",
    });

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: (event) => event.text === "second",
        timeoutMs: 30,
      }),
    ).resolves.toEqual(expected);
  });

  it("times out when no matching event arrives", async () => {
    const filePath = await createRecorderPath();

    await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "evt-old",
      provider: "slack",
      sentAt: new Date(Date.now() - 10_000).toISOString(),
      text: "too old",
      threadId: "slack:C123",
    });

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: (event) => event.threadId === "slack:C123",
        since: new Date().toISOString(),
        timeoutMs: 30,
      }),
    ).resolves.toBeNull();
  });

  it("does not sleep past the polling timeout", async () => {
    const filePath = await createRecorderPath();
    const startedAt = Date.now();

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => false,
        pollMs: 1000,
        timeoutMs: 40,
      }),
    ).resolves.toBeNull();

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("reads only appended bytes while waiting and preserves a partial record", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    const history = Array.from(
      { length: 1000 },
      (_, index) =>
        `${JSON.stringify({
          author: "user",
          id: `history-${index}`,
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "history",
          threadId: "slack:C999",
        })}\n`,
    ).join("");
    const tail = JSON.stringify({
      author: "assistant",
      id: "evt-tail",
      provider: "slack",
      recordedAt: now,
      sentAt: now,
      text: "completed tail",
      threadId: "slack:C123",
    });
    const splitAt = Math.floor(tail.length / 2);
    await appendFile(filePath, history + tail.slice(0, splitAt), "utf8");

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let bytesRead = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };

    try {
      const waitPromise = waitForRecordedInbound({
        filePath,
        matches: (event) => event.id === "evt-tail",
        pollMs: 10,
        timeoutMs: 500,
      });

      const append = runAfterDelay(() => appendFile(filePath, `${tail.slice(splitAt)}\n`, "utf8"));

      await expect(waitPromise).resolves.toMatchObject({
        id: "evt-tail",
        text: "completed tail",
      });
      await append;
      const fileSize = Buffer.byteLength(`${history}${tail}\n`);
      expect(bytesRead).toBeGreaterThanOrEqual(fileSize);
      expect(bytesRead).toBeLessThan(fileSize * 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });

  it("bounds unread recorder batches before returning an early match", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    const contents = Array.from(
      { length: 20_000 },
      (_, index) =>
        `${JSON.stringify({
          author: "assistant",
          id: `event-${index}`,
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "x".repeat(64),
          threadId: "slack:C123",
        })}\n`,
    ).join("");
    await writeFile(filePath, contents, "utf8");

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let bytesRead = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };

    try {
      await expect(
        waitForRecordedInbound({
          filePath,
          matches: (event) => event.id === "event-0",
          timeoutMs: 30,
        }),
      ).resolves.toMatchObject({ id: "event-0" });
      expect(bytesRead).toBeLessThan(Buffer.byteLength(contents) / 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });

  it("bounds unterminated recorder records", async () => {
    const filePath = await createRecorderPath();
    await writeFile(filePath, "x".repeat(4 * 1024 * 1024 + 1), "utf8");

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => false,
        pollMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/exceeded 4194304 bytes without a newline/u);
  });

  it("resets incremental reads when the recorder is atomically replaced", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    await writeFile(
      filePath,
      `${JSON.stringify({
        author: "user",
        id: "before-replacement",
        provider: "slack",
        recordedAt: now,
        sentAt: now,
        text: "old recorder",
        threadId: "slack:C999",
      })}\n`,
      "utf8",
    );

    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.id === "after-replacement",
      pollMs: 10,
      timeoutMs: 500,
    });

    const replace = runAfterDelay(async () => {
      const replacementPath = `${filePath}.replacement`;
      await writeFile(
        replacementPath,
        `${JSON.stringify({
          author: "assistant",
          id: "after-replacement",
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "new recorder".repeat(20),
          threadId: "slack:C123",
        })}\n`,
        "utf8",
      );
      await rename(replacementPath, filePath);
    });

    await expect(waitPromise).resolves.toMatchObject({
      id: "after-replacement",
      threadId: "slack:C123",
    });
    await replace;
  });

  it("preserves the offset when atomic replacement retains recorder history", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    const history = Array.from(
      { length: 4097 },
      (_, index) =>
        `${JSON.stringify({
          author: "assistant",
          id: `history-${index}`,
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "history",
          threadId: "slack:C123",
        })}\n`,
    ).join("");
    await writeFile(filePath, history, "utf8");

    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.id === "history-4096" || event.id === "after-history-replacement",
      pollMs: 10,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: "history-4096" },
    });

    const replacementPath = `${filePath}.replacement`;
    await writeFile(
      replacementPath,
      `${history}${JSON.stringify({
        author: "assistant",
        id: "after-history-replacement",
        provider: "slack",
        recordedAt: now,
        sentAt: now,
        text: "new tail",
        threadId: "slack:C123",
      })}\n`,
      "utf8",
    );
    await rename(replacementPath, filePath);

    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: "after-history-replacement" },
    });
    await iterator.return?.();
  });

  it("resets partial state when a recorder is truncated and regrown past the offset", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    await writeFile(
      filePath,
      `${JSON.stringify({
        author: "user",
        id: "before-truncate",
        provider: "slack",
        recordedAt: now,
        sentAt: now,
        text: "old recorder",
        threadId: "slack:C999",
      })}\n{"id":"stale-partial"`,
      "utf8",
    );

    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.id === "after-truncate",
      pollMs: 10,
      timeoutMs: 500,
    });

    const truncate = runAfterDelay(() =>
      writeFile(
        filePath,
        `${JSON.stringify({
          author: "assistant",
          id: "after-truncate",
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "regrown recorder".repeat(20),
          threadId: "slack:C123",
        })}\n`,
        "utf8",
      ),
    );

    await expect(waitPromise).resolves.toMatchObject({
      id: "after-truncate",
      threadId: "slack:C123",
    });
    await truncate;
  });

  it("streams new inbound events", async () => {
    const filePath = await createRecorderPath();
    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.provider === "slack",
      pollMs: 10,
    })[Symbol.asyncIterator]();

    const append = runAfterDelay(() =>
      appendRecordedInbound(filePath, {
        author: "user",
        id: "evt-3",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "tail me",
        threadId: "slack:C999",
      }),
    );

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.id).toBe("evt-3");
    await append;
  });

  it("stops before yielding buffered events after abort", async () => {
    const filePath = await createRecorderPath();
    await appendRecordedInbound(filePath, {
      author: "user",
      id: "evt-buffered-1",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "slack:C999",
    });
    await appendRecordedInbound(filePath, {
      author: "user",
      id: "evt-buffered-2",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "slack:C999",
    });
    const controller = new AbortController();
    const iterator = watchRecordedInbound({
      filePath,
      matches: () => true,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "evt-buffered-1" },
    });
    controller.abort();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("reads only appended records while watching a large recorder", async () => {
    const filePath = await createRecorderPath();
    const history = Array.from(
      { length: 1000 },
      (_, index) =>
        `${JSON.stringify({
          author: "user",
          id: `history-${index}`,
          provider: "slack",
          recordedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          text: "history",
          threadId: "slack:C999",
        })}\n`,
    ).join("");
    await appendFile(filePath, history, "utf8");

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let bytesRead = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };

    try {
      const iterator = watchRecordedInbound({
        filePath,
        matches: (event) => event.id === "evt-tail",
        pollMs: 10,
      })[Symbol.asyncIterator]();

      const append = runAfterDelay(() =>
        appendRecordedInbound(filePath, {
          author: "user",
          id: "evt-tail",
          provider: "slack",
          sentAt: new Date().toISOString(),
          text: "tail me",
          threadId: "slack:C999",
        }),
      );

      const next = await iterator.next();
      expect(next.value?.id).toBe("evt-tail");
      await append;
      expect(bytesRead).toBeGreaterThanOrEqual(Buffer.byteLength(history));
      expect(bytesRead).toBeLessThan(Buffer.byteLength(history) * 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });
});
