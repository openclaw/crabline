import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createOpenClawCrablineInbound,
  startTelegramServer,
  type StartedTelegramServer,
} from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedTelegramServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function start() {
  const directory = await createTempDir();
  directories.push(directory);
  const events: unknown[] = [];
  const server = await startTelegramServer({
    recorderPath: path.join(directory, "telegram.jsonl"),
    onEvent: (event) => {
      events.push(event);
    },
  });
  servers.push(server);
  const post = (url: string, body: Record<string, unknown>, admin = false) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(admin ? { "x-crabline-admin-token": server.manifest.adminToken } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    server,
    events,
    api: (method: string, body: Record<string, unknown>) =>
      post(`${server.manifest.baseUrl}/bot${server.manifest.botToken}/${method}`, body),
    inject: (body: Record<string, unknown>) =>
      post(server.manifest.endpoints.adminInboundUrl, body, true),
  };
}

it("records assigned send IDs and delivers replies to edited bot messages", async () => {
  const { api, inject, events } = await start();
  const sent = await api("sendMessage", { chat_id: 42, text: "original" });
  expect(sent.status).toBe(200);
  await expect(sent.json()).resolves.toMatchObject({ result: { message_id: 1 } });
  expect(events).toContainEqual(expect.objectContaining({ accepted: true, messageId: 1 }));
  expect(
    (await api("editMessageText", { chat_id: 42, message_id: 1, text: "edited" })).status,
  ).toBe(200);
  const reply = await inject({ chatId: 42, text: "reply", replyToMessageId: "1" });
  expect(reply.status).toBe(200);
  await expect(reply.json()).resolves.toMatchObject({
    update: {
      message: {
        message_id: 2,
        reply_to_message: { message_id: 1, text: "edited", from: { is_bot: true } },
      },
    },
  });
  const updates = await api("getUpdates", {});
  await expect(updates.json()).resolves.toMatchObject({
    result: [{ message: { reply_to_message: { message_id: 1, text: "edited" } } }],
  });
});

it("quotes inbound and media messages without nested reply chains", async () => {
  const { api, inject } = await start();
  expect((await inject({ chatId: 42, text: "first" })).status).toBe(200);
  expect((await inject({ chatId: 42, text: "second", replyToMessageId: 1 })).status).toBe(200);
  const third = await inject({ chatId: 42, text: "third", reply_to_message_id: 2 });
  const thirdBody = (await third.json()) as {
    update: { message: { reply_to_message?: { text?: string; reply_to_message?: unknown } } };
  };
  expect(thirdBody.update.message.reply_to_message?.text).toBe("second");
  expect(thirdBody.update.message.reply_to_message).not.toHaveProperty("reply_to_message");
  expect(
    (await api("sendPhoto", { chat_id: 42, photo: "photo-id", caption: "photo" })).status,
  ).toBe(200);
  const mediaReply = await inject({ chatId: 42, text: "media reply", replyToMessageId: 4 });
  await expect(mediaReply.json()).resolves.toMatchObject({
    update: {
      message: {
        reply_to_message: { message_id: 4, caption: "photo", photo: [expect.any(Object)] },
      },
    },
  });
});

it("rejects unknown, invalid and cross-thread replies without consuming IDs", async () => {
  const { api, inject } = await start();
  expect(
    (await api("sendMessage", { chat_id: 42, message_thread_id: 10, text: "topic" })).status,
  ).toBe(200);
  expect(
    (await api("editMessageText", { chat_id: 42, message_id: 1, text: "edited topic" })).status,
  ).toBe(200);
  for (const body of [
    { chatId: 42, messageThreadId: 10, replyToMessageId: 99 },
    { chatId: 43, messageThreadId: 10, replyToMessageId: 1 },
    { chatId: 42, messageThreadId: 11, replyToMessageId: 1 },
    { chatId: 42, messageThreadId: 10, replyToMessageId: -1 },
    { chatId: 42, messageThreadId: 10, replyToMessageId: "nope" },
    { chatId: 42, messageThreadId: 10, replyToMessageId: null },
    { chatId: 42, messageThreadId: 10, replyToMessageId: 1, reply_to_message_id: 2 },
  ]) {
    const response = await inject({ ...body, text: "invalid" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      description: "Bad Request: message to be replied not found",
    });
  }
  const valid = await inject({
    chatId: 42,
    messageThreadId: 10,
    replyToMessageId: 1,
    text: "valid",
  });
  await expect(valid.json()).resolves.toMatchObject({
    update: {
      update_id: 1,
      message: { message_id: 2, reply_to_message: { message_id: 1, message_thread_id: 10 } },
    },
  });
});

it("forwards provider reply IDs through the OpenClaw bridge", async () => {
  const { server } = await start();
  const inbound = createOpenClawCrablineInbound({
    manifest: server.manifest,
    input: {
      conversation: { id: "42", kind: "direct" },
      senderId: "42",
      text: "reply",
      replyToId: "1",
    },
  });
  expect(inbound.providerBody).toMatchObject({ chatId: "42", replyToMessageId: "1" });
});
