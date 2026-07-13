import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { captureWrites, requestHttp, settleCleanup } from "./test-helpers.js";

describe("test helpers", () => {
  it("rejects incomplete HTTP responses", async () => {
    const response = Object.assign(new EventEmitter(), {
      complete: false,
      headers: {},
      statusCode: 200,
    });
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
      setTimeout: vi.fn(),
      write: vi.fn(),
    });
    const requestImpl = ((
      _url: string,
      _options: unknown,
      receive: (response: IncomingMessage) => void,
    ) => {
      queueMicrotask(() => {
        receive(response as IncomingMessage);
        response.emit("data", Buffer.from("partial"));
        response.emit("close");
      });
      return request as unknown as ClientRequest;
    }) as typeof httpRequest;

    await expect(
      requestHttp({
        method: "GET",
        requestImpl,
        url: "http://127.0.0.1/",
      }),
    ).rejects.toThrow("HTTP response closed before completion.");
  });

  it("starts the HTTP deadline before a socket is assigned", async () => {
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn((error: Error) => request.emit("error", error)),
      end: vi.fn(),
      setTimeout: vi.fn(),
      write: vi.fn(),
    });
    const requestImpl = (() => request as unknown as ClientRequest) as typeof httpRequest;

    await expect(
      requestHttp({
        method: "GET",
        requestImpl,
        timeoutMs: 10,
        url: "http://127.0.0.1/",
      }),
    ).rejects.toThrow("HTTP request timed out after 10 ms.");
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(request.setTimeout).not.toHaveBeenCalled();
  });

  it("preserves write overload callbacks while capturing output", async () => {
    const stdoutCallback = vi.fn();
    const stderrCallback = vi.fn();

    const captured = await captureWrites(async () => {
      process.stdout.write("text", "utf8", stdoutCallback);
      process.stderr.write(Buffer.from("bytes"), stderrCallback);
      await Promise.resolve();
    });

    expect(captured.stdout).toEqual(["text"]);
    expect(captured.stderr).toEqual(["bytes"]);
    expect(stdoutCallback).toHaveBeenCalledWith(null);
    expect(stderrCallback).toHaveBeenCalledWith(null);
  });

  it("restores the outer capture after a nested capture settles", async () => {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;

    const outer = await captureWrites(async () => {
      process.stdout.write("outer-before");
      const inner = await captureWrites(async () => {
        process.stdout.write("inner");
      });
      process.stdout.write("outer-after");
      return inner;
    });

    expect(outer.stdout).toEqual(["outer-before", "outer-after"]);
    expect(outer.result.stdout).toEqual(["inner"]);
    expect(process.stdout.write).toBe(stdoutWrite);
    expect(process.stderr.write).toBe(stderrWrite);
  });

  it("isolates overlapping asynchronous output captures", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const runCapture = (label: string, gate: Promise<void>) =>
      captureWrites(async () => {
        await gate;
        process.stdout.write(`${label}-stdout`);
        process.stderr.write(`${label}-stderr`);
      });

    try {
      const firstPromise = runCapture("first", firstGate);
      const secondPromise = runCapture("second", secondGate);
      process.stdout.write("parent-stdout");
      process.stderr.write("parent-stderr");
      releaseFirst();
      const first = await firstPromise;
      process.stdout.write("parent-after-first");
      releaseSecond();
      const second = await secondPromise;

      expect(first.stdout).toEqual(["first-stdout"]);
      expect(first.stderr).toEqual(["first-stderr"]);
      expect(second.stdout).toEqual(["second-stdout"]);
      expect(second.stderr).toEqual(["second-stderr"]);
      expect(stdoutWrite.mock.calls.map(([chunk]) => chunk)).toEqual([
        "parent-stdout",
        "parent-after-first",
      ]);
      expect(stderrWrite.mock.calls.map(([chunk]) => chunk)).toEqual(["parent-stderr"]);
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("runs every cleanup operation before reporting failures", async () => {
    const completed: string[] = [];

    const failure = await settleCleanup([
      Promise.reject(new Error("first cleanup failed")),
      Promise.resolve().then(() => {
        completed.push("second");
      }),
    ]).catch((error: unknown) => error);

    expect(failure).toEqual(new Error("first cleanup failed"));
    expect(completed).toEqual(["second"]);
  });
});
