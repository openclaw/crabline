import fs from "node:fs/promises";
import { Agent, createServer, request as httpRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTelegramServer, type StartedTelegramServer } from "../src/index.js";
import { handleTelegramGetUpdates } from "../src/servers/telegram.js";
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
  it("accepts only GET and POST and resolves Bot API methods case-insensitively", async () => {
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);
    const apiRoot = `${server.manifest.baseUrl}/bottest-token-placeholder`;

    const getMe = await fetch(`${apiRoot}/gEtMe`);
    await expect(getMe.json()).resolves.toMatchObject({
      ok: true,
      result: { is_bot: true },
    });

    const sent = await fetch(`${apiRoot}/sEnDmEsSaGe`, {
      body: JSON.stringify({ chat_id: "123", text: "case-insensitive" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(sent.json()).resolves.toMatchObject({
      ok: true,
      result: { text: "case-insensitive" },
    });

    const rejected = await fetch(`${apiRoot}/getMe`, { method: "PUT" });
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("GET, POST");
    await expect(rejected.json()).resolves.toEqual({
      description: "Method Not Allowed",
      error_code: 405,
      ok: false,
    });
  });

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

    const malformedMultipart = await fetch(
      `${server.manifest.baseUrl}/bot123456:fake-token/sendPhoto`,
      {
        body: "malformed multipart",
        headers: { "content-type": "Multipart/Form-Data" },
        method: "POST",
      },
    );
    expect(malformedMultipart.status).toBe(400);
    await expect(malformedMultipart.json()).resolves.toEqual({
      description: "Bad Request: can't parse JSON object",
      error_code: 400,
      ok: false,
    });

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
      headers: { "content-type": "Application/JSON; Charset=UTF-8" },
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

    const boundary = "CrablineBoundary";
    const unicodeCaption = "\u4f60\u597d, Telegram";
    const multipart = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="chat_id"',
        "",
        "-1001234567890",
        `--${boundary}`,
        'Content-Disposition: form-data; name="caption"',
        "",
        unicodeCaption,
        `--${boundary}`,
        'Content-Disposition: form-data; name="photo"; filename="fixture.png"',
        "Content-Type: image/png",
        "",
        "png",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    const unicodePhoto = await fetch(`${server.manifest.baseUrl}/bot123456:fake-token/sendPhoto`, {
      body: multipart,
      headers: {
        "content-type": `Multipart/Form-Data; Boundary=${boundary}`,
      },
      method: "POST",
    });
    await expect(unicodePhoto.json()).resolves.toMatchObject({
      ok: true,
      result: { caption: unicodeCaption },
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

  it("rejects admin inbound when the update queue is full", async () => {
    const server = await startTelegramServer({
      adminToken: "admin",
      maxPendingInboundEvents: 1,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: 42, text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    expect((await sendInbound("first")).status).toBe(200);
    const overloaded = await sendInbound("second");
    expect(overloaded.status).toBe(429);
    await expect(overloaded.json()).resolves.toEqual({
      description: "Too Many Requests: pending inbound queue is full (1 updates)",
      error_code: 429,
      ok: false,
    });
  });

  it("serializes concurrent inbound admission without consuming rejected IDs", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let observeFirst!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    let observed = false;
    const server = await startTelegramServer({
      adminToken: "admin",
      maxPendingInboundEvents: 1,
      async onEvent(event) {
        if (event.type === "admin" && !observed) {
          observed = true;
          observeFirst();
          await firstBlocked;
        }
      },
    });
    servers.push(server);

    const first = injectUpdate(server, { chatId: 42, text: "first" });
    await firstObserved;
    const second = injectUpdate(server, { chatId: 42, text: "second" });
    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(429);

    const drained = await getUpdates(server, {});
    await expect(drained.json()).resolves.toMatchObject({
      result: [{ message: { message_id: 1 }, update_id: 1 }],
    });
    await getUpdates(server, { offset: 2 });
    const third = await injectUpdate(server, { chatId: 42, text: "third" });
    await expect(third.json()).resolves.toMatchObject({
      update: { message: { message_id: 2 }, update_id: 2 },
    });
  });

  it("delivers webhook updates with secret headers and blocks polling", async () => {
    const delivered: Array<{ body: unknown; secret: string | undefined }> = [];
    const webhook = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      delivered.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        secret:
          typeof request.headers["x-telegram-bot-api-secret-token"] === "string"
            ? request.headers["x-telegram-bot-api-secret-token"]
            : undefined,
      });
      response.statusCode = 200;
      response.end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Telegram webhook receiver.");
    }
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);

    try {
      const queued = await injectUpdate(server, {
        chatId: 42,
        text: "queued before webhook",
      });
      expect(queued.status).toBe(200);

      const configured = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({
            secret_token: "test-auth-token",
            url: `http://127.0.0.1:${address.port}/telegram`,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      await expect(configured.json()).resolves.toEqual({ ok: true, result: true });
      await expect.poll(() => delivered.length).toBe(1);

      const blocked = await getUpdates(server, {});
      expect(blocked.status).toBe(409);

      const inbound = await injectUpdate(server, { chatId: 42, text: "webhook update" });
      expect(inbound.status).toBe(200);
      expect(delivered).toEqual([
        {
          body: expect.objectContaining({
            message: expect.objectContaining({ text: "queued before webhook" }),
            update_id: 1,
          }),
          secret: "test-auth-token",
        },
        {
          body: expect.objectContaining({
            message: expect.objectContaining({ text: "webhook update" }),
            update_id: 2,
          }),
          secret: "test-auth-token",
        },
      ]);

      const info = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/getWebhookInfo`,
      );
      await expect(info.json()).resolves.toMatchObject({
        ok: true,
        result: {
          pending_update_count: 0,
          url: `http://127.0.0.1:${address.port}/telegram`,
        },
      });

      const removed = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({ url: "" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      await expect(removed.json()).resolves.toEqual({ ok: true, result: true });
      expect((await injectUpdate(server, { chatId: 42, text: "drop this update" })).status).toBe(
        200,
      );
      const dropped = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({ drop_pending_updates: true, url: "" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      await expect(dropped.json()).resolves.toEqual({ ok: true, result: true });
      await expect((await getUpdates(server, {})).json()).resolves.toEqual({
        ok: true,
        result: [],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("dequeues the delivered webhook update when pending updates reorder", async () => {
    const delivered: number[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let observeFirst!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    const webhook = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        update_id: number;
      };
      delivered.push(update.update_id);
      if (delivered.length === 1) {
        observeFirst();
        await firstBlocked;
      }
      response.statusCode = 200;
      response.end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Telegram webhook receiver.");
    }
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);

    try {
      expect(
        (
          await injectUpdate(server, {
            chatId: 42,
            text: "queued first",
            updateId: 10,
          })
        ).status,
      ).toBe(200);
      await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`, {
        body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/telegram` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await firstObserved;

      const lowerUpdate = injectUpdate(server, {
        chatId: 42,
        text: "lower update id",
        updateId: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseFirst();

      expect((await lowerUpdate).status).toBe(200);
      expect(delivered).toEqual([10, 5]);
    } finally {
      releaseFirst();
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reports webhook delivery failures without exposing observer errors", async () => {
    let attempts = 0;
    const webhook = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 503;
      response.end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Telegram webhook receiver.");
    }
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);
    try {
      await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`, {
        body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/telegram` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect((await injectUpdate(server, { chatId: 42, text: "retry me" })).status).toBe(502);
      await expect.poll(() => attempts, { timeout: 5_000 }).toBe(6);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(attempts).toBe(6);
      const info = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/getWebhookInfo`,
      );
      await expect(info.json()).resolves.toMatchObject({
        result: {
          last_error_date: expect.any(Number),
          last_error_message: "Wrong response from the webhook: 503",
          pending_update_count: 1,
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const failing = await startTelegramServer({
      onEvent() {
        throw new Error("sensitive Telegram observer detail");
      },
    });
    servers.push(failing);
    const response = await fetch(
      `${failing.manifest.baseUrl}/bot${failing.manifest.botToken}/getMe`,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "internal server error",
      ok: false,
    });
  });

  it("retains the most recent webhook error after a successful retry", async () => {
    let attempts = 0;
    const webhook = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = attempts === 1 ? 503 : 200;
      response.end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Telegram webhook receiver.");
    }
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);
    try {
      await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`, {
        body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/telegram` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect((await injectUpdate(server, { chatId: 42, text: "recover me" })).status).toBe(502);
      await expect.poll(() => attempts).toBe(2);

      const info = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/getWebhookInfo`,
      );
      await expect(info.json()).resolves.toMatchObject({
        result: {
          last_error_date: expect.any(Number),
          last_error_message: "Wrong response from the webhook: 503",
          pending_update_count: 0,
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not follow webhook redirects", async () => {
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => {
      redirectedRequests += 1;
      response.statusCode = 200;
      response.end();
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === "string") {
      throw new Error("Unable to resolve Telegram redirect destination.");
    }
    const webhook = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `http://127.0.0.1:${destinationAddress.port}/redirected`);
      response.end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Telegram webhook receiver.");
    }
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);
    try {
      await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`, {
        body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/telegram` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect((await injectUpdate(server, { chatId: 42, text: "do not redirect" })).status).toBe(
        502,
      );
      expect(redirectedRequests).toBe(0);
      const info = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/getWebhookInfo`,
      );
      await expect(info.json()).resolves.toMatchObject({
        result: {
          last_error_message: "Wrong response from the webhook: 302",
          pending_update_count: 1,
        },
      });
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          webhook.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          destination.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    }
  });

  it("rejects unauthenticated inbound updates", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      adminToken: "test-auth-token",
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
      botToken: "test-token-placeholder",
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

  it("supersedes an active long poll with a Telegram conflict response", async () => {
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);

    const firstPoll = getUpdates(server, { offset: 100, timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replacementPoll = getUpdates(server, { offset: 100, timeout: 30 });

    const conflicted = await firstPoll;
    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toEqual({
      description:
        "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      error_code: 409,
      ok: false,
    });

    const inbound = await injectUpdate(server, {
      chatId: "123",
      text: "replacement poll remains active",
      updateId: 100,
    });
    expect(inbound.status).toBe(200);
    await expect(replacementPoll.then((response) => response.json())).resolves.toMatchObject({
      ok: true,
      result: [{ message: { text: "replacement poll remains active" }, update_id: 100 }],
    });
  });

  it("supersedes an active long poll with a timeout-zero replacement", async () => {
    const server = await startTelegramServer({ botToken: "test-token-placeholder" });
    servers.push(server);

    const firstPoll = getUpdates(server, { offset: 100, timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replacement = await getUpdates(server, { offset: 100, timeout: 0 });

    expect(replacement.status).toBe(200);
    await expect(replacement.json()).resolves.toEqual({ ok: true, result: [] });
    const conflicted = await firstPoll;
    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toMatchObject({
      description:
        "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      error_code: 409,
      ok: false,
    });
  });

  it("supersedes an active long poll before returning queued updates", async () => {
    const pollResults: string[] = [];
    const response = await handleTelegramGetUpdates({
      body: { timeout: 30 },
      request: {} as IncomingMessage,
      state: {
        activeUpdatePoll: {
          finish(result) {
            pollResults.push(result);
          },
        },
        closing: false,
        updates: [
          {
            message: {
              chat: { id: 123, type: "private" },
              date: 1,
              from: { first_name: "QA User", id: 100001, is_bot: false },
              message_id: 1,
              text: "already queued",
            },
            update_id: 1,
          },
        ],
      },
    });

    expect(pollResults).toEqual(["conflict"]);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: [{ message: { text: "already queued" }, update_id: 1 }],
    });
  });

  it("confirms positive offsets and forgets updates before a negative offset", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramServer({
      botToken: "test-token-placeholder",
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
      botToken: "test-token-placeholder",
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
      botToken: "test-token-placeholder",
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
