import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "node:http";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startMattermostServer, type StartedMattermostServer } from "../src/index.js";
import { mattermostId } from "../src/servers/mattermost.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

const servers: StartedMattermostServer[] = [];
const directories: string[] = [];
const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_CHANNEL_ID = "cccccccccccccccccccccccccc";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_USER_ID = "dddddddddddddddddddddddddd";
const ROOT_ID = "eeeeeeeeeeeeeeeeeeeeeeeeee";

type MattermostLifecyclePost = {
  delete_at: number;
  edit_at: number;
  update_at: number;
};

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

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once("error", reject);
  });
}

function expectNoSocketMessage(socket: WebSocket, timeoutMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve();
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected WebSocket message: ${data.toString()}`));
    };
    socket.once("message", onMessage);
  });
}

describe("Mattermost local provider server", () => {
  it("returns Mattermost errors for non-object and oversized request bodies", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMattermostServer({
      botToken: "fake",
      recorderPath: path.join(directory, "mattermost-bodies.jsonl"),
    });
    servers.push(server);
    const postsUrl = `${server.manifest.endpoints.apiRoot}/posts`;

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalid = await fetch(postsUrl, {
        body: scalarBody,
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        message: "Request body must be a JSON object",
        status_code: 400,
      });
    }

    const malformed = await fetch(postsUrl, {
      body: "{",
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      message: "Request body is not valid JSON",
      status_code: 400,
    });

    const oversized = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        authorization: "Bearer fake",
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: postsUrl,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toMatchObject({
      message: "Request body is too large",
      status_code: 413,
    });

    for (const body of [
      { channel_id: 123, message: "numeric channel" },
      { channel_id: CHANNEL_ID, message: 123 },
      { channel_id: CHANNEL_ID, message: "reply", root_id: 123 },
    ]) {
      const invalid = await fetch(postsUrl, {
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        request_id: expect.stringMatching(/^[a-z0-9]{26}$/u),
        status_code: 400,
      });
    }

    const invalidDirect = await fetch(`${server.manifest.endpoints.apiRoot}/channels/direct`, {
      body: JSON.stringify([server.manifest.botUserId, 123]),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(invalidDirect.status).toBe(400);

    for (const contentType of [undefined, "application/x-www-form-urlencoded"]) {
      const nonJson = await fetch(postsUrl, {
        body: JSON.stringify({ channel_id: CHANNEL_ID, message: "not JSON media" }),
        headers: {
          authorization: "Bearer fake",
          ...(contentType ? { "content-type": contentType } : {}),
        },
        method: "POST",
      });
      expect(nonJson.status).toBe(415);
      await expect(nonJson.json()).resolves.toMatchObject({
        id: "api.context.unsupported_content_type.app_error",
        message: "Content-Type must be application/json.",
        status_code: 415,
      });
    }
  });

  it("requires native Mattermost IDs on admin ingress", async () => {
    const server = await startMattermostServer({ adminToken: "admin" });
    servers.push(server);

    for (const [body, error] of [
      [
        { channelId: "short", senderId: USER_ID, text: "invalid channel" },
        "channelId must be a 26-character Mattermost ID",
      ],
      [
        { channelId: "A".repeat(26), senderId: USER_ID, text: "invalid channel alphabet" },
        "channelId must be a 26-character Mattermost ID",
      ],
      [
        { channelId: `${CHANNEL_ID}\n`, senderId: USER_ID, text: "invalid channel terminator" },
        "channelId must be a 26-character Mattermost ID",
      ],
      [
        { channelId: CHANNEL_ID, senderId: "short", text: "invalid sender" },
        "senderId must be a 26-character Mattermost ID",
      ],
      [
        { channelId: CHANNEL_ID, rootId: "short", senderId: USER_ID, text: "invalid root" },
        "rootId must be a 26-character Mattermost ID",
      ],
      [
        { channelId: CHANNEL_ID, rootId: 123, senderId: USER_ID, text: "numeric root" },
        "rootId must be a string",
      ],
      [
        { channelId: CHANNEL_ID, root_id: {}, senderId: USER_ID, text: "object root" },
        "root_id must be a string",
      ],
    ]) {
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error,
        ok: false,
      });
    }
  });

  it("returns native route errors with request IDs and parses Bearer credentials exactly", async () => {
    const server = await startMattermostServer({ botToken: "fake" });
    servers.push(server);

    for (const authorization of ["Bearer  fake", "Bearer\tfake", "Basic fake"]) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`, {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        detailed_error: "",
        id: "api.context.session_expired.app_error",
        message: "Invalid or expired session, please login again.",
        request_id: expect.stringMatching(/^[a-z0-9]{26}$/u),
        status_code: 401,
      });
    }

    const requestIds: string[] = [];
    for (const url of [
      `${server.manifest.endpoints.apiRoot}/missing`,
      `${server.manifest.baseUrl}/missing`,
    ]) {
      const response = await fetch(url, {
        headers: { authorization: "Bearer fake" },
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as {
        id: string;
        request_id: string;
        status_code: number;
      };
      expect(body).toMatchObject({
        id: "api.context.404.app_error",
        status_code: 404,
      });
      expect(body.request_id).toMatch(/^[a-z0-9]{26}$/u);
      requestIds.push(body.request_id);
    }
    expect(new Set(requestIds).size).toBe(requestIds.length);

    const accepted = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`, {
      headers: { authorization: "bEaReR fake" },
    });
    expect(accepted.status).toBe(200);
  });

  it("serves authenticated REST and delivers admin inbound over the native WebSocket", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "mattermost.jsonl");
    const server = await startMattermostServer({
      adminToken: "test-auth-token",
      botToken: "fake",
      recorderPath,
    });
    servers.push(server);

    const unauthorized = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`);
    expect(unauthorized.status).toBe(401);

    const me = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`, {
      headers: { authorization: "Bearer fake" },
    });
    await expect(me.json()).resolves.toMatchObject({
      id: server.manifest.botUserId,
      username: "crabline_bot",
    });

    const socket = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(socket);
    const authenticated = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "fake" },
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
        channelDisplayName: "Town Square",
        channelId: CHANNEL_ID,
        channelName: "town-square",
        channelType: "O",
        senderId: USER_ID,
        senderName: "alice",
        text: "user nonce-1",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "test-auth-token",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    await expect(inboundMessage).resolves.toMatchObject({
      event: "posted",
      data: {
        channel_display_name: "Town Square",
        channel_name: "town-square",
        channel_type: "O",
        sender_name: "alice",
      },
      broadcast: {
        channel_id: CHANNEL_ID,
        omit_users: null,
        team_id: "",
        user_id: "",
      },
      seq: 1,
    });

    const outboundEvent = nextMessage(socket);
    const send = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({
        channel_id: CHANNEL_ID,
        message: "assistant nonce-1",
      }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(send.status).toBe(201);
    const sentPost = (await send.json()) as Record<string, unknown>;
    expect(sentPost).toMatchObject({
      channel_id: CHANNEL_ID,
      create_at: expect.any(Number),
      delete_at: 0,
      edit_at: 0,
      message: "assistant nonce-1",
      update_at: expect.any(Number),
      user_id: server.manifest.botUserId,
    });
    await expect(outboundEvent).resolves.toMatchObject({
      event: "posted",
      data: {
        channel_display_name: "Town Square",
        channel_name: "town-square",
        sender_name: "crabline_bot",
      },
      broadcast: { channel_id: CHANNEL_ID, user_id: "" },
      seq: 2,
    });

    const direct = await fetch(`${server.manifest.endpoints.apiRoot}/channels/direct`, {
      body: JSON.stringify([server.manifest.botUserId, USER_ID]),
      headers: {
        authorization: "bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(direct.status).toBe(201);
    await expect(direct.json()).resolves.toMatchObject({
      name: [server.manifest.botUserId, USER_ID].sort().join("__"),
      type: "D",
    });

    const postId = sentPost.id;
    expect(postId).toMatch(/^[a-z0-9]{26}$/u);
    const editedEvent = nextMessage(socket);
    const edited = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${postId}`, {
      body: JSON.stringify({ message: "assistant edited" }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "PUT",
    });
    expect(edited.status).toBe(200);
    const editedPost = (await edited.json()) as {
      edit_at: number;
      update_at: number;
    };
    expect(editedPost.edit_at).toBeGreaterThan(Number(sentPost.update_at));
    expect(editedPost.update_at).toBe(editedPost.edit_at);
    const editedMessage = await editedEvent;
    expect(editedMessage).toMatchObject({
      broadcast: { channel_id: CHANNEL_ID, user_id: "" },
      event: "post_edited",
      seq: 3,
    });
    const editedEventPost = JSON.parse(
      (editedMessage.data as { post: string }).post,
    ) as MattermostLifecyclePost;
    expect(editedEventPost).toMatchObject({
      delete_at: 0,
      edit_at: editedPost.edit_at,
      update_at: editedPost.update_at,
    });

    const deletedEvent = nextMessage(socket);
    const deleted = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${postId}`, {
      headers: { authorization: "Bearer fake" },
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ status: "OK" });
    const deletedMessage = await deletedEvent;
    expect(deletedMessage).toMatchObject({
      broadcast: { channel_id: CHANNEL_ID, user_id: "" },
      event: "post_deleted",
      seq: 4,
    });
    const deletedEventPost = JSON.parse(
      (deletedMessage.data as { post: string }).post,
    ) as MattermostLifecyclePost;
    expect(deletedEventPost.delete_at).toBeGreaterThan(editedPost.update_at);
    expect(deletedEventPost.update_at).toBe(deletedEventPost.delete_at);
    socket.close();

    const recorded = await fs.readFile(recorderPath, "utf8");
    expect(recorded).toContain('"path":"/crabline/mattermost/inbound"');
    expect(recorded).toContain('"path":"/api/v4/posts"');
    expect(recorded).toContain('"accepted":true');
  });

  it("preserves committed REST mutation success when recording callbacks fail", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "mattermost-committed.jsonl");
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
      onEvent(event) {
        if (event.type === "api") {
          throw new Error("observer failed");
        }
      },
      recorderPath,
    });
    servers.push(server);
    const registered = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        senderId: USER_ID,
        text: "register user",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(registered.status).toBe(200);

    const direct = await fetch(`${server.manifest.endpoints.apiRoot}/channels/direct`, {
      body: JSON.stringify([server.manifest.botUserId, USER_ID]),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(direct.status).toBe(201);
    const channel = (await direct.json()) as { id: string };

    const post = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({ channel_id: channel.id, message: "committed once" }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(post.status).toBe(201);
    await expect(post.json()).resolves.toMatchObject({
      channel_id: channel.id,
      message: "committed once",
    });

    const records = (await fs.readFile(recorderPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { accepted?: boolean; path: string });
    expect(records).toContainEqual(
      expect.objectContaining({ accepted: true, path: "/api/v4/posts" }),
    );
  });

  it("expires silent and invalid WebSocket authentication", async () => {
    const server = await startMattermostServer({
      botToken: "fake",
      websocketAuthenticationTimeoutMs: 25,
    });
    servers.push(server);

    const silent = new WebSocket(server.manifest.endpoints.websocketUrl);
    const silentClosed = waitForSocketClose(silent);
    await waitForSocketOpen(silent);
    await expect(silentClosed).resolves.toEqual({
      code: 4001,
      reason: "authentication timeout",
    });

    const invalid = new WebSocket(server.manifest.endpoints.websocketUrl);
    const invalidClosed = waitForSocketClose(invalid);
    await waitForSocketOpen(invalid);
    const failure = nextMessage(invalid);
    invalid.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "not-a-real" },
        seq: 1,
      }),
    );
    await expect(failure).resolves.toMatchObject({ seq_reply: 1, status: "FAIL" });
    await expect(invalidClosed).resolves.toEqual({
      code: 4001,
      reason: "authentication failed",
    });
  });

  it("rejects admin inbound when the disconnected event queue is full", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      maxPendingInboundEvents: 1,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ channelId: CHANNEL_ID, senderId: USER_ID, text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    expect((await sendInbound("first")).status).toBe(200);
    const overloaded = await sendInbound("second");
    expect(overloaded.status).toBe(503);
    await expect(overloaded.json()).resolves.toMatchObject({
      error: "Pending inbound queue is full (1 events)",
      ok: false,
    });
  });

  it("keeps REST mutations independent from disconnected WebSocket delivery", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
      maxPendingInboundEvents: 2,
    });
    servers.push(server);
    const registered = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ channelId: CHANNEL_ID, senderId: USER_ID, text: "register user" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(registered.status).toBe(200);
    const direct = await fetch(`${server.manifest.endpoints.apiRoot}/channels/direct`, {
      body: JSON.stringify([server.manifest.botUserId, USER_ID]),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const channel = (await direct.json()) as { id: string };

    for (const message of ["first REST post", "second REST post"]) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
        body: JSON.stringify({ channel_id: channel.id, message }),
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(201);
    }

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ channelId: channel.id, senderId: USER_ID, text: "queued inbound" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
  });

  it("rejects posts and typing for unknown channels", async () => {
    const server = await startMattermostServer({ botToken: "fake" });
    servers.push(server);
    for (const [apiPath, body] of [
      ["/posts", { channel_id: "missing", message: "hello" }],
      ["/users/me/typing", { channel_id: "missing" }],
    ] as const) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}${apiPath}`, {
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        message: "Channel not found",
        status_code: 404,
      });
    }
  });

  it("requires distinct known users for direct channels", async () => {
    const server = await startMattermostServer({ adminToken: "admin", botToken: "fake" });
    servers.push(server);
    for (const senderId of [USER_ID, OTHER_USER_ID]) {
      const registered = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ channelId: CHANNEL_ID, senderId, text: "register" }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
      expect(registered.status).toBe(200);
    }

    for (const [userIds, status, message] of [
      [[USER_ID, USER_ID], 400, "Direct channel users must be distinct"],
      [[server.manifest.botUserId, "missing"], 404, "User not found"],
      [[USER_ID, OTHER_USER_ID], 403, "Authenticated user must belong to the direct channel"],
      [[server.manifest.botUserId, USER_ID], 201, undefined],
    ] as const) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}/channels/direct`, {
        body: JSON.stringify(userIds),
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject(message ? { message } : { type: "D" });
    }
  });

  it("uses root_id for post threading and restricts mutations to bot-owned posts", async () => {
    const server = await startMattermostServer({ adminToken: "admin", botToken: "fake" });
    servers.push(server);
    const inboundPosts: Array<{ channel_id: string; id: string }> = [];
    for (const [channelId, text] of [
      [CHANNEL_ID, "user root"],
      [OTHER_CHANNEL_ID, "other root"],
    ]) {
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ channelId, senderId: USER_ID, text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { post: { channel_id: string; id: string } };
      inboundPosts.push(payload.post);
    }
    const [root, otherRoot] = inboundPosts as [
      { channel_id: string; id: string },
      { channel_id: string; id: string },
    ];

    const ignoredPostId = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({
        channel_id: root.channel_id,
        message: "top-level bot post",
        post_id: root.id,
        root_id: "",
      }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(ignoredPostId.status).toBe(201);
    await expect(ignoredPostId.json()).resolves.toMatchObject({ root_id: "" });

    const reply = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({
        channel_id: root.channel_id,
        message: "bot reply",
        root_id: root.id,
      }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(reply.status).toBe(201);
    const replyPost = (await reply.json()) as { id: string; root_id: string };
    expect(replyPost).toMatchObject({ root_id: root.id });

    for (const [rootId, status, message] of [
      ["missing-root", 404, "Root post not found"],
      [otherRoot.id, 400, "Root post belongs to another channel"],
      [replyPost.id, 400, "Root post is itself a reply"],
    ] as const) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
        body: JSON.stringify({
          channel_id: root.channel_id,
          message: "invalid reply",
          root_id: rootId,
        }),
        headers: {
          authorization: "Bearer fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ message });
    }

    const nestedAdminReply = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: root.channel_id,
        rootId: replyPost.id,
        senderId: USER_ID,
        text: "invalid nested reply",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(nestedAdminReply.status).toBe(400);
    await expect(nestedAdminReply.json()).resolves.toEqual({
      error: "Root post is itself a reply",
      ok: false,
    });

    for (const method of ["PUT", "DELETE"] as const) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${root.id}`, {
        ...(method === "PUT"
          ? {
              body: JSON.stringify({ message: "forbidden edit" }),
              headers: {
                authorization: "Bearer fake",
                "content-type": "application/json",
              },
            }
          : { headers: { authorization: "Bearer fake" } }),
        method,
      });
      expect(response.status).toBe(403);
    }
  });

  it("materializes missing roots for admin-injected thread replies", async () => {
    const server = await startMattermostServer({ adminToken: "admin", botToken: "fake" });
    servers.push(server);

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        rootId: ROOT_ID,
        senderId: USER_ID,
        text: "user thread reply",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    await expect(inbound.json()).resolves.toMatchObject({
      post: { channel_id: CHANNEL_ID, root_id: ROOT_ID, user_id: USER_ID },
    });

    const reply = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({
        channel_id: CHANNEL_ID,
        message: "bot thread reply",
        root_id: ROOT_ID,
      }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(reply.status).toBe(201);
    await expect(reply.json()).resolves.toMatchObject({
      channel_id: CHANNEL_ID,
      root_id: ROOT_ID,
      user_id: server.manifest.botUserId,
    });

    const rootMutation = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${ROOT_ID}`, {
      body: JSON.stringify({ message: "forbidden root edit" }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "PUT",
    });
    expect(rootMutation.status).toBe(403);
  });

  it("keeps typing channel-scoped, omitted from the sender, and ephemeral", async () => {
    const server = await startMattermostServer({ adminToken: "admin", botToken: "fake" });
    servers.push(server);
    const socket = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(socket);
    const authenticated = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "fake" },
        seq: 1,
      }),
    );
    await authenticated;

    const posted = nextMessage(socket);
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ channelId: CHANNEL_ID, senderId: USER_ID, text: "register" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    await expect(posted).resolves.toMatchObject({ event: "posted" });

    const noRestTypingEvent = expectNoSocketMessage(socket);
    const restTyping = await fetch(`${server.manifest.endpoints.apiRoot}/users/me/typing`, {
      body: JSON.stringify({ channel_id: CHANNEL_ID }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(restTyping.status).toBe(200);
    await expect(restTyping.json()).resolves.toEqual({ status: "OK" });
    await noRestTypingEvent;

    const typingAck = nextMessage(socket);
    socket.send(
      JSON.stringify({
        action: "user_typing",
        data: { channel_id: CHANNEL_ID, parent_id: "root-1" },
        seq: 2,
      }),
    );
    await expect(typingAck).resolves.toEqual({ seq_reply: 2, status: "OK" });

    const rejected = nextMessage(socket);
    socket.send(
      JSON.stringify({
        action: "user_typing",
        data: { channel_id: "missing" },
        seq: 3,
      }),
    );
    await expect(rejected).resolves.toMatchObject({
      error: { id: "api.channel.get.find.app_error" },
      seq_reply: 3,
      status: "FAIL",
    });
    const closed = waitForSocketClose(socket);
    socket.close();
    await closed;

    const reconnected = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(reconnected);
    const reauthenticated = nextMessages(reconnected, 2);
    reconnected.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "fake" },
        seq: 4,
      }),
    );
    await reauthenticated;
    await expectNoSocketMessage(reconnected);
    reconnected.close();
  });

  it("preserves known user and channel metadata when later ingress omits it", async () => {
    const server = await startMattermostServer({ adminToken: "admin", botToken: "fake" });
    servers.push(server);
    for (const body of [
      {
        channelId: CHANNEL_ID,
        channelType: "O",
        senderId: USER_ID,
        senderName: "Alice",
        text: "first",
      },
      { channelId: CHANNEL_ID, senderId: USER_ID, text: "second" },
    ]) {
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
    }

    const user = await fetch(`${server.manifest.endpoints.apiRoot}/users/${USER_ID}`, {
      headers: { authorization: "Bearer fake" },
    });
    await expect(user.json()).resolves.toMatchObject({ username: "Alice" });
    const channel = await fetch(`${server.manifest.endpoints.apiRoot}/channels/${CHANNEL_ID}`, {
      headers: { authorization: "Bearer fake" },
    });
    await expect(channel.json()).resolves.toMatchObject({ type: "O" });
  });

  it("returns a native client error for malformed escaped path segments", async () => {
    const server = await startMattermostServer({ botToken: "fake" });
    servers.push(server);
    const response = await fetch(`${server.manifest.endpoints.apiRoot}/users/username/%`, {
      headers: { authorization: "Bearer fake" },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: "Invalid path parameter",
      status_code: 400,
    });
  });

  it("distinguishes oversized inbound events from a full disconnected queue", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
      maxPendingInboundEvents: 1,
      maxWebSocketBufferedBytes: 1024,
    });
    servers.push(server);
    const socket = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(socket);
    const authenticated = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "fake" },
        seq: 1,
      }),
    );
    await authenticated;
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ channelId: CHANNEL_ID, senderId: USER_ID, text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    const noOversizedEvent = expectNoSocketMessage(socket);
    const oversized = await sendInbound("x".repeat(2_000));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "Inbound event is too large",
      ok: false,
    });
    await noOversizedEvent;
    for (const apiPath of [`/users/${USER_ID}`, `/channels/${CHANNEL_ID}`]) {
      const response = await fetch(`${server.manifest.endpoints.apiRoot}${apiPath}`, {
        headers: { authorization: "Bearer fake" },
      });
      expect(response.status).toBe(404);
    }

    const delivered = nextMessage(socket);
    expect((await sendInbound("delivered after oversized event")).status).toBe(200);
    await expect(delivered).resolves.toMatchObject({ event: "posted" });
    const closed = waitForSocketClose(socket);
    socket.close();
    await closed;

    expect((await sendInbound("queued after oversized event")).status).toBe(200);
    expect((await sendInbound("queue is full")).status).toBe(503);
  });

  it("rejects oversized REST events atomically without disconnecting other clients", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
      maxWebSocketBufferedBytes: 1024,
    });
    servers.push(server);
    const registered = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ channelId: CHANNEL_ID, senderId: USER_ID, text: "register" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(registered.status).toBe(200);

    const first = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(first);
    const firstAuthenticated = nextMessages(first, 3);
    first.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "fake" },
        seq: 1,
      }),
    );
    await firstAuthenticated;

    const second = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(second);
    const secondAuthenticated = nextMessages(second, 2);
    second.send(
      JSON.stringify({
        action: "authentication_challenge",
        data: { token: "fake" },
        seq: 1,
      }),
    );
    await secondAuthenticated;

    const firstQuiet = expectNoSocketMessage(first);
    const secondQuiet = expectNoSocketMessage(second);
    const oversized = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({ channel_id: CHANNEL_ID, message: "x".repeat(2_000) }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      message: "WebSocket event is too large",
      status_code: 413,
    });
    await Promise.all([firstQuiet, secondQuiet]);
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(second.readyState).toBe(WebSocket.OPEN);

    const firstDelivered = nextMessage(first);
    const secondDelivered = nextMessage(second);
    const accepted = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({ channel_id: CHANNEL_ID, message: "accepted after rejection" }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      id: mattermostId("post-2"),
      message: "accepted after rejection",
    });
    await expect(firstDelivered).resolves.toMatchObject({ event: "posted" });
    await expect(secondDelivered).resolves.toMatchObject({ event: "posted" });
    first.close();
    second.close();
  });

  it("rejects an oversized delete event before removing the post", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
      maxWebSocketBufferedBytes: 1024,
    });
    servers.push(server);
    const registered = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ channelId: CHANNEL_ID, senderId: USER_ID, text: "register" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(registered.status).toBe(200);

    const created = await fetch(`${server.manifest.endpoints.apiRoot}/posts`, {
      body: JSON.stringify({ channel_id: CHANNEL_ID, message: "small post" }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const post = (await created.json()) as { id: string };
    expect(created.status).toBe(201);

    const boundaryEdit = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${post.id}`, {
      body: JSON.stringify({ message: "x".repeat(573) }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "PUT",
    });
    expect(boundaryEdit.status).toBe(200);

    const rejectedDelete = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${post.id}`, {
      headers: { authorization: "Bearer fake" },
      method: "DELETE",
    });
    expect(rejectedDelete.status).toBe(413);
    await expect(rejectedDelete.json()).resolves.toMatchObject({
      message: "WebSocket event is too large",
      status_code: 413,
    });

    const stillPresent = await fetch(`${server.manifest.endpoints.apiRoot}/posts/${post.id}`, {
      body: JSON.stringify({ message: "still present" }),
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/json",
      },
      method: "PUT",
    });
    expect(stillPresent.status).toBe(200);
  });

  it("bounds unauthenticated clients and inbound WebSocket messages", async () => {
    const server = await startMattermostServer({
      botToken: "fake",
      maxUnauthenticatedWebSocketClients: 1,
      maxWebSocketMessageBytes: 32,
    });
    servers.push(server);

    const first = new WebSocket(server.manifest.endpoints.websocketUrl);
    await waitForSocketOpen(first);
    const second = new WebSocket(server.manifest.endpoints.websocketUrl);
    const secondClosed = waitForSocketClose(second);
    await waitForSocketOpen(second);
    await expect(secondClosed).resolves.toMatchObject({ code: 1006 });
    const third = new WebSocket(server.manifest.endpoints.websocketUrl);
    const thirdClosed = waitForSocketClose(third);
    await waitForSocketOpen(third);
    await expect(thirdClosed).resolves.toMatchObject({ code: 1006 });

    const firstClosed = waitForSocketClose(first);
    first.send(JSON.stringify({ action: "x".repeat(64) }));
    await expect(firstClosed).resolves.toMatchObject({ code: 1009 });
    const me = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`, {
      headers: { authorization: "Bearer fake" },
    });
    expect(me.status).toBe(200);
  });

  it("rejects non-object WebSocket messages without crashing", async () => {
    const server = await startMattermostServer({ botToken: "fake" });
    servers.push(server);
    const socket = new WebSocket(server.manifest.endpoints.websocketUrl);
    const closed = waitForSocketClose(socket);
    await waitForSocketOpen(socket);
    socket.send("null");
    await expect(closed).resolves.toEqual({ code: 1003, reason: "invalid json" });

    const me = await fetch(`${server.manifest.endpoints.apiRoot}/users/me`, {
      headers: { authorization: "Bearer fake" },
    });
    expect(me.status).toBe(200);
  });

  it("validates WebSocket resource limits", async () => {
    await expect(startMattermostServer({ maxCommittedChannels: 0 })).rejects.toThrow(
      "maxCommittedChannels must be a positive safe integer.",
    );
    await expect(startMattermostServer({ maxCommittedPosts: 0 })).rejects.toThrow(
      "maxCommittedPosts must be a positive safe integer.",
    );
    await expect(startMattermostServer({ maxCommittedUsers: 0 })).rejects.toThrow(
      "maxCommittedUsers must be a positive safe integer.",
    );
    await expect(startMattermostServer({ maxWebSocketBufferedBytes: 0 })).rejects.toThrow(
      "maxWebSocketBufferedBytes must be a positive safe integer.",
    );
    await expect(startMattermostServer({ maxWebSocketMessageBytes: 0 })).rejects.toThrow(
      "maxWebSocketMessageBytes must be a positive safe integer.",
    );
    await expect(startMattermostServer({ maxUnauthenticatedWebSocketClients: 0 })).rejects.toThrow(
      "maxUnauthenticatedWebSocketClients must be a positive safe integer.",
    );
  });

  it("bounds committed users, channels, and posts before mutation", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
      maxCommittedChannels: 1,
      maxCommittedPosts: 1,
      maxCommittedUsers: 2,
    });
    servers.push(server);
    const sendInbound = (body: Record<string, unknown>) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    expect(
      (
        await sendInbound({
          channelId: CHANNEL_ID,
          senderId: USER_ID,
          text: "fills committed state",
        })
      ).status,
    ).toBe(200);

    for (const [body, resource] of [
      [{ channelId: OTHER_CHANNEL_ID, senderId: USER_ID, text: "new channel" }, "channels"],
      [{ channelId: CHANNEL_ID, senderId: OTHER_USER_ID, text: "new user" }, "users"],
      [{ channelId: CHANNEL_ID, senderId: USER_ID, text: "new post" }, "posts"],
    ] as const) {
      const response = await sendInbound(body);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: `Committed Mattermost ${resource} limit reached`,
        ok: false,
      });
    }

    const missingUser = await fetch(`${server.manifest.endpoints.apiRoot}/users/${OTHER_USER_ID}`, {
      headers: { authorization: "Bearer fake" },
    });
    expect(missingUser.status).toBe(404);
    const missingChannel = await fetch(
      `${server.manifest.endpoints.apiRoot}/channels/${OTHER_CHANNEL_ID}`,
      { headers: { authorization: "Bearer fake" } },
    );
    expect(missingChannel.status).toBe(404);
  });

  it("drains authorized GET and DELETE request bodies", async () => {
    const server = await startMattermostServer({ botToken: "fake" });
    servers.push(server);
    const body = JSON.stringify({ ignored: true });

    for (const [method, url, status] of [
      ["GET", `${server.manifest.endpoints.apiRoot}/users/me`, 200],
      ["DELETE", `${server.manifest.endpoints.apiRoot}/posts/${"z".repeat(26)}`, 404],
    ] as const) {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const response = await requestHttp({
          agent,
          body,
          headers: {
            authorization: "Bearer fake",
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
          },
          method,
          url,
        });
        expect(response.status).toBe(status);

        const reused = await requestHttp({
          agent,
          headers: { authorization: "Bearer fake" },
          method: "GET",
          url: `${server.manifest.endpoints.apiRoot}/users/me`,
        });
        expect(reused.status).toBe(200);
      } finally {
        agent.destroy();
      }
    }
  });

  it("drains request bodies rejected by REST and admin authentication", async () => {
    const server = await startMattermostServer({
      adminToken: "admin",
      botToken: "fake",
    });
    servers.push(server);

    for (const url of [
      `${server.manifest.endpoints.apiRoot}/posts`,
      server.manifest.endpoints.adminInboundUrl,
    ]) {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const body = JSON.stringify({ rejected: true });
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
        expect(rejected.status).toBe(401);

        const accepted = await requestHttp({
          agent,
          headers: { authorization: "Bearer fake" },
          method: "GET",
          url: `${server.manifest.endpoints.apiRoot}/users/me`,
        });
        expect(accepted.status).toBe(200);
      } finally {
        agent.destroy();
      }
    }
  });
});
