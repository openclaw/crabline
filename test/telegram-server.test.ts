import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTelegramServer, type StartedTelegramServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedTelegramServer[] = [];
const directories: string[] = [];

function adminHeaders(server: StartedTelegramServer) {
  return {
    "content-type": "application/json",
    "x-crabline-admin-token": server.manifest.adminToken,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("telegram local provider server", () => {
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
