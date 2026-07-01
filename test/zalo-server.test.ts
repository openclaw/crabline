import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startZaloServer, type StartedZaloServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedZaloServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function adminHeaders(server: StartedZaloServer) {
  return {
    "content-type": "application/json",
    "x-crabline-admin-token": server.manifest.adminToken,
  };
}

describe("Zalo local provider server", () => {
  it("serves the Bot API and delivers admin inbound through getUpdates", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "zalo.jsonl");
    const server = await startZaloServer({ botToken: "zalo-token", recorderPath });
    servers.push(server);

    const getMe = await fetch(`${server.manifest.baseUrl}/botzalo-token/getMe`, {
      method: "POST",
    });
    await expect(getMe.json()).resolves.toMatchObject({
      ok: true,
      result: {
        account_name: "bot.crabline",
        account_type: "BASIC",
        can_join_groups: true,
        id: "1459232241454765289",
      },
    });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatId: "group-1",
        chatType: "GROUP",
        senderId: "user-1",
        senderName: "Alice",
        text: "user nonce-1",
      }),
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(inbound.ok).toBe(true);

    const updates = await fetch(`${server.manifest.baseUrl}/botzalo-token/getUpdates`, {
      body: JSON.stringify({ timeout: "0" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(updates.json()).resolves.toMatchObject({
      ok: true,
      result: {
        event_name: "message.text.received",
        message: {
          chat: { chat_type: "GROUP", id: "group-1" },
          from: { display_name: "Alice", id: "user-1", is_bot: false },
          text: "user nonce-1",
        },
      },
    });

    const timeout = await fetch(`${server.manifest.baseUrl}/botzalo-token/getUpdates?timeout=0`);
    expect(timeout.status).toBe(408);
    await expect(timeout.json()).resolves.toMatchObject({ error_code: 408, ok: false });

    const sendMessage = await fetch(
      `${server.manifest.baseUrl}/botzalo-token/sendMessage?chat_id=group-1&text=hello`,
    );
    await expect(sendMessage.json()).resolves.toMatchObject({
      ok: true,
      result: { message_id: expect.any(String) },
    });

    const recorder = await fs.readFile(recorderPath, "utf8");
    expect(recorder).toContain('"path":"/bot<redacted>/sendMessage"');
    expect(recorder).not.toContain("zalo-token");
  });

  it("delivers native webhook envelopes with the configured secret header", async () => {
    const received: Array<{ body: unknown; secret?: string }> = [];
    const webhook = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const secret = request.headers["x-bot-api-secret-token"];
      received.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        ...(typeof secret === "string" ? { secret } : {}),
      });
      response.statusCode = 200;
      response.end("ok");
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }

    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "zalo-webhook.jsonl");
    const server = await startZaloServer({ botToken: "zalo-token", recorderPath });
    servers.push(server);
    try {
      const setWebhook = await fetch(`${server.manifest.baseUrl}/botzalo-token/setWebhook`, {
        body: JSON.stringify({
          secret_token: "webhook-secret",
          url: `http://127.0.0.1:${address.port}/zalo`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(setWebhook.ok).toBe(true);

      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "hello" }),
        headers: adminHeaders(server),
        method: "POST",
      });
      expect(inbound.ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        body: {
          event_name: "message.text.received",
          message: { text: "hello" },
        },
        secret: "webhook-secret",
      });

      const blockedPolling = await fetch(
        `${server.manifest.baseUrl}/botzalo-token/getUpdates?timeout=0`,
      );
      expect(blockedPolling.status).toBe(400);

      const recorder = await fs.readFile(recorderPath, "utf8");
      expect(recorder).toContain('"secret_token":"<redacted>"');
      expect(recorder).not.toContain("webhook-secret");
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects invalid bot tokens and unauthenticated admin ingress", async () => {
    const server = await startZaloServer({ botToken: "zalo-token" });
    servers.push(server);

    const invalidToken = await fetch(`${server.manifest.baseUrl}/botwrong/getMe`);
    expect(invalidToken.status).toBe(401);
    await expect(invalidToken.json()).resolves.toMatchObject({ error_code: 401, ok: false });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(inbound.status).toBe(401);
  });
});
