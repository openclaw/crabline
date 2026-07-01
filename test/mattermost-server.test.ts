import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startMattermostServer, type StartedMattermostServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedMattermostServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    socket.once("error", reject);
  });
}

describe("Mattermost local provider server", () => {
  it("serves authenticated REST and delivers admin inbound over the native WebSocket", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "mattermost.jsonl");
    const server = await startMattermostServer({
      adminToken: "admin-secret",
      botToken: "bot-secret",
      recorderPath,
    });
    servers.push(server);

    const unauthorized = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`);
    expect(unauthorized.status).toBe(401);

    const me = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`, {
      headers: { authorization: "Bearer bot-secret" },
    });
    await expect(me.json()).resolves.toMatchObject({
      id: server.manifest.botUserId,
      username: "crabline_bot",
    });

    const socket = new WebSocket(server.manifest.endpoints.websocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "bot-secret" },
        seq: 1,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({ seq_reply: 1, status: "OK" });

    const inboundMessage = nextMessage(socket);
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        channelType: "O",
        senderId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
        senderName: "alice",
        text: "user nonce-1",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin-secret",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    await expect(inboundMessage).resolves.toMatchObject({
      event: "posted",
      data: { channel_type: "O", sender_name: "alice" },
      broadcast: {
        channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        user_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    const send = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({
        channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        message: "assistant nonce-1",
      }),
      headers: { authorization: "Bearer bot-secret", "content-type": "application/json" },
      method: "POST",
    });
    expect(send.status).toBe(201);
    await expect(send.json()).resolves.toMatchObject({
      channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      message: "assistant nonce-1",
      user_id: server.manifest.botUserId,
    });
    socket.close();

    const recorded = await fs.readFile(recorderPath, "utf8");
    expect(recorded).toContain('"path":"/crabline/mattermost/inbound"');
    expect(recorded).toContain('"path":"/api/v4/posts"');
  });
});
