import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebhookServer } from "../src/providers/webhook-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("webhook server", () => {
  it("advertises a valid URL when bound to IPv6", async () => {
    const server = await startWebhookServer({
      handle: async () => new Response("ok"),
      host: "::1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    expect(new URL(server.endpointUrl).hostname).toBe("[::1]");
    const response = await fetch(server.endpointUrl, { method: "POST" });
    expect(response.status).toBe(200);
  });

  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "[::1]"],
  ])("advertises loopback instead of the %s wildcard bind", async (host, advertisedHost) => {
    const server = await startWebhookServer({
      handle: async () => new Response("ok"),
      host,
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    expect(new URL(server.endpointUrl).hostname).toBe(advertisedHost);
    const response = await fetch(server.endpointUrl, { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("serves the configured POST path", async () => {
    const server = await startWebhookServer({
      async handle(request) {
        const payload = (await request.json()) as { ok: boolean };
        return Response.json({ echoed: payload.ok });
      },
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, {
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ echoed: true });
  });

  it("rejects non-matching paths", async () => {
    const server = await startWebhookServer({
      handle: async () => new Response("ok"),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl.replace("/slack/events", "/wrong"), {
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  it("rejects configured paths changed by URL normalization", async () => {
    await expect(
      startWebhookServer({
        handle: async () => new Response("ok"),
        host: "127.0.0.1",
        path: "/slack/../events",
        port: 0,
      }),
    ).rejects.toThrow(/canonical URL pathname/u);
  });

  it("can serve explicit GET webhook routes", async () => {
    const server = await startWebhookServer({
      async handle(request) {
        return new Response(new URL(request.url).searchParams.get("challenge") ?? "");
      },
      host: "127.0.0.1",
      methods: ["GET", "POST"],
      path: "/whatsapp/webhook",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.endpointUrl}?challenge=ok`, { method: "GET" });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("rejects methods outside the configured route method set", async () => {
    const server = await startWebhookServer({
      handle: async () => new Response("ok"),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, { method: "GET" });

    expect(response.status).toBe(404);
  });

  it("returns 500 when the handler throws", async () => {
    const observedErrors: unknown[] = [];
    const server = await startWebhookServer({
      async handle() {
        throw new Error("sensitive internal detail");
      },
      host: "127.0.0.1",
      onError: (error) => observedErrors.push(error),
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, { method: "POST" });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("internal server error");
    expect(observedErrors).toEqual([
      expect.objectContaining({ message: "sensitive internal detail" }),
    ]);
  });

  it("clears response headers before a fallback 500", async () => {
    const observedErrors: unknown[] = [];
    const server = await startWebhookServer({
      async handle() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("response body failed"));
            },
          }),
          {
            headers: {
              "content-encoding": "gzip",
              "content-length": "999",
              "content-type": "application/json",
              "x-response-kind": "provider",
            },
          },
        );
      },
      host: "127.0.0.1",
      onError: (error) => observedErrors.push(error),
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, { method: "POST" });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("999");
    expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(response.headers.get("x-response-kind")).toBeNull();
    await expect(response.text()).resolves.toBe("internal server error");
    expect(observedErrors).toEqual([expect.objectContaining({ message: "response body failed" })]);
  });

  it("filters response framing and hop-by-hop headers while preserving distinct cookies", async () => {
    const server = await startWebhookServer({
      async handle() {
        const headers = new Headers({
          connection: "close, x-internal",
          "content-length": "999",
          trailer: "x-checksum",
          "transfer-encoding": "chunked",
          "x-internal": "secret",
          "x-safe": "visible",
        });
        headers.append("set-cookie", "first=1; Path=/");
        headers.append("set-cookie", "second=2; Path=/");
        return new Response("ok", { headers });
      },
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, {
      method: "POST",
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.headers.get("content-length")).not.toBe("999");
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("trailer")).toBeNull();
    expect(response.headers.get("x-internal")).toBeNull();
    expect(response.headers.get("x-safe")).toBe("visible");
    expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("streams response chunks before the provider body completes", async () => {
    let releaseBody!: () => void;
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const server = await startWebhookServer({
      handle: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("first"));
            },
            async pull(controller) {
              await bodyReleased;
              controller.enqueue(Buffer.from("-second"));
              controller.close();
            },
          }),
        ),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, { method: "POST" });
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(Buffer.from(first.value ?? []).toString()).toBe("first");
    expect(first.done).toBe(false);

    releaseBody();
    const second = await reader.read();
    expect(Buffer.from(second.value ?? []).toString()).toBe("-second");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("applies response backpressure and cancels the body when the client disconnects", async () => {
    const totalChunks = 512;
    let pulls = 0;
    let reportCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      reportCancellation = resolve;
    });
    const server = await startWebhookServer({
      handle: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              reportCancellation();
            },
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(64 * 1024));
              if (pulls === totalChunks) {
                controller.close();
              }
            },
          }),
        ),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());
    const endpoint = new URL(server.endpointUrl);
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    socket.on("error", () => {});
    socket.pause();
    await once(socket, "connect");
    socket.write("POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n");

    await vi.waitFor(() => expect(pulls).toBeGreaterThan(0));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(pulls).toBeLessThan(totalChunks);

    socket.destroy();
    await expect(
      Promise.race([
        cancelled.then(() => "cancelled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
      ]),
    ).resolves.toBe("cancelled");
  });

  it("returns 413 for oversized request bodies without invoking the handler", async () => {
    let handlerInvoked = false;
    const server = await startWebhookServer({
      async handle() {
        handlerInvoked = true;
        return new Response("ok");
      },
      host: "127.0.0.1",
      maxBodyBytes: 4,
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, {
      body: "12345",
      method: "POST",
    });

    expect(response.status).toBe(413);
    expect(handlerInvoked).toBe(false);

    const healthy = await fetch(server.endpointUrl, { body: "1234", method: "POST" });
    expect(healthy.status).toBe(200);
    expect(handlerInvoked).toBe(true);
  });

  it("rejects a wrong route before reading an oversized body", async () => {
    const server = await startWebhookServer({
      handle: async () => new Response("ok"),
      host: "127.0.0.1",
      maxBodyBytes: 4,
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl.replace("/slack/events", "/wrong"), {
      body: "12345",
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  it("times out slow request bodies before invoking the handler", async () => {
    let handlerInvoked = false;
    const server = await startWebhookServer({
      bodyTimeoutMs: 20,
      async handle() {
        handlerInvoked = true;
        return new Response("ok");
      },
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());
    const endpoint = new URL(server.endpointUrl);
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    await once(socket, "connect");
    socket.write(
      "POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nConnection: close\r\n\r\n1",
    );
    await once(socket, "close");

    expect(response).toContain("HTTP/1.1 408");
    expect(response).toContain("request body timeout");
    expect(handlerInvoked).toBe(false);

    const healthy = await fetch(server.endpointUrl, { body: "{}", method: "POST" });
    expect(healthy.status).toBe(200);
    expect(handlerInvoked).toBe(true);
  });

  it("does not let a slow request body block shutdown", async () => {
    const server = await startWebhookServer({
      bodyTimeoutMs: 10_000,
      handle: async () => new Response("ok"),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
      shutdownGraceMs: 50,
    });
    const endpoint = new URL(server.endpointUrl);
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    await once(socket, "connect");
    socket.write("POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\n1");
    socket.on("error", () => {});
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const closingStartedAt = Date.now();
    await expect(
      Promise.race([
        server.close().then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
      ]),
    ).resolves.toBe("closed");
    expect(Date.now() - closingStartedAt).toBeGreaterThanOrEqual(30);
    await closed;
  });

  it("drains an admitted HTTP response before closing its connection", async () => {
    let reportAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => {
      reportAdmission = resolve;
    });
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const server = await startWebhookServer({
      async handle() {
        reportAdmission();
        await handlerReleased;
        return new Response("admitted response", { status: 202 });
      },
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
      shutdownGraceMs: 500,
    });
    cleanups.push(() => server.close());
    const responsePromise = fetch(server.endpointUrl, { body: "{}", method: "POST" });
    await admitted;

    let closeResolved = false;
    const closing = server.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseHandler();
    const response = await responsePromise;
    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("admitted response");
    await expect(closing).resolves.toBeUndefined();
  });

  it("cancels an unfinished response body after the shutdown grace period", async () => {
    let reportCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      reportCancellation = resolve;
    });
    const server = await startWebhookServer({
      handle: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              reportCancellation();
            },
            start(controller) {
              controller.enqueue(Buffer.from("started"));
            },
          }),
        ),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
      shutdownGraceMs: 30,
    });
    const endpoint = new URL(server.endpointUrl);
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    socket.on("error", () => {});
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    await once(socket, "connect");
    socket.write("POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n");
    await vi.waitFor(() => expect(response).toContain("started"));

    await expect(
      Promise.race([
        server.close().then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
      ]),
    ).resolves.toBe("closed");
    await expect(cancelled).resolves.toBeUndefined();
  });

  it("survives clients aborting incomplete request bodies", async () => {
    const server = await startWebhookServer({
      bodyTimeoutMs: 10_000,
      handle: async () => new Response("ok"),
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());
    const endpoint = new URL(server.endpointUrl);
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\n1");
    socket.destroy();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    const response = await fetch(server.endpointUrl, { body: "{}", method: "POST" });
    expect(response.status).toBe(200);
  });
});
