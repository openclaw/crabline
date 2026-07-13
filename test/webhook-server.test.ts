import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
    });
    const endpoint = new URL(server.endpointUrl);
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    await once(socket, "connect");
    socket.write("POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\n1");
    socket.on("error", () => {});
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await expect(
      Promise.race([
        server.close().then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 250)),
      ]),
    ).resolves.toBe("closed");
    await closed;
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
