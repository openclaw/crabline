import { appendFile, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRecordedInbound,
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

describe("recorder", () => {
  it("returns an empty list for a missing recorder file", async () => {
    const filePath = await createRecorderPath();
    await expect(readRecordedInbound(filePath)).resolves.toEqual([]);
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

  it("waits for a matching inbound event", async () => {
    const filePath = await createRecorderPath();
    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.threadId === "slack:C123",
      timeoutMs: 500,
    });

    setTimeout(() => {
      void appendRecordedInbound(filePath, {
        author: "assistant",
        id: "evt-2",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "match me",
        threadId: "slack:C123",
      });
    }, 25);

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-2",
      text: "match me",
    });
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

  it("streams new inbound events", async () => {
    const filePath = await createRecorderPath();
    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.provider === "slack",
      pollMs: 10,
    })[Symbol.asyncIterator]();

    setTimeout(() => {
      void appendRecordedInbound(filePath, {
        author: "user",
        id: "evt-3",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "tail me",
        threadId: "slack:C999",
      });
    }, 25);

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.id).toBe("evt-3");
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

      setTimeout(() => {
        void appendRecordedInbound(filePath, {
          author: "user",
          id: "evt-tail",
          provider: "slack",
          sentAt: new Date().toISOString(),
          text: "tail me",
          threadId: "slack:C999",
        });
      }, 25);

      const next = await iterator.next();
      expect(next.value?.id).toBe("evt-tail");
      expect(bytesRead).toBeGreaterThanOrEqual(Buffer.byteLength(history));
      expect(bytesRead).toBeLessThan(Buffer.byteLength(history) * 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });
});
