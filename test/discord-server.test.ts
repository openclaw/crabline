import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startDiscordServer, type StartedDiscordServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedDiscordServer[] = [];
const directories: string[] = [];
const CHANNEL_ID = "135000000000000010";
const GUILD_ID = "135000000000000011";
const USER_ID = "135000000000000012";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function auth(server: StartedDiscordServer): Record<string, string> {
  return {
    authorization: `Bot ${server.manifest.botToken}`,
    "content-type": "application/json",
  };
}

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

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", resolve);
    socket.once("error", reject);
  });
}

async function startTestServer(): Promise<StartedDiscordServer> {
  const directory = await createTempDir();
  directories.push(directory);
  const server = await startDiscordServer({
    heartbeatIntervalMs: 100,
    recorderPath: path.join(directory, "discord.jsonl"),
  });
  servers.push(server);
  return server;
}

describe("Discord local provider server", () => {
  it("implements authenticated identity and gateway metadata routes", async () => {
    const server = await startTestServer();
    const unauthorized = await fetch(`${server.manifest.endpoints.apiRoot}/v10/users/@me`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bot");

    const identity = await fetch(`${server.manifest.endpoints.apiRoot}/v10/users/@me`, {
      headers: auth(server),
    });
    expect(identity.status).toBe(200);
    expect(identity.headers.get("x-ratelimit-bucket")).toBe("crabline-discord");
    await expect(identity.json()).resolves.toMatchObject({
      bot: true,
      id: server.manifest.botUserId,
      username: "crabline",
    });

    const gateway = await fetch(server.manifest.endpoints.gatewayBotUrl, {
      headers: auth(server),
    });
    await expect(gateway.json()).resolves.toMatchObject({
      shards: 1,
      url: server.manifest.endpoints.gatewayUrl,
      session_start_limit: { max_concurrency: 1 },
    });
  });

  it("performs HELLO, IDENTIFY, READY, heartbeat, and admin MESSAGE_CREATE", async () => {
    const server = await startTestServer();
    const socket = new WebSocket(`${server.manifest.endpoints.gatewayUrl}?v=10&encoding=json`);
    const helloPromise = nextMessage(socket);
    await waitForOpen(socket);
    await expect(helloPromise).resolves.toMatchObject({
      d: { heartbeat_interval: 100 },
      op: 10,
    });
    const readyPromise = nextMessage(socket);
    socket.send(
      JSON.stringify({
        d: {
          intents: 33_281,
          properties: { browser: "crabline-test", device: "crabline-test", os: "test" },
          token: server.manifest.botToken,
        },
        op: 2,
      }),
    );
    await expect(readyPromise).resolves.toMatchObject({
      d: {
        application: { id: server.manifest.applicationId },
        user: { id: server.manifest.botUserId },
        v: 10,
      },
      op: 0,
      t: "READY",
    });

    const ackPromise = nextMessage(socket);
    socket.send(JSON.stringify({ d: 1, op: 1 }));
    await expect(ackPromise).resolves.toEqual({ d: null, op: 11 });

    const dispatchPromise = nextMessages(socket, 3);
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        content: `hello <@${server.manifest.botUserId}>`,
        guildId: GUILD_ID,
        senderId: USER_ID,
        senderName: "Alice",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    const dispatches = await dispatchPromise;
    expect(dispatches.map((event) => event.t)).toEqual([
      "GUILD_CREATE",
      "CHANNEL_CREATE",
      "MESSAGE_CREATE",
    ]);
    expect(dispatches[2]).toMatchObject({
      d: {
        author: { id: USER_ID, username: "Alice" },
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        mentions: [{ id: server.manifest.botUserId }],
      },
      op: 0,
    });
    socket.close();
  });

  it("accepts outbound replies and preserves reply and mention metadata", async () => {
    const server = await startTestServer();
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        content: "parent",
        guildId: GUILD_ID,
        senderId: USER_ID,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    const inboundPayload = (await inbound.json()) as { message: { id: string } };
    const outbound = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: JSON.stringify({
          allowed_mentions: { parse: [], replied_user: false },
          content: `<@${USER_ID}> answer`,
          message_reference: { message_id: inboundPayload.message.id },
        }),
        headers: auth(server),
        method: "POST",
      },
    );
    expect(outbound.status).toBe(200);
    const outboundMessage = (await outbound.json()) as Record<string, unknown>;
    expect(outboundMessage).toMatchObject({
      allowed_mentions: { parse: [], replied_user: false },
      author: { id: server.manifest.botUserId },
      channel_id: CHANNEL_ID,
      content: `<@${USER_ID}> answer`,
      message_reference: {
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        message_id: inboundPayload.message.id,
      },
      referenced_message: { content: "parent" },
      type: 19,
    });
    const reaction = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${outboundMessage.id}/reactions/%E2%9C%85/@me`,
      { headers: auth(server), method: "PUT" },
    );
    expect(reaction.status).toBe(204);

    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).toContain(`/api/v10/channels/${CHANNEL_ID}/messages`);
    expect(recorder).toContain('"accepted":true');
  });

  it("resumes a retained Gateway session after a normal disconnect", async () => {
    const server = await startTestServer();
    const first = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const firstHello = nextMessage(first);
    await waitForOpen(first);
    await firstHello;
    const readyPromise = nextMessage(first);
    first.send(JSON.stringify({ d: { intents: 0, token: server.manifest.botToken }, op: 2 }));
    const ready = await readyPromise;
    const sessionId = (ready.d as { session_id?: string }).session_id;
    expect(sessionId).toEqual(expect.any(String));
    const firstClose = waitForClose(first);
    first.close(1000, "test reconnect");
    await firstClose;

    const resumed = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const resumedHello = nextMessage(resumed);
    await waitForOpen(resumed);
    await resumedHello;
    const resumedEvent = nextMessage(resumed);
    resumed.send(
      JSON.stringify({
        d: { seq: ready.s, session_id: sessionId, token: server.manifest.botToken },
        op: 6,
      }),
    );
    await expect(resumedEvent).resolves.toMatchObject({ d: {}, op: 0, t: "RESUMED" });
    resumed.close();
  });

  it("supports native application-command overwrite and listing", async () => {
    const server = await startTestServer();
    const commandUrl = `${server.manifest.endpoints.apiRoot}/v10/applications/${server.manifest.applicationId}/commands`;
    const overwrite = await fetch(commandUrl, {
      body: JSON.stringify([{ description: "Run a Crabline check", name: "check", type: 1 }]),
      headers: auth(server),
      method: "PUT",
    });
    expect(overwrite.status).toBe(200);
    await expect(overwrite.json()).resolves.toEqual([
      expect.objectContaining({
        application_id: server.manifest.applicationId,
        description: "Run a Crabline check",
        name: "check",
        type: 1,
      }),
    ]);
    const list = await fetch(commandUrl, { headers: auth(server) });
    await expect(list.json()).resolves.toEqual([expect.objectContaining({ name: "check" })]);

    await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        content: "hello",
        guildId: GUILD_ID,
        senderId: USER_ID,
      }),
      headers: {
        authorization: `Bearer ${server.manifest.adminToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const guildCommandUrl = `${server.manifest.endpoints.apiRoot}/v10/applications/${server.manifest.applicationId}/guilds/${GUILD_ID}/commands`;
    const guildOverwrite = await fetch(guildCommandUrl, {
      body: JSON.stringify([{ description: "Guild check", name: "guild-check", type: 1 }]),
      headers: auth(server),
      method: "PUT",
    });
    expect(guildOverwrite.status).toBe(200);
    await expect(guildOverwrite.json()).resolves.toEqual([
      expect.objectContaining({ guild_id: GUILD_ID, name: "guild-check" }),
    ]);
    await expect((await fetch(commandUrl, { headers: auth(server) })).json()).resolves.toEqual([
      expect.objectContaining({ name: "check" }),
    ]);
  });

  it("closes active Gateway clients during deterministic shutdown", async () => {
    const server = await startTestServer();
    const socket = new WebSocket(server.manifest.endpoints.gatewayUrl);
    await waitForOpen(socket);
    const closePromise = waitForClose(socket);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(closePromise).resolves.toBe(1001);
  });
});
