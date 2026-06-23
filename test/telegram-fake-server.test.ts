import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTelegramFakeServer, type StartedTelegramFakeServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedTelegramFakeServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("telegram fake provider server", () => {
  it("distinguishes ordinary groups from supergroups", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramFakeServer({
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
    const server = await startTelegramFakeServer({
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

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatId: "-1001234567890",
        fromId: 100001,
        messageThreadId: 42,
        text: "user nonce-1",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(inbound.json()).resolves.toMatchObject({
      ok: true,
      update: {
        message: {
          chat: { id: -1001234567890 },
          from: { id: 100001, is_bot: false },
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

  it("keeps generated inbound IDs above explicit IDs", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startTelegramFakeServer({
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
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(generatedInbound.json()).resolves.toMatchObject({
      update: {
        message: { message_id: 201 },
        update_id: 101,
      },
    });
  });
});
