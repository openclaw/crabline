import fs from "node:fs/promises";
import { Agent } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSignalServer, type StartedSignalServer } from "../src/index.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

const servers: StartedSignalServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("signal local provider server", () => {
  it("returns JSON-RPC errors for non-object and oversized request bodies", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startSignalServer({
      recorderPath: path.join(directory, "signal-bodies.jsonl"),
    });
    servers.push(server);

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalid = await fetch(server.manifest.endpoints.rpcUrl, {
        body: scalarBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        error: { code: -32600, message: "Invalid Request" },
        id: null,
        jsonrpc: "2.0",
      });
    }

    const malformed = await fetch(server.manifest.endpoints.rpcUrl, {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: { code: -32700, message: "Parse error" },
      id: null,
      jsonrpc: "2.0",
    });

    const malformedAdmin = await fetch(`${server.manifest.endpoints.adminInboundUrl}?trace=1`, {
      body: "{",
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    expect(malformedAdmin.status).toBe(400);
    await expect(malformedAdmin.json()).resolves.toEqual({
      error: "Request body is not valid JSON",
      ok: false,
    });

    const oversized = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: server.manifest.endpoints.rpcUrl,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({
      error: { code: -32600, message: "Request body is too large" },
      id: null,
      jsonrpc: "2.0",
    });
  });

  it("advertises valid URLs when bound to IPv6", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startSignalServer({
      host: "::1",
      recorderPath: path.join(directory, "signal-ipv6.jsonl"),
    });
    servers.push(server);

    expect(new URL(server.manifest.baseUrl).hostname).toBe("[::1]");
    const check = await fetch(`${server.manifest.baseUrl}/api/v1/check`);
    expect(check.status).toBe(200);
  });

  it("serves native RPC and delivers authenticated inbound messages over SSE", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "signal.jsonl");
    const server = await startSignalServer({ adminToken: "admin-secret", recorderPath });
    servers.push(server);

    const check = await fetch(`${server.manifest.baseUrl}/api/v1/check`);
    expect(check.status).toBe(200);
    await expect(check.text()).resolves.toBe("");

    const send = await fetch(server.manifest.endpoints.rpcUrl, {
      body: JSON.stringify({
        id: "rpc-1",
        jsonrpc: "2.0",
        method: "send",
        params: { message: "hello", recipient: ["+15551234567"] },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(send.json()).resolves.toMatchObject({
      id: "rpc-1",
      jsonrpc: "2.0",
      result: { timestamp: expect.any(Number) },
    });

    const rejected = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ sourceNumber: "+15557654321", text: "nope" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        groupId: "signal-group-1",
        sourceName: "Alice",
        sourceNumber: "+15557654321",
        text: "user nonce-1",
        timestamp: 1_700_000_000_000,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin-secret",
      },
      method: "POST",
    });
    expect(accepted.status).toBe(200);

    const controller = new AbortController();
    const events = await fetch(server.manifest.endpoints.eventsUrl, { signal: controller.signal });
    const reader = events.body?.getReader();
    const chunk = await reader?.read();
    controller.abort();
    expect(new TextDecoder().decode(chunk?.value)).toContain(
      'event:receive\ndata:{"envelope":{"sourceName":"Alice","sourceNumber":"+15557654321","timestamp":1700000000000,"dataMessage":{"message":"user nonce-1","timestamp":1700000000000,"groupInfo":{"groupId":"signal-group-1"}}}}',
    );

    const recorded = await fs.readFile(recorderPath, "utf8");
    expect(recorded).toContain('"method":"send"');
    expect(recorded).toContain('"path":"/crabline/signal/inbound"');
  });

  it("drains unauthenticated admin request bodies", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const body = JSON.stringify({ sourceNumber: "+15557654321", text: "rejected" });
      const rejected = await requestHttp({
        agent,
        body,
        headers: {
          "content-length": String(Buffer.byteLength(body)),
          "content-type": "application/json",
        },
        method: "POST",
        url: server.manifest.endpoints.adminInboundUrl,
      });
      expect(rejected.status).toBe(401);

      const check = await requestHttp({
        agent,
        method: "GET",
        url: `${server.manifest.baseUrl}/api/v1/check`,
      });
      expect(check.status).toBe(200);
    } finally {
      agent.destroy();
    }
  });
});
