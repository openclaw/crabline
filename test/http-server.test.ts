import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBody, RequestBodyTooLargeError } from "../src/servers/http.js";

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
  });
});
