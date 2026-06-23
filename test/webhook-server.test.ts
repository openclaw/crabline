import { afterEach, describe, expect, it } from "vitest";
import { startWebhookServer } from "../src/providers/webhook-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("webhook server", () => {
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
    const server = await startWebhookServer({
      async handle() {
        throw new Error("boom");
      },
      host: "127.0.0.1",
      path: "/slack/events",
      port: 0,
    });
    cleanups.push(() => server.close());

    const response = await fetch(server.endpointUrl, { method: "POST" });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("boom");
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
  });
});
