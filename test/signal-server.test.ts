import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSignalServer, type StartedSignalServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedSignalServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("signal local provider server", () => {
  it("serves native RPC and delivers authenticated inbound messages over SSE", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "signal.jsonl");
    const server = await startSignalServer({ adminToken: "admin-secret", recorderPath });
    servers.push(server);

    const check = await fetch(`${server.manifest.baseUrl}/api/v1/check`);
    expect(check.status).toBe(200);

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
      'event: receive\ndata: {"envelope":{"sourceName":"Alice","sourceNumber":"+15557654321","timestamp":1700000000000,"dataMessage":{"message":"user nonce-1","timestamp":1700000000000,"groupInfo":{"groupId":"signal-group-1"}}}}',
    );

    const recorded = await fs.readFile(recorderPath, "utf8");
    expect(recorded).toContain('"method":"send"');
    expect(recorded).toContain('"path":"/crabline/signal/inbound"');
  });
});
