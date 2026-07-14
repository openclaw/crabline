import { get, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  adminAuthError,
  ADMIN_TOKEN_HEADER,
  assertLoopbackBindAddress,
  constantTimeTokenEqual,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  drainRequestBody,
  hasAdminToken,
  InvalidJsonBodyError,
  isLoopbackAddress,
  isLoopbackHost,
  parseRequestBody,
  parseUnknownRequestBody,
  readBody,
  readInteger,
  RequestBodyTooLargeError,
  ResponseBodyTooLargeError,
  startHttpJsonServer,
  writeResponse,
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

describe("server admin authentication", () => {
  const expectedToken = "test-auth-token";
  const cases: Array<[string, IncomingMessage["headers"], boolean]> = [
    ["custom header", { [ADMIN_TOKEN_HEADER]: expectedToken }, true],
    ["Bearer authorization", { authorization: `Bearer ${expectedToken}` }, true],
    ["case-insensitive Bearer authorization", { authorization: `bEaReR ${expectedToken}` }, true],
    ["missing credentials", {}, false],
    ["incorrect token", { [ADMIN_TOKEN_HEADER]: "token-oversized" }, false],
    ["unequal token length", { [ADMIN_TOKEN_HEADER]: "dummy" }, false],
    ["malformed authorization", { authorization: `Basic ${expectedToken}` }, false],
    ["first duplicate header", { [ADMIN_TOKEN_HEADER]: [expectedToken, "wrong"] }, true],
    ["later duplicate header", { [ADMIN_TOKEN_HEADER]: ["wrong", expectedToken] }, false],
  ];

  it.each(cases)("handles %s", (_name, headers, expected) => {
    expect(hasAdminToken(createRequest(headers), expectedToken)).toBe(expected);
  });

  it("compares tokens through a fixed-length digest", () => {
    expect(constantTimeTokenEqual("same-token", "same-token")).toBe(true);
    expect(constantTimeTokenEqual("short", "a-much-longer-token")).toBe(false);
    expect(constantTimeTokenEqual("token-a", "token-b")).toBe(false);
  });

  it("gives the custom header precedence over Bearer authorization", () => {
    expect(
      hasAdminToken(
        createRequest({
          [ADMIN_TOKEN_HEADER]: "wrong",
          authorization: `Bearer ${expectedToken}`,
        }),
        expectedToken,
      ),
    ).toBe(false);
    expect(
      hasAdminToken(
        createRequest({
          [ADMIN_TOKEN_HEADER]: expectedToken,
          authorization: "Bearer wrong",
        }),
        expectedToken,
      ),
    ).toBe(true);
  });

  it("returns a Bearer challenge for rejected requests", async () => {
    const response = adminAuthError();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.text()).resolves.toBe("unauthorized");
  });
});

