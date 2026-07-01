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

function nextMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const onMessage = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length === count) {
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
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
    const authenticated = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "bot-secret" },
        seq: 1,
      }),
    );
    const [authResponse, hello] = await authenticated;
    expect(authResponse).toEqual({ seq_reply: 1, status: "OK" });
    expect(hello).toMatchObject({
      event: "hello",
      data: {
        connection_id: expect.any(String),
        server_version: expect.any(String),
      },
      broadcast: {
        channel_id: "",
        omit_users: null,
        team_id: "",
        user_id: server.manifest.botUserId,
      },
      seq: 0,
    });

    const pong = nextMessage(socket);
    socket.send(JSON.stringify({ action: "ping", data: {}, seq: 2 }));
    await expect(pong).resolves.toEqual({
      data: { text: "pong" },
      seq_reply: 2,
      status: "OK",
    });

    const unsupported = nextMessage(socket);
    socket.send(JSON.stringify({ action: "unsupported", data: {}, seq: 3 }));
    await expect(unsupported).resolves.toMatchObject({
      error: { id: "api.websocket.invalid_action" },
      seq_reply: 3,
      status: "FAIL",
    });

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
        omit_users: null,
        team_id: "",
        user_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      seq: 1,
    });

    const outboundEvent = nextMessage(socket);
    const send = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({
        channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        message: "assistant nonce-1",
      }),
      headers: { authorization: "Bearer bot-secret", "content-type": "application/json" },
      method: "POST",
    });
    expect(send.status).toBe(201);
    const sentPost = (await send.json()) as Record<string, unknown>;
    expect(sentPost).toMatchObject({
      channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      message: "assistant nonce-1",
      user_id: server.manifest.botUserId,
    });
    await expect(outboundEvent).resolves.toMatchObject({
      event: "posted",
      data: { channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa", sender_name: "crabline_bot" },
      seq: 2,
    });

    const direct = await fetch(`${server.manifest.endpoints.apiRoot}/channels/direct`, {
      body: JSON.stringify([server.manifest.botUserId, "bbbbbbbbbbbbbbbbbbbbbbbbbb"]),
      headers: { authorization: "bearer bot-secret", "content-type": "application/json" },
      method: "POST",
    });
    expect(direct.status).toBe(201);
    await expect(direct.json()).resolves.toMatchObject({ type: "D" });

    const postId = sentPost.id;
    expect(postId).toMatch(/^[a-z0-9]{26}$/u);
    const editedEvent = nextMessage(socket);
    const edited = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${postId}`, {
      body: JSON.stringify({ message: "assistant edited" }),
      headers: { authorization: "Bearer bot-secret", "content-type": "application/json" },
      method: "PUT",
    });
    expect(edited.status).toBe(200);
    await expect(editedEvent).resolves.toMatchObject({ event: "post_edited", seq: 3 });

    const deletedEvent = nextMessage(socket);
    const deleted = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${postId}`, {
      headers: { authorization: "Bearer bot-secret" },
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    await expect(deletedEvent).resolves.toMatchObject({ event: "post_deleted", seq: 4 });
    socket.close();

    const recorded = await fs.readFile(recorderPath, "utf8");
    expect(recorded).toContain('"path":"/crabline/mattermost/inbound"');
    expect(recorded).toContain('"path":"/api/v4/posts"');
  });
});
