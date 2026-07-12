import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  drainRequestBody,
  parseUnknownRequestBody,
  readBody,
  readInteger,
  RequestBodyTooLargeError,
  startHttpJsonServer,
} from "../src/servers/http.js";

type TestRequest = IncomingMessage & PassThrough;

function createRequest(headers: IncomingMessage["headers"] = {}): TestRequest {
  return Object.assign(new PassThrough(), { headers }) as unknown as TestRequest;
}

function expectLateErrorHandled(request: IncomingMessage): void {
  expect(() => request.emit("error", new Error("late stream error"))).not.toThrow();
  request.emit("close");
  expect(request.listenerCount("error")).toBe(0);
}

describe("server HTTP body reader", () => {
  it("keeps rejected request streams error-handled until close", async () => {
    const aborted = createRequest();
    const abortedRead = readBody(aborted);
    aborted.emit("aborted");
    await expect(abortedRead).rejects.toThrow("Request body stream was aborted");
    expectLateErrorHandled(aborted);

    const streamed = createRequest();
    const streamedRead = readBody(streamed, 4);
    streamed.write("12345");
    await expect(streamedRead).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expectLateErrorHandled(streamed);

    const declared = createRequest({ "content-length": "5" });
    await expect(readBody(declared, 4)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expectLateErrorHandled(declared);

    const destroyed = createRequest();
    destroyed.destroy();
    drainRequestBody(destroyed);
    expect(() => destroyed.emit("error", new Error("post-destroy error"))).not.toThrow();
  });

  it("accepts only safe integer values", () => {
    expect(readInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(readInteger(String(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
    expect(readInteger(String(Number.MAX_SAFE_INTEGER + 1))).toBeUndefined();
    expect(readInteger("-9007199254740992")).toBeUndefined();
  });

  it("recognizes JSON media types case-insensitively", async () => {
    const request = createRequest({ "content-type": "Application/JSON; Charset=UTF-8" });
    const parsed = parseUnknownRequestBody(request);
    request.end('{"ok":true}');
    await expect(parsed).resolves.toEqual({ ok: true });
  });

  it("does not expose unexpected exception details", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        throw new Error("sensitive shared server detail");
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "internal server error",
        ok: false,
      });
    } finally {
      await server.close();
    }
  });
});
