import { appendFile, open, rename, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRecordedInbound,
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

      setTimeout(() => {
        void appendFile(filePath, `${tail.slice(splitAt)}\n`, "utf8");
      }, 25);

      await expect(waitPromise).resolves.toMatchObject({
        id: "evt-tail",
        text: "completed tail",
      });
      const fileSize = Buffer.byteLength(`${history}${tail}\n`);
      expect(bytesRead).toBeGreaterThanOrEqual(fileSize);
      expect(bytesRead).toBeLessThan(fileSize * 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
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

    setTimeout(() => {
      const replacementPath = `${filePath}.replacement`;
      void writeFile(
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
      ).then(() => rename(replacementPath, filePath));
    }, 25);

    await expect(waitPromise).resolves.toMatchObject({
      id: "after-replacement",
      threadId: "slack:C123",
    });
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

    setTimeout(() => {
      void writeFile(
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
      );
    }, 25);

    await expect(waitPromise).resolves.toMatchObject({
      id: "after-truncate",
      threadId: "slack:C123",
    });
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