describe("server HTTP body reader", () => {
  it("rejects requests that were already aborted before reading began", async () => {
    const request = Object.assign(createRequest(), { aborted: true });

    await expect(readBody(request)).rejects.toThrow("Request body stream was aborted");
  });

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

  it("enforces the default request limit for JSON object parsing", async () => {
    const declared = createRequest({
      "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      "content-type": "application/json",
    });
    const declaredParsed = parseRequestBody(declared);
    await expect(declaredParsed).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    declared.end();

    const streamed = createRequest({ "content-type": "application/json" });
    const streamedParsed = parseRequestBody(streamed);
    streamed.end(Buffer.alloc(DEFAULT_MAX_REQUEST_BODY_BYTES + 1, 0x20));
    await expect(streamedParsed).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("classifies malformed and non-object JSON without conflating their messages", async () => {
    const malformed = createRequest({ "content-type": "application/json" });
    const malformedParsed = parseRequestBody(malformed);
    malformed.end("{");
    await expect(malformedParsed).rejects.toMatchObject({
      message: "Request body is not valid JSON.",
      name: "InvalidJsonBodyError",
    });

    for (const value of ["null", "[]", '"text"', "1", "true"]) {
      const request = createRequest({ "content-type": "application/json" });
      const parsed = parseRequestBody(request);
      request.end(value);
      await expect(parsed).rejects.toMatchObject({
        message: "Request body must be a JSON object.",
        name: "InvalidJsonBodyError",
      });
      await expect(parsed).rejects.toBeInstanceOf(InvalidJsonBodyError);
    }
  });

  it.each([
    ["127.999.1.1", false],
    ["::ffff:127.999.1.1", false],
    ["0:0:0:0:0:0:0:1", true],
    ["[0:0:0:0:0:0:0:1]", true],
    ["::ffff:127.0.0.1", true],
    ["0:0:0:0:0:ffff:7f00:1", true],
  ])("classifies loopback host %s strictly", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it("distinguishes loopback-looking hostnames from actual loopback addresses", () => {
    expect(isLoopbackHost("service.localhost")).toBe(true);
    expect(isLoopbackAddress("service.localhost")).toBe(false);
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isLoopbackAddress("192.0.2.1")).toBe(false);
  });

  it("rejects loopback-looking hostnames that bind to external addresses", () => {
    expect(() => assertLoopbackBindAddress("localhost", "192.0.2.10", "test server")).toThrow(
      /resolved a loopback hostname to non-loopback address 192\.0\.2\.10/u,
    );
    expect(() => assertLoopbackBindAddress("localhost", "127.0.0.1", "test server")).not.toThrow();
    expect(() => assertLoopbackBindAddress("0.0.0.0", "0.0.0.0", "test server")).not.toThrow();
  });

  it.each([
    ["0.0.0.0", "127.0.0.1", "0.0.0.0"],
    ["::", "[::1]", "::"],
    ["0:0:0:0:0:0:0:0", "[::1]", "::"],
  ])(
    "advertises loopback while preserving the %s wildcard bind",
    async (host, advertisedHost, boundAddress) => {
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
          boundAddress,
        );
        await expect(fetch(server.baseUrl).then((response) => response.json())).resolves.toEqual({
          ok: true,
        });
      } finally {
        await server.close();
      }
    },
  );

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

  it("removes connection-scoped response headers named by Connection", async () => {
    const server = await startHttpJsonServer({
      async handle() {
        return new Response("complete", {
          headers: {
            connection: "x-internal",
            "x-internal": "secret",
            "x-safe": "visible",
          },
        });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl);
      expect(response.headers.get("x-internal")).toBeNull();
      expect(response.headers.get("x-safe")).toBe("visible");
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

  it("bounds buffered response bodies before staging status and headers", async () => {
    let cancelled = false;
    const server = await startHttpJsonServer({
      async handle() {
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              controller.enqueue(Buffer.alloc(65, 0x78));
            },
          }),
          { headers: { "x-uncommitted": "true" }, status: 201 },
        );
      },
      handleError(error) {
        expect(error).toBeInstanceOf(ResponseBodyTooLargeError);
        return Response.json({ error: "response too large", ok: false }, { status: 500 });
      },
      host: "127.0.0.1",
      maxResponseBodyBytes: 64,
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl);
      expect(response.status).toBe(500);
      expect(response.headers.get("x-uncommitted")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: "response too large",
        ok: false,
      });
      expect(cancelled).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects response body limits that cannot enforce a finite byte bound", async () => {
    for (const maxResponseBodyBytes of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        startHttpJsonServer({
          async handle() {
            return Response.json({ ok: true });
          },
          host: "127.0.0.1",
          maxResponseBodyBytes,
          port: 0,
          serverName: "test",
        }),
      ).rejects.toThrow("maxResponseBodyBytes must be a positive safe integer.");
    }

    await expect(
      writeResponse({} as ServerResponse, Response.json({ ok: true }), Number.NaN),
    ).rejects.toThrow("maxResponseBodyBytes must be a positive safe integer.");
  });

  it("drains request bodies that handlers ignore", async () => {
    let observedRequest: IncomingMessage | undefined;
    const server = await startHttpJsonServer({
      async handle(request) {
        observedRequest = request;
        return Response.json({ ok: true });
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const response = await fetch(server.baseUrl, {
        body: "ignored request body",
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect.poll(() => observedRequest?.readableEnded).toBe(true);
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

  it("cancels a pending response body when the client disconnects", async () => {
    let reportBodyStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      reportBodyStarted = resolve;
    });
    let reportCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      reportCancelled = resolve;
    });
    let failed = 0;
    let succeeded = 0;
    const server = await startHttpJsonServer({
      async handle() {
        return {
          onWriteFailure() {
            failed++;
          },
          onWriteSuccess() {
            succeeded++;
          },
          response: new Response(
            new ReadableStream({
              cancel() {
                reportCancelled();
              },
              start() {
                reportBodyStarted();
              },
            }),
          ),
        };
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "test",
    });

    try {
      const request = get(server.baseUrl);
      request.on("error", () => {});
      await bodyStarted;
      request.destroy();
      await expect(
        Promise.race([
          cancelled.then(() => "cancelled"),
          new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
        ]),
      ).resolves.toBe("cancelled");
      await expect.poll(() => failed).toBe(1);
      expect(succeeded).toBe(0);
    } finally {
      await server.close();
    }
  });
});
