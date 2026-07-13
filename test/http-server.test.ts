import { get, type IncomingMessage } from "node:http";
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

  it("accepts structured JSON suffixes without matching arbitrary json substrings", async () => {
    const structured = createRequest({ "content-type": "application/problem+json; charset=utf-8" });
    const structuredParsed = parseUnknownRequestBody(structured);
    structured.end('{"ok":true}');
    await expect(structuredParsed).resolves.toEqual({ ok: true });

    const extendedRequest = createRequest({
      "content-type": "application/vnd.acme~event+json",
    });
    const extendedParsed = parseUnknownRequestBody(extendedRequest);
    extendedRequest.end('{"extended":true}');
    await expect(extendedParsed).resolves.toEqual({ extended: true });

    const arbitrary = createRequest({ "content-type": "text/notjson" });
    const arbitraryParsed = parseUnknownRequestBody(arbitrary);
    arbitrary.end("value=%7B%22ok%22%3Atrue%7D");
    await expect(arbitraryParsed).resolves.toEqual({ value: '{"ok":true}' });
  });

  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "[::1]"],
  ])("advertises loopback while preserving the %s wildcard bind", async (host, advertisedHost) => {
    const server = await startHttpJsonServer({
      async handle() {
        return Response.json({ ok: true });
      },
      host,
      port: 0,
      serverName: "test",
    });

    try {
      expect(new URL(server.baseUrl).hostname).toBe(advertisedHost);
      const address = server.server.address();
      expect(address).not.toBeNull();
      expect(typeof address).not.toBe("string");
      expect(typeof address === "string" || address === null ? undefined : address.address).toBe(
        host,
      );
      await expect(fetch(server.baseUrl).then((response) => response.json())).resolves.toEqual({
        ok: true,
      });
    } finally {
      await server.close();
    }
  });

  it("owns buffered response framing instead of trusting caller Content-Length", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        return new Response("complete", {
          headers: { "content-length": "1024" },
        });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl, { signal: AbortSignal.timeout(1_000) });
      expect(response.headers.get("content-length")).toBe("8");
      await expect(response.text()).resolves.toBe("complete");
    } finally {
      await server.close();
    }
  });

  it("removes trailer metadata when replacing transfer framing", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        return new Response("complete", {
          headers: {
            trailer: "x-checksum",
            "transfer-encoding": "chunked",
          },
        });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl);
      expect(response.headers.get("trailer")).toBeNull();
      expect(response.headers.get("content-length")).toBe("8");
      await expect(response.text()).resolves.toBe("complete");
    } finally {
      await server.close();
    }
  });

  it("preserves representation length metadata for HEAD responses", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        return new Response(null, {
          headers: { "content-length": "8" },
        });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl, { method: "HEAD" });
      expect(response.headers.get("content-length")).toBe("8");
      await expect(response.text()).resolves.toBe("");
    } finally {
      await server.close();
    }
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

  it("contains failures from custom error handlers", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        throw new Error("request failure");
      },
      handleError() {
        throw new Error("error handler failure");
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

  it("buffers response bodies before staging status and headers", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("response body failed"));
            },
          }),
          { headers: { "x-uncommitted": "true" }, status: 201 },
        );
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl);
      expect(response.status).toBe(500);
      expect(response.headers.get("x-uncommitted")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: "internal server error",
        ok: false,
      });
    } finally {
      await server.close();
    }
  });

  it("preserves repeated Set-Cookie response headers", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        const headers = new Headers();
        headers.append("set-cookie", "first=1; Path=/");
        headers.append("set-cookie", "second=2; Path=/");
        return new Response(null, { headers });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl);
      expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
    } finally {
      await server.close();
    }
  });

  it("does not write a second response when a post-delivery callback fails", async () => {
    let errorHandlerCalls = 0;
    const server = await startHttpJsonServer({
      async handle() {
        return {
          onWriteSuccess() {
            throw new Error("post-commit failure");
          },
          response: Response.json({ ok: true }),
        };
      },
      handleError() {
        errorHandlerCalls++;
        return Response.json({ ok: false }, { status: 500 });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const first = await fetch(server.baseUrl);
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toEqual({ ok: true });
      const second = await fetch(server.baseUrl);
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({ ok: true });
      expect(errorHandlerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("reports response delivery failure to transactional handlers", async () => {
    let releaseHandler: (() => void) | undefined;
    let observeHandler: (() => void) | undefined;
    let observeAbort: (() => void) | undefined;
    const handlerObserved = new Promise<void>((resolve) => {
      observeHandler = resolve;
    });
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const requestAborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    let failed = 0;
    let succeeded = 0;
    const server = await startHttpJsonServer({
      async handle(request) {
        request.once("aborted", () => observeAbort?.());
        observeHandler?.();
        await handlerBlocked;
        return {
          onWriteFailure() {
            failed++;
          },
          onWriteSuccess() {
            succeeded++;
          },
          response: Response.json({ ok: true }),
        };
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const request = get(server.baseUrl);
      request.on("error", () => {});
      await handlerObserved;
      request.destroy();
      await requestAborted;
      releaseHandler?.();
      await expect.poll(() => failed).toBe(1);
      expect(succeeded).toBe(0);
    } finally {
      await server.close();
    }
  });
});
