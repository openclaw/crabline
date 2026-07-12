import fs from "node:fs/promises";
import { Agent, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    for (const [method, params] of [
      ["send", { attachment: "/tmp/test-attachment-placeholder", recipients: ["+15551234567"] }],
      ["sendReceipt", { targetTimestamps: [1_700_000_000_000], usernames: ["alice"] }],
      [
        "sendReaction",
        {
          emoji: "👍",
          recipients: ["+15551234567"],
          targetAuthor: "+15557654321",
          targetTimestamp: 1_700_000_000_000,
        },
      ],
      ["sendTyping", { recipients: ["+15551234567"] }],
    ] as const) {
      const nativeAlternative = await fetch(server.manifest.endpoints.rpcUrl, {
        body: JSON.stringify({
          id: `native-${method}`,
          jsonrpc: "2.0",
          method,
          params,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await expect(nativeAlternative.json()).resolves.toMatchObject({
        id: `native-${method}`,
        jsonrpc: "2.0",
        result: expect.anything(),
      });
    }

    for (const [method, params] of [
      ["send", {}],
      ["sendReaction", { emoji: "👍", recipient: ["+15551234567"] }],
      ["sendReceipt", { recipient: "+15551234567", targetTimestamp: [] }],
      ["sendTyping", { username: ["alice"] }],
      ["sendTyping", { noteToSelf: true }],
      ["sendTyping", { recipient: ["+15551234567"], stop: "yes" }],
    ] as const) {
      const invalid = await fetch(server.manifest.endpoints.rpcUrl, {
        body: JSON.stringify({ id: `invalid-${method}`, jsonrpc: "2.0", method, params }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await expect(invalid.json()).resolves.toEqual({
        error: { code: -32602, message: "Invalid params" },
        id: `invalid-${method}`,
        jsonrpc: "2.0",
      });
    }
    const invalidVersion = await fetch(server.manifest.endpoints.rpcUrl, {
      body: JSON.stringify({
        id: "invalid-jsonrpc-send",
        jsonrpc: "1.0",
        method: "send",
        params: { message: "must not be recorded", recipient: ["+15551234567"] },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(invalidVersion.json()).resolves.toEqual({
      error: { code: -32600, message: "Invalid Request" },
      id: "invalid-jsonrpc-send",
      jsonrpc: "2.0",
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
    expect(recorded).toContain('"accepted":true');
    expect(recorded).not.toContain("invalid-jsonrpc-send");
    expect(recorded).not.toContain("must not be recorded");
    expect(recorded).toContain('"path":"/crabline/signal/inbound"');
  });

  it("enforces JSON-RPC envelopes and does not respond to notifications", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "signal-notifications.jsonl");
    const server = await startSignalServer({ recorderPath });
    servers.push(server);

    for (const body of [
      { id: true, jsonrpc: "2.0", method: "version" },
      { id: {}, jsonrpc: "2.0", method: "version" },
      { id: 1, jsonrpc: "2.0", method: 42 },
      { id: 1, method: "version" },
      { id: 1, jsonrpc: "2.0", method: "sendTyping", params: null },
      { id: 1, jsonrpc: "2.0", method: "version", params: 42 },
    ]) {
      const invalid = await fetch(server.manifest.endpoints.rpcUrl, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        error: { code: -32600, message: "Invalid Request" },
        jsonrpc: "2.0",
      });
    }

    const malformedNotification = await fetch(server.manifest.endpoints.rpcUrl, {
      body: JSON.stringify({ jsonrpc: "2.0", method: "version", params: 42 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(malformedNotification.status).toBe(400);
    await expect(malformedNotification.json()).resolves.toEqual({
      error: { code: -32600, message: "Invalid Request" },
      id: null,
      jsonrpc: "2.0",
    });

    const padded = await fetch(server.manifest.endpoints.rpcUrl, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: " send ", params: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(padded.json()).resolves.toEqual({
      error: { code: -32601, message: "Method not found:  send " },
      id: 1,
      jsonrpc: "2.0",
    });

    for (const body of [
      { jsonrpc: "2.0", method: "version" },
      {
        jsonrpc: "2.0",
        method: "send",
        params: { message: "notification", recipient: "+15551234567" },
      },
      { jsonrpc: "2.0", method: "missing" },
    ]) {
      const notification = await fetch(server.manifest.endpoints.rpcUrl, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(notification.status).toBe(204);
      await expect(notification.text()).resolves.toBe("");
    }

    const recorded = await fs.readFile(recorderPath, "utf8");
    expect(recorded).toContain('"message":"notification"');
    expect(recorded).toContain('"accepted":true');
  });

  it("accepts UUID-only admin inbound and preserves dual source identities", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const sourceUuid = "11111111-2222-4333-8444-555555555555";

    const uuidOnly = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        sourceName: "Alice",
        sourceUuid,
        text: "uuid-only inbound",
        timestamp: 1_700_000_000_000,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(uuidOnly.status).toBe(200);
    await expect(uuidOnly.json()).resolves.toMatchObject({
      event: {
        envelope: {
          dataMessage: { message: "uuid-only inbound" },
          sourceName: "Alice",
          sourceUuid,
          timestamp: 1_700_000_000_000,
        },
      },
      ok: true,
    });

    const dualIdentity = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        senderId: "+15557654321",
        sourceUuid,
        text: "dual identity inbound",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    await expect(dualIdentity.json()).resolves.toMatchObject({
      event: {
        envelope: {
          sourceNumber: "+15557654321",
          sourceUuid,
        },
      },
      ok: true,
    });

    const missingIdentity = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ text: "missing identity" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(missingIdentity.status).toBe(400);
    await expect(missingIdentity.json()).resolves.toEqual({
      error: "text and at least one source identity are required",
      ok: false,
    });
  });

  it("preserves padded admin text and rejects non-string text", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const controller = new AbortController();
    const events = await fetch(server.manifest.endpoints.eventsUrl, {
      signal: controller.signal,
    });
    try {
      const padded = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text: "  hello  " }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
      expect(padded.status).toBe(200);
      const reader = events.body!.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain('"message":"  hello  "');

      for (const text of [42, {}, "   "]) {
        const invalid = await fetch(server.manifest.endpoints.adminInboundUrl, {
          body: JSON.stringify({ sourceNumber: "+15557654321", text }),
          headers: {
            "content-type": "application/json",
            "x-crabline-admin-token": "admin",
          },
          method: "POST",
        });
        expect(invalid.status).toBe(400);
      }
    } finally {
      controller.abort();
    }
  });

  it("rejects admin inbound when the disconnected event queue is full", async () => {
    const server = await startSignalServer({
      adminToken: "admin",
      maxPendingInboundEvents: 1,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    expect((await sendInbound("first")).status).toBe(200);
    const overloaded = await sendInbound("second");
    expect(overloaded.status).toBe(503);
    await expect(overloaded.json()).resolves.toEqual({
      error: "Pending inbound queue is full (1 events)",
      ok: false,
    });
  });

  it("bounds the disconnected event queue by encoded bytes", async () => {
    const server = await startSignalServer({
      adminToken: "admin",
      maxPendingInboundEvents: 10,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    expect((await sendInbound("a".repeat(700_000))).status).toBe(200);
    expect((await sendInbound("b".repeat(700_000))).status).toBe(200);
    expect((await sendInbound("c".repeat(700_000))).status).toBe(503);
  });

  it("resumes queued event delivery after SSE backpressure drains", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
    expect((await sendInbound("first queued")).status).toBe(200);
    expect((await sendInbound("second queued")).status).toBe(200);
    expect((await sendInbound("third queued")).status).toBe(200);

    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].startsWith("event:receive")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const controller = new AbortController();
    try {
      const events = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      expect((await sendInbound("fourth queued")).status).toBe(200);
      backpressuredResponse!.emit("drain");

      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("fourth queued")) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("first queued");
      expect(received).toContain("second queued");
      expect(received).toContain("third queued");
      expect(received).toContain("fourth queued");
      expect(received.indexOf("third queued")).toBeLessThan(received.indexOf("fourth queued"));
    } finally {
      controller.abort();
      write.mockRestore();
    }
  });

  it("moves near-capacity pending events into a client buffer without double-counting", async () => {
    const server = await startSignalServer({
      adminToken: "admin",
      maxPendingInboundEvents: 2,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
    expect((await sendInbound("first event")).status).toBe(200);
    const largeText = `large-${"x".repeat(1_048_450)}`;
    expect((await sendInbound(largeText)).status).toBe(200);

    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].includes("first event")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const controller = new AbortController();
    try {
      const events = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      backpressuredResponse!.emit("drain");

      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes(largeText)) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain(largeText);
    } finally {
      controller.abort();
      write.mockRestore();
    }
  });

  it("restores buffered events when the only SSE client disconnects", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].includes("first event")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const firstController = new AbortController();
    try {
      const firstEvents = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: firstController.signal,
      });
      const sendInbound = (text: string) =>
        fetch(server.manifest.endpoints.adminInboundUrl, {
          body: JSON.stringify({ sourceNumber: "+15557654321", text }),
          headers: {
            "content-type": "application/json",
            "x-crabline-admin-token": "admin",
          },
          method: "POST",
        });
      expect((await sendInbound("first event")).status).toBe(200);
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      expect((await sendInbound("buffered event")).status).toBe(200);
      firstController.abort();
      await firstEvents.body?.cancel().catch(() => undefined);

      const secondController = new AbortController();
      try {
        const secondEvents = await fetch(server.manifest.endpoints.eventsUrl, {
          signal: secondController.signal,
        });
        const reader = secondEvents.body!.getReader();
        const decoder = new TextDecoder();
        let received = "";
        while (!received.includes("buffered event")) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          received += decoder.decode(chunk.value, { stream: true });
        }
        expect(received).toContain("buffered event");
      } finally {
        secondController.abort();
      }
    } finally {
      firstController.abort();
      write.mockRestore();
    }
  });

  it("replays the first backpressured event exactly once after disconnect", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].includes("first backpressured event")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const firstEvents = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: firstController.signal,
      });
      const sent = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          sourceNumber: "+15557654321",
          text: "first backpressured event",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
      expect(sent.status).toBe(200);
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      firstController.abort();
      await firstEvents.body?.cancel().catch(() => undefined);

      const secondEvents = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: secondController.signal,
      });
      const reader = secondEvents.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("first backpressured event")) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received.match(/first backpressured event/gu)).toHaveLength(1);
    } finally {
      firstController.abort();
      secondController.abort();
      write.mockRestore();
    }
  });

  it("replays exclusively buffered events before newer broadcasts", async () => {
    const server = await startSignalServer({ adminToken: "admin" });
    servers.push(server);
    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].includes("first event")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const firstEvents = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: firstController.signal,
      });
      const sendInbound = (text: string) =>
        fetch(server.manifest.endpoints.adminInboundUrl, {
          body: JSON.stringify({ sourceNumber: "+15557654321", text }),
          headers: {
            "content-type": "application/json",
            "x-crabline-admin-token": "admin",
          },
          method: "POST",
        });
      expect((await sendInbound("first event")).status).toBe(200);
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      expect((await sendInbound("buffered event")).status).toBe(200);

      const secondEvents = await fetch(server.manifest.endpoints.eventsUrl, {
        signal: secondController.signal,
      });
      expect((await sendInbound("shared event")).status).toBe(200);

      const reader = secondEvents.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("shared event")) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("buffered event");
      expect(received.indexOf("buffered event")).toBeLessThan(received.indexOf("shared event"));
      expect(received.match(/shared event/gu)).toHaveLength(1);
      firstController.abort();
      await firstEvents.body?.cancel().catch(() => undefined);
    } finally {
      firstController.abort();
      secondController.abort();
      write.mockRestore();
    }
  });

  it("counts reconnectable client buffers against the pending event limit", async () => {
    const server = await startSignalServer({
      adminToken: "admin",
      maxPendingInboundEvents: 2,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].includes("first event")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const controller = new AbortController();
    try {
      await fetch(server.manifest.endpoints.eventsUrl, { signal: controller.signal });
      expect((await sendInbound("first event")).status).toBe(200);
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      expect((await sendInbound("buffered event")).status).toBe(200);
      expect((await sendInbound("over capacity")).status).toBe(503);
    } finally {
      controller.abort();
      write.mockRestore();
    }
  });

  it("bounds pending events together with reconnectable client buffers", async () => {
    const server = await startSignalServer({
      adminToken: "admin",
      maxPendingInboundEvents: 10,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ sourceNumber: "+15557654321", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
    expect((await sendInbound("first")).status).toBe(200);
    expect((await sendInbound(`second-${"x".repeat(700_000)}`)).status).toBe(200);
    expect((await sendInbound(`third-${"x".repeat(700_000)}`)).status).toBe(200);

    const originalWrite = ServerResponse.prototype.write;
    let backpressuredResponse: ServerResponse | undefined;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof originalWrite>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        backpressuredResponse === undefined &&
        typeof args[0] === "string" &&
        args[0].startsWith("event:receive")
      ) {
        backpressuredResponse = this;
        return false;
      }
      return accepted;
    });
    const controller = new AbortController();
    try {
      await fetch(server.manifest.endpoints.eventsUrl, { signal: controller.signal });
      await vi.waitFor(() => expect(backpressuredResponse).toBeDefined());
      expect((await sendInbound(`fourth-${"x".repeat(700_000)}`)).status).toBe(503);
    } finally {
      controller.abort();
      write.mockRestore();
    }
  });

  it("bounds concurrent event stream clients", async () => {
    const server = await startSignalServer({ maxSseClients: 1 });
    servers.push(server);
    const controller = new AbortController();
    const first = await fetch(server.manifest.endpoints.eventsUrl, {
      signal: controller.signal,
    });
    expect(first.status).toBe(200);

    const overloaded = await fetch(server.manifest.endpoints.eventsUrl);
    expect(overloaded.status).toBe(503);
    await expect(overloaded.json()).resolves.toEqual({
      error: "Too many event stream clients",
      ok: false,
    });
    controller.abort();
  });

  it("reserves event stream capacity before awaited recording", async () => {
    let releaseRecording!: () => void;
    const recordingBlocked = new Promise<void>((resolve) => {
      releaseRecording = resolve;
    });
    let observeRecording!: () => void;
    const recordingStarted = new Promise<void>((resolve) => {
      observeRecording = resolve;
    });
    const server = await startSignalServer({
      maxSseClients: 1,
      async onEvent(event) {
        if (event.path === "/api/v1/events") {
          observeRecording();
          await recordingBlocked;
        }
      },
    });
    servers.push(server);

    const controller = new AbortController();
    const first = fetch(server.manifest.endpoints.eventsUrl, { signal: controller.signal });
    await recordingStarted;
    const overloaded = await fetch(server.manifest.endpoints.eventsUrl);
    expect(overloaded.status).toBe(503);
    releaseRecording();
    expect((await first).status).toBe(200);
    controller.abort();
  });

  it("hides observer failures from public error responses", async () => {
    const server = await startSignalServer({
      onEvent() {
        throw new Error("sensitive Signal observer detail");
      },
    });
    servers.push(server);

    const response = await fetch(`${server.manifest.baseUrl}/api/v1/check`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "internal server error",
      ok: false,
    });
  });

  it("preserves accepted RPC success when recording callbacks fail", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "signal-committed.jsonl");
    const server = await startSignalServer({
      onEvent() {
        throw new Error("observer failed");
      },
      recorderPath,
    });
    servers.push(server);

    for (const [method, params] of [
      ["send", { message: "committed once", recipient: "+15551234567" }],
      ["sendTyping", { recipient: "+15551234567" }],
    ] as const) {
      const response = await fetch(server.manifest.endpoints.rpcUrl, {
        body: JSON.stringify({ id: method, jsonrpc: "2.0", method, params }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: method,
        jsonrpc: "2.0",
        result: expect.anything(),
      });
    }
    const notification = await fetch(server.manifest.endpoints.rpcUrl, {
      body: JSON.stringify({ jsonrpc: "2.0", method: "version" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(notification.status).toBe(204);

    const records = (await fs.readFile(recorderPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { accepted?: boolean });
    expect(records).toEqual([
      expect.objectContaining({ accepted: true }),
      expect.objectContaining({ accepted: true }),
      expect.objectContaining({ accepted: false }),
    ]);
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

  it("does not start the SSE keepalive when listen fails", async () => {
    const occupied = await startSignalServer();
    servers.push(occupied);
    const port = Number(new URL(occupied.manifest.baseUrl).port);
    const setInterval = vi.spyOn(globalThis, "setInterval");
    try {
      await expect(startSignalServer({ port })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
    }
  });
});
