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
