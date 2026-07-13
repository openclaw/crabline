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
    const captured = captureWrites();
    const stdoutCallback = vi.fn();
    const stderrCallback = vi.fn();

    try {
      process.stdout.write("text", "utf8", stdoutCallback);
      process.stderr.write(Buffer.from("bytes"), stderrCallback);
      await Promise.resolve();
    } finally {
      captured.restore();
    }

    expect(captured.stdout).toEqual(["text"]);
    expect(captured.stderr).toEqual(["bytes"]);
    expect(stdoutCallback).toHaveBeenCalledWith(null);
    expect(stderrCallback).toHaveBeenCalledWith(null);
  });

  it("restores nested output captures in either order", () => {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;

    for (const order of ["outer-first", "inner-first"] as const) {
      const outer = captureWrites();
      const inner = captureWrites();

      if (order === "outer-first") {
        outer.restore();
        inner.restore();
      } else {
        inner.restore();
        outer.restore();
      }

      expect(process.stdout.write).toBe(stdoutWrite);
      expect(process.stderr.write).toBe(stderrWrite);
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
