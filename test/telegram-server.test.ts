import fs from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTelegramServer, type StartedTelegramServer } from "../src/index.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

const servers: StartedTelegramServer[] = [];
const directories: string[] = [];

function adminHeaders(server: StartedTelegramServer) {
  return {
    "content-type": "application/json",
    "x-crabline-admin-token": server.manifest.adminToken,
  };
}

async function injectUpdate(
  server: StartedTelegramServer,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(server.manifest.endpoints.adminInboundUrl, {
    body: JSON.stringify(body),
    headers: adminHeaders(server),
    method: "POST",
  });
}

async function getUpdates(
  server: StartedTelegramServer,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${server.manifest.baseUrl}/bot${server.manifest.botToken}/getUpdates`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("telegram local provider server", () => {
  it("advertises valid URLs when bound to IPv6", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      host: "::1",
      recorderPath: path.join(directory, "telegram-ipv6.jsonl"),
    });
    servers.push(server);

    expect(new URL(server.manifest.baseUrl).hostname).toBe("[::1]");
    const getMe = await fetch(`${server.manifest.baseUrl}/bot${server.manifest.botToken}/getMe`);
    expect(getMe.status).toBe(200);
  });

  it("distinguishes ordinary groups from supergroups", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "123456:fake-token",
      recorderPath: path.join(directory, "telegram.jsonl"),
    });
    servers.push(server);

    const group = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendMessage`, {
      body: JSON.stringify({ chat_id: "-42", text: "ordinary group" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(group.json()).resolves.toMatchObject({
      result: { chat: { id: -42, type: "group" } },
    });

    const supergroup = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendMessage`, {
      body: JSON.stringify({ chat_id: "-1001234567890", text: "supergroup" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(supergroup.json()).resolves.toMatchObject({
      result: { chat: { id: -1001234567890, type: "supergroup" } },
    });
  });

  it("serves Telegram Bot API calls and queues injected inbound updates", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "123456:fake-token",
      recorderPath: path.join(directory, "telegram.jsonl"),
    });
    servers.push(server);

    const getMe = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/getMe`);
    await expect(getMe.json()).resolves.toMatchObject({
      ok: true,
      result: {
        is_bot: true,
        username: "crabline_bot",
      },
    });

    const invalidJson = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendMessage`, {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      description: "Bad Request: can't parse JSON object",
      error_code: 400,
      ok: false,
    });

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalidBody = await fetch(
        `${server.manifest.baseUrl}/bot123456:fake-token/sendMessage`,
        {
          body: scalarBody,
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(invalidBody.status).toBe(400);
      await expect(invalidBody.json()).resolves.toEqual({
        description: "Bad Request: can't parse JSON object",
        error_code: 400,
        ok: false,
      });
    }

    const oversized = await requestHttp({
      headers: {
        "content-length": String(50 * 1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: `${server.manifest.baseUrl}/bot123456:fake-token/sendMessage`,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({
      description: "Request Entity Too Large",
      error_code: 413,
      ok: false,
    });

    const sendMessage = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendMessage`, {
      body: JSON.stringify({
        chat_id: "-1001234567890",
        message_thread_id: 42,
        text: "hello fake telegram",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(sendMessage.json()).resolves.toMatchObject({
      ok: true,
      result: {
        chat: { id: -1001234567890, type: "supergroup" },
        message_thread_id: 42,
        text: "hello fake telegram",
      },
    });

    const mediaBody = new FormData();
    mediaBody.set("chat_id", "-1001234567890");
    mediaBody.set("message_thread_id", "42");
    mediaBody.set("caption", "hello fake telegram media");
    mediaBody.set("photo", new Blob(["png"], { type: "image/png" }), "fixture.png");
    const sendPhoto = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendPhoto`, {
      body: mediaBody,
      method: "POST",
    });
    await expect(sendPhoto.json()).resolves.toMatchObject({
      ok: true,
      result: {
        caption: "hello fake telegram media",
        chat: { id: -1001234567890, type: "supergroup" },
        message_thread_id: 42,
        photo: [{ height: 1, width: 1 }],
      },
    });

    for (const [method, field] of [
      ["sendPhoto", "photo"],
      ["sendVideo", "video"],
      ["sendDocument", "document"],
      ["sendAudio", "audio"],
    ] as const) {
      const missingMedia = await fetch(
        `${server.manifest.baseUrl}/bot123456:fake-token/${method}`,
        {
          body: JSON.stringify({ chat_id: "-1001234567890" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(missingMedia.status).toBe(400);
      await expect(missingMedia.json()).resolves.toEqual({
        description: `Bad Request: chat_id and ${field} are required`,
        error_code: 400,
        ok: false,
      });
    }

    const sendAudio = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendAudio`, {
      body: JSON.stringify({
        audio: "fixture.mp3",
        caption: "hello fake telegram audio",
        chat_id: "-1001234567890",
        duration: 7,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(sendAudio.json()).resolves.toMatchObject({
      ok: true,
      result: {
        audio: { duration: 7, file_name: "fixture.mp3" },
        caption: "hello fake telegram audio",
      },
    });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatId: "-1001234567890",
        fromId: 100001,
        messageThreadId: 42,
        entities: [{ length: 5, offset: 0, type: "bot_command" }],
        text: "user nonce-1",
      }),
      headers: adminHeaders(server),
      method: "POST",
    });
    await expect(inbound.json()).resolves.toMatchObject({
      ok: true,
      update: {
        message: {
          chat: { id: -1001234567890 },
          from: { id: 100001, is_bot: false },
          entities: [{ length: 5, offset: 0, type: "bot_command" }],
          message_thread_id: 42,
          text: "user nonce-1",
        },
      },
    });

    const updates = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/getUpdates`, {
      body: JSON.stringify({ offset: 1 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(updates.json()).resolves.toMatchObject({
      ok: true,
      result: [
        {
          message: {
            text: "user nonce-1",
          },
          update_id: 1,
        },
      ],
    });
  });

  it("rejects unauthenticated inbound updates", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      adminToken: "admin-secret",
      botToken: "123456:fake-token",
      recorderPath: path.join(directory, "telegram.jsonl"),
    });
    servers.push(server);

    const unauthenticated = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "123", text: "rejected" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "123", text: "accepted" }),
      headers: adminHeaders(server),
      method: "POST",
    });
    await expect(authenticated.json()).resolves.toMatchObject({
      ok: true,
      update: { message: { text: "accepted" } },
    });
  });

  it("drains request bodies rejected by admin and bot authentication", async () => {
    const server = await startTelegramServer({
      adminToken: "admin",
      botToken: "123:fake",
    });
    servers.push(server);

    for (const url of [
      server.manifest.endpoints.adminInboundUrl,
      `${server.manifest.baseUrl}/botwrong-token/sendMessage`,
    ]) {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const body = JSON.stringify({ chat_id: "123", text: "rejected" });
        const rejected = await requestHttp({
          agent,
          body,
          headers: {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
          },
          method: "POST",
          url,
        });
        expect([401, 404]).toContain(rejected.status);

        const accepted = await requestHttp({
          agent,
          method: "GET",
          url: `${server.manifest.baseUrl}/bot123:fake/getMe`,
        });
        expect(accepted.status).toBe(200);
      } finally {
        agent.destroy();
      }
    }
  });

  it("keeps generated inbound IDs above explicit IDs", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "123456:fake-token",
      recorderPath: path.join(directory, "telegram.jsonl"),
    });
    servers.push(server);

    const explicitInbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatId: "123",
        messageId: 200,
        text: "explicit",
        updateId: 100,
      }),
      headers: adminHeaders(server),
      method: "POST",
    });
    await expect(explicitInbound.json()).resolves.toMatchObject({
      update: {
        message: { message_id: 200 },
        update_id: 100,
      },
    });

    const generatedInbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatId: "123",
        text: "generated",
      }),
      headers: adminHeaders(server),
      method: "POST",
    });
    await expect(generatedInbound.json()).resolves.toMatchObject({
      update: {
        message: { message_id: 201 },
        update_id: 101,
      },
    });
  });

  it("long-polls until an update arrives and returns empty on timeout", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "test-token",
      recorderPath: path.join(directory, "telegram-long-poll.jsonl"),
    });
    servers.push(server);

    const timeoutStartedAt = Date.now();
    const timedOut = await getUpdates(server, { timeout: 1 });
    expect(Date.now() - timeoutStartedAt).toBeGreaterThanOrEqual(800);
    await expect(timedOut.json()).resolves.toEqual({ ok: true, result: [] });

    const pending = getUpdates(server, { offset: 100, timeout: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const belowOffset = await injectUpdate(server, {
      chatId: "123",
      text: "below the poll offset",
      updateId: 10,
    });
    expect(belowOffset.status).toBe(200);
    await expect(
      Promise.race([
        pending.then(() => "resolved"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]),
    ).resolves.toBe("waiting");

    const matching = await injectUpdate(server, {
      chatId: "123",
      text: "wake the poll",
      updateId: 100,
    });
    expect(matching.status).toBe(200);

    await expect(pending.then((response) => response.json())).resolves.toMatchObject({
      ok: true,
      result: [{ message: { text: "wake the poll" }, update_id: 100 }],
    });
  });

  it("confirms positive offsets and forgets updates before a negative offset", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "test-token",
      recorderPath: path.join(directory, "telegram-offsets.jsonl"),
    });
    servers.push(server);

    for (const updateId of [10, 11, 12]) {
      const inbound = await injectUpdate(server, {
        chatId: "123",
        text: `update ${updateId}`,
        updateId,
      });
      expect(inbound.status).toBe(200);
    }
    await expect(
      getUpdates(server, { offset: 11 }).then((response) => response.json()),
    ).resolves.toMatchObject({
      result: [{ update_id: 11 }, { update_id: 12 }],
    });
    await expect(
      getUpdates(server, { offset: 13 }).then((response) => response.json()),
    ).resolves.toEqual({
      ok: true,
      result: [],
    });

    for (const updateId of [20, 21, 22]) {
      const inbound = await injectUpdate(server, {
        chatId: "123",
        text: `update ${updateId}`,
        updateId,
      });
      expect(inbound.status).toBe(200);
    }
    await expect(
      getUpdates(server, { offset: -2 }).then((response) => response.json()),
    ).resolves.toMatchObject({
      result: [{ update_id: 21 }, { update_id: 22 }],
    });
    await expect(getUpdates(server, {}).then((response) => response.json())).resolves.toMatchObject(
      {
        result: [{ update_id: 21 }, { update_id: 22 }],
      },
    );
  });

  it("releases pending long polls when the server closes", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "test-token",
      recorderPath: path.join(directory, "telegram-close.jsonl"),
    });
    servers.push(server);

    const pending = getUpdates(server, { timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const closeStartedAt = Date.now();
    const closing = server.close();
    const payload = await pending.then((response) => response.json());
    await closing;
    servers.splice(servers.indexOf(server), 1);
    expect(Date.now() - closeStartedAt).toBeLessThan(1_000);
    expect(payload).toEqual({
      ok: true,
      result: [],
    });
  });

  it("does not register a long poll after shutdown starts", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "test-token",
      recorderPath: path.join(directory, "telegram-close-during-read.jsonl"),
    });
    servers.push(server);

    let resolveConnected!: () => void;
    let rejectConnected!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    let pendingRequest!: ReturnType<typeof httpRequest>;
    const response = new Promise<{ body: string; status: number }>((resolve, reject) => {
      pendingRequest = httpRequest(
        `${server.manifest.baseUrl}/bot${server.manifest.botToken}/getUpdates`,
        {
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
          method: "POST",
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.once("end", () => {
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              status: incoming.statusCode ?? 0,
            });
          });
        },
      );
      pendingRequest.once("socket", (socket) => {
        if (socket.connecting) {
          socket.once("connect", resolveConnected);
        } else {
          resolveConnected();
        }
      });
      pendingRequest.once("error", (error) => {
        rejectConnected(error);
        reject(error);
      });
      pendingRequest.write('{"timeout":30');
    });

    await connected;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const closeStartedAt = Date.now();
    const closing = server.close();
    pendingRequest.end("}");
    const result = await response;
    await closing;
    servers.splice(servers.indexOf(server), 1);

    expect(Date.now() - closeStartedAt).toBeLessThan(1_000);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      result: [],
    });
  });

  it("redacts the bot token from recorded API paths", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const botToken = "987654:distinctive-secret-token";
    const recorderPath = path.join(directory, "telegram.jsonl");
    const server = await startTelegramServer({ botToken, recorderPath });
    servers.push(server);

    const response = await fetch(`${server.manifest.baseUrl}/bot${botToken}/getMe`);
    await expect(response.json()).resolves.toMatchObject({ ok: true });

    const recordedEvents = await fs.readFile(recorderPath, "utf8");
    expect(recordedEvents).not.toContain(botToken);
    expect(recordedEvents).toContain('"path":"/bot<redacted>/getMe"');
  });

  it("notifies observers after recording each event", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "telegram.jsonl");
    const observedEvents: unknown[] = [];
    const server = await startTelegramServer({
      botToken: "123456:fake-token",
      onEvent: async (event) => {
        const recordedEvents = await fs.readFile(recorderPath, "utf8");
        expect(recordedEvents).toContain(`${JSON.stringify(event)}\n`);
        observedEvents.push(event);
      },
      recorderPath,
    });
    servers.push(server);

    const response = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/getMe`);
    await expect(response.json()).resolves.toMatchObject({ ok: true });

    expect(observedEvents).toEqual([
      expect.objectContaining({ method: "GET", path: "/bot<redacted>/getMe", type: "api" }),
    ]);
  });
});
