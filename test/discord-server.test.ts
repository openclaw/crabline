import { createSocket } from "node:dgram";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { Agent, request } from "node:https";
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

function driverAuth(server: StartedDiscordServer): Record<string, string> {
  return {
    authorization: `Bot ${server.manifest.driverBotToken}`,
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

function expectNoMessage(socket: WebSocket, durationMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected Gateway payload: ${data.toString()}`));
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve();
    }, durationMs);
    socket.once("message", onMessage);
  });
}

async function identifyGateway(params: { server: StartedDiscordServer; token: string }): Promise<{
  guildCreate: Record<string, unknown>;
  ready: Record<string, unknown>;
  socket: WebSocket;
}> {
  const socket = new WebSocket(params.server.manifest.endpoints.gatewayUrl);
  const hello = nextMessage(socket);
  await waitForOpen(socket);
  await hello;
  const dispatches = nextMessages(socket, 2);
  socket.send(JSON.stringify({ d: { intents: 0, token: params.token }, op: 2 }));
  const [ready, guildCreate] = await dispatches;
  if (!ready || !guildCreate) {
    throw new Error("Discord READY and fixture guild were not emitted.");
  }
  return { guildCreate, ready, socket };
}

async function startTestServer(
  params: Parameters<typeof startDiscordServer>[0] = {},
): Promise<StartedDiscordServer> {
  const directory = await createTempDir();
  directories.push(directory);
  const server = await startDiscordServer({
    ...params,
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

    const publicGateway = await fetch(`${server.manifest.endpoints.apiRoot}/v10/gateway`);
    expect(publicGateway.status).toBe(200);
    await expect(publicGateway.json()).resolves.toEqual({
      url: server.manifest.endpoints.gatewayUrl,
    });

    const unauthorizedGatewayBot = await fetch(server.manifest.endpoints.gatewayBotUrl);
    expect(unauthorizedGatewayBot.status).toBe(401);
    const gatewayBot = await fetch(server.manifest.endpoints.gatewayBotUrl, {
      headers: auth(server),
    });
    await expect(gatewayBot.json()).resolves.toMatchObject({
      shards: 1,
      url: server.manifest.endpoints.gatewayUrl,
      session_start_limit: { max_concurrency: 1 },
    });
  });

  it("lists only messages after the requested snowflake", async () => {
    const server = await startTestServer();
    const messageUrl = `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`;
    const created: Array<{ content: string; id: string }> = [];
    for (const content of ["first", "second", "third"]) {
      const response = await fetch(messageUrl, {
        body: JSON.stringify({ content }),
        headers: auth(server),
        method: "POST",
      });
      expect(response.status).toBe(200);
      created.push((await response.json()) as { content: string; id: string });
    }
    expect(new Set(created.map((message) => message.id))).toHaveLength(3);

    const after = await fetch(`${messageUrl}?after=${created[0]!.id}&limit=1`, {
      headers: auth(server),
    });
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toEqual([
      expect.objectContaining({ content: "third", id: created[2]!.id }),
    ]);

    const invalid = await fetch(`${messageUrl}?after=not-a-snowflake`, {
      headers: auth(server),
    });
    expect(invalid.status).toBe(400);
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
    const readyPromise = nextMessages(socket, 2);
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
    const [ready, guildCreate] = await readyPromise;
    expect(ready).toMatchObject({
      d: {
        application: { id: server.manifest.applicationId },
        user: { id: server.manifest.botUserId },
        v: 10,
      },
      op: 0,
      t: "READY",
    });
    expect(guildCreate).toMatchObject({ d: { id: GUILD_ID }, t: "GUILD_CREATE" });

    const ackPromise = nextMessage(socket);
    socket.send(JSON.stringify({ d: 1, op: 1 }));
    await expect(ackPromise).resolves.toEqual({ d: null, op: 11 });

    const dispatchPromise = nextMessage(socket);
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
    const dispatch = await dispatchPromise;
    expect(dispatch).toMatchObject({
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

  it("propagates the authenticated driver identity through REST and Gateway", async () => {
    const server = await startTestServer();
    const identity = await fetch(`${server.manifest.endpoints.apiRoot}/v10/users/@me`, {
      headers: driverAuth(server),
    });
    await expect(identity.json()).resolves.toMatchObject({ id: server.manifest.driverBotUserId });
    const application = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/oauth2/applications/@me`,
      { headers: driverAuth(server) },
    );
    await expect(application.json()).resolves.toMatchObject({
      bot: { id: server.manifest.driverBotUserId },
      owner: { id: server.manifest.driverBotUserId },
    });
    const { socket: gateway, ready } = await identifyGateway({
      server,
      token: server.manifest.driverBotToken,
    });
    expect(ready).toMatchObject({
      d: { user: { id: server.manifest.driverBotUserId } },
      t: "READY",
    });

    const createDispatch = nextMessage(gateway);
    const create = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: JSON.stringify({ content: `<@${server.manifest.driverBotUserId}> create` }),
        headers: driverAuth(server),
        method: "POST",
      },
    );
    expect(create.status).toBe(200);
    const created = (await create.json()) as { id: string };
    expect(created).toMatchObject({
      mentions: [
        {
          bot: true,
          id: server.manifest.driverBotUserId,
          username: "crabline-driver",
        },
      ],
    });
    await expect(createDispatch).resolves.toMatchObject({
      d: {
        mentions: [
          {
            bot: true,
            id: server.manifest.driverBotUserId,
            username: "crabline-driver",
          },
        ],
      },
      t: "MESSAGE_CREATE",
    });

    const editDispatch = nextMessage(gateway);
    const edit = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${created.id}`,
      {
        body: JSON.stringify({ content: `<@${server.manifest.driverBotUserId}> edit` }),
        headers: driverAuth(server),
        method: "PATCH",
      },
    );
    expect(edit.status).toBe(200);
    await expect(edit.json()).resolves.toMatchObject({
      mentions: [{ bot: true, id: server.manifest.driverBotUserId }],
    });
    await expect(editDispatch).resolves.toMatchObject({
      d: { mentions: [{ bot: true, id: server.manifest.driverBotUserId }] },
      t: "MESSAGE_UPDATE",
    });
    gateway.close();
  });

  it("isolates voice credentials, commands, and private channels between bot identities", async () => {
    const server = await startTestServer();
    const primary = await identifyGateway({ server, token: server.manifest.botToken });
    const driver = await identifyGateway({ server, token: server.manifest.driverBotToken });
    expect(primary.ready).toMatchObject({
      d: { application: { id: server.manifest.applicationId } },
    });
    expect(driver.ready).toMatchObject({
      d: { application: { id: server.manifest.driverApplicationId } },
    });

    const primaryCommandsUrl = `${server.manifest.endpoints.apiRoot}/v10/applications/${server.manifest.applicationId}/commands`;
    const driverCommandsUrl = `${server.manifest.endpoints.apiRoot}/v10/applications/${server.manifest.driverApplicationId}/commands`;
    expect(
      (
        await fetch(primaryCommandsUrl, {
          body: JSON.stringify([{ description: "primary", name: "primary", type: 1 }]),
          headers: auth(server),
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(driverCommandsUrl, {
          body: JSON.stringify([{ description: "driver", name: "driver", type: 1 }]),
          headers: driverAuth(server),
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(primaryCommandsUrl, {
          body: JSON.stringify([]),
          headers: driverAuth(server),
          method: "PUT",
        })
      ).status,
    ).toBe(403);
    await expect(
      (await fetch(primaryCommandsUrl, { headers: auth(server) })).json(),
    ).resolves.toEqual([
      expect.objectContaining({ application_id: server.manifest.applicationId, name: "primary" }),
    ]);
    await expect(
      (await fetch(driverCommandsUrl, { headers: driverAuth(server) })).json(),
    ).resolves.toEqual([
      expect.objectContaining({
        application_id: server.manifest.driverApplicationId,
        name: "driver",
      }),
    ]);

    const dmResponse = await fetch(`${server.manifest.endpoints.apiRoot}/v10/users/@me/channels`, {
      body: JSON.stringify({ recipient_id: USER_ID }),
      headers: auth(server),
      method: "POST",
    });
    const dm = (await dmResponse.json()) as { id: string };
    const driverPrivateDispatch = expectNoMessage(driver.socket);
    const primaryPrivateDispatch = nextMessage(primary.socket);
    const privateMessageResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${dm.id}/messages`,
      {
        body: JSON.stringify({ content: "primary private reply" }),
        headers: auth(server),
        method: "POST",
      },
    );
    expect(privateMessageResponse.status).toBe(200);
    const privateMessage = (await privateMessageResponse.json()) as { id: string };
    await expect(primaryPrivateDispatch).resolves.toMatchObject({
      d: { channel_id: dm.id, content: "primary private reply" },
      t: "MESSAGE_CREATE",
    });
    await driverPrivateDispatch;
    const inboundPrivateReply = nextMessage(primary.socket);
    const driverInboundPrivateReply = expectNoMessage(driver.socket);
    const inboundPrivateResponse = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: dm.id,
        content: "human private reply",
        message_reference: { message_id: privateMessage.id },
        senderId: USER_ID,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    expect(inboundPrivateResponse.status).toBe(200);
    await expect(inboundPrivateReply).resolves.toMatchObject({
      d: {
        author: { id: USER_ID },
        channel_id: dm.id,
        content: "human private reply",
        message_reference: { channel_id: dm.id, message_id: privateMessage.id },
        referenced_message: { id: privateMessage.id },
      },
      t: "MESSAGE_CREATE",
    });
    await driverInboundPrivateReply;
    const primaryCrossReference = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: JSON.stringify({
          content: "attempted cross-channel reference",
          message_reference: { channel_id: dm.id, message_id: privateMessage.id },
        }),
        headers: auth(server),
        method: "POST",
      },
    );
    expect(primaryCrossReference.status).toBe(404);
    await Promise.all([expectNoMessage(primary.socket), expectNoMessage(driver.socket)]);
    expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}/v10/channels/${dm.id}`, {
          headers: driverAuth(server),
        })
      ).status,
    ).toBe(404);

    const leakedReference = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: JSON.stringify({
          content: "attempted private reference",
          message_reference: { channel_id: dm.id, message_id: privateMessage.id },
        }),
        headers: driverAuth(server),
        method: "POST",
      },
    );
    expect(leakedReference.status).toBe(404);

    const privateUpload = new FormData();
    privateUpload.set(
      "payload_json",
      JSON.stringify({ attachments: [{ filename: "private.txt", id: "0" }] }),
    );
    privateUpload.set("files[0]", new Blob(["private bytes"]), "private.txt");
    const privateUploadResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${dm.id}/messages`,
      {
        body: privateUpload,
        headers: { authorization: `Bot ${server.manifest.botToken}` },
        method: "POST",
      },
    );
    const uploadedPrivateMessage = (await privateUploadResponse.json()) as {
      attachments: Array<{ id: string; url: string }>;
    };
    const privateAttachment = uploadedPrivateMessage.attachments[0]!;
    const foreignRetention = new FormData();
    foreignRetention.set(
      "payload_json",
      JSON.stringify({
        attachments: [{ id: privateAttachment.id }],
        content: "attempted private attachment retention",
      }),
    );
    expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`, {
          body: foreignRetention,
          headers: { authorization: `Bot ${server.manifest.driverBotToken}` },
          method: "POST",
        })
      ).status,
    ).toBe(400);
    await expect((await fetch(privateAttachment.url)).text()).resolves.toBe("private bytes");
    const unsignedUrl = new URL(privateAttachment.url);
    unsignedUrl.search = "";
    expect((await fetch(unsignedUrl)).status).toBe(404);
    const tamperedUrl = new URL(privateAttachment.url);
    tamperedUrl.searchParams.set("sig", `${tamperedUrl.searchParams.get("sig")}x`);
    expect((await fetch(tamperedUrl)).status).toBe(404);
    expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}/v10/channels/${dm.id}/messages`, {
          body: JSON.stringify({ content: "cross-account write" }),
          headers: driverAuth(server),
          method: "POST",
        })
      ).status,
    ).toBe(404);

    const driverVoiceState = nextMessage(driver.socket);
    const primaryVoiceDispatches = nextMessages(primary.socket, 2);
    primary.socket.send(
      JSON.stringify({
        d: {
          channel_id: server.manifest.fixture.voiceChannelId,
          guild_id: GUILD_ID,
          self_deaf: false,
          self_mute: false,
        },
        op: 4,
      }),
    );
    const [voiceState, voiceServer] = await primaryVoiceDispatches;
    if (!voiceState || !voiceServer) {
      throw new Error("Discord voice state and server updates were not emitted.");
    }
    await expect(driverVoiceState).resolves.toMatchObject({
      d: { user_id: server.manifest.botUserId },
      t: "VOICE_STATE_UPDATE",
    });
    await expectNoMessage(driver.socket);
    const sessionId = (voiceState.d as { session_id: string }).session_id;
    const voiceToken = (voiceServer.d as { token: string }).token;
    const crossAccountVoice = new WebSocket(
      `wss://${server.manifest.endpoints.voiceEndpoint}?v=8`,
      { ca: server.manifest.endpoints.voiceCaCertificate },
    );
    const crossAccountHello = nextMessage(crossAccountVoice);
    await waitForOpen(crossAccountVoice);
    await crossAccountHello;
    const crossAccountClose = waitForClose(crossAccountVoice);
    crossAccountVoice.send(
      JSON.stringify({
        d: {
          server_id: GUILD_ID,
          session_id: sessionId,
          token: voiceToken,
          user_id: server.manifest.driverBotUserId,
        },
        op: 0,
      }),
    );
    await expect(crossAccountClose).resolves.toBe(4_004);
    primary.socket.close();
    driver.socket.close();
  });

  it("expires attachment download capabilities", async () => {
    const server = await startTestServer({ attachmentUrlTtlMs: 500 });
    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        attachments: [{ description: "original", filename: "截图.png", id: "0" }],
      }),
    );
    form.set("files[0]", new Blob(["short lived"]), "截图.png");
    const response = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: form,
        headers: { authorization: `Bot ${server.manifest.botToken}` },
        method: "POST",
      },
    );
    const message = (await response.json()) as {
      attachments: Array<{ id: string; url: string }>;
      id: string;
    };
    const initialDownload = await fetch(message.attachments[0]!.url);
    expect(initialDownload.status).toBe(200);
    expect(initialDownload.headers.get("content-disposition")).toBe(
      `attachment; filename="__.png"; filename*=UTF-8''%E6%88%AA%E5%9B%BE.png`,
    );
    await expect(initialDownload.text()).resolves.toBe("short lived");
    const editResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}`,
      {
        body: JSON.stringify({
          attachments: [{ description: "edited", id: message.attachments[0]!.id }],
        }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    await expect(editResponse.json()).resolves.toMatchObject({
      attachments: [{ description: "edited" }],
    });
    const retainResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}`,
      {
        body: JSON.stringify({ attachments: [{ id: message.attachments[0]!.id }] }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    await expect(retainResponse.json()).resolves.toMatchObject({
      attachments: [{ description: "edited" }],
    });
    const expiredUrl = message.attachments[0]!.url;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect((await fetch(expiredUrl)).status).toBe(404);
    const refreshedResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}`,
      { headers: auth(server) },
    );
    const refreshed = (await refreshedResponse.json()) as {
      attachments: Array<{ description?: string; url: string }>;
    };
    const refreshedUrl = refreshed.attachments[0]!.url;
    expect(refreshed.attachments[0]!.description).toBe("edited");
    expect(refreshedUrl).not.toBe(expiredUrl);
    await expect((await fetch(refreshedUrl)).text()).resolves.toBe("short lived");
    expect((await fetch(expiredUrl)).status).toBe(404);
  });

  it("clears nullable message arrays in REST, Gateway, and subsequent reads", async () => {
    const server = await startTestServer();
    const primary = await identifyGateway({ server, token: server.manifest.botToken });
    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        attachments: [{ filename: "clear.txt", id: "0" }],
        components: [{ components: [], type: 1 }],
        content: "clear arrays",
        embeds: [{ description: "remove me" }],
      }),
    );
    form.set("files[0]", new Blob(["clear me"]), "clear.txt");
    const createDispatch = nextMessage(primary.socket);
    const create = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: form,
        headers: { authorization: `Bot ${server.manifest.botToken}` },
        method: "POST",
      },
    );
    expect(create.status).toBe(200);
    const created = (await create.json()) as { id: string };
    await createDispatch;

    const updateDispatch = nextMessage(primary.socket);
    const edit = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${created.id}`,
      {
        body: JSON.stringify({ attachments: null, components: null, embeds: null }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    expect(edit.status).toBe(200);
    await expect(edit.json()).resolves.toMatchObject({
      attachments: [],
      components: [],
      embeds: [],
    });
    await expect(updateDispatch).resolves.toMatchObject({
      d: { attachments: [], components: [], embeds: [] },
      t: "MESSAGE_UPDATE",
    });
    const read = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${created.id}`,
      { headers: auth(server) },
    );
    await expect(read.json()).resolves.toMatchObject({
      attachments: [],
      components: [],
      embeds: [],
    });
    primary.socket.close();
  });

  it("serializes reaction ownership per recipient and preserves custom emoji identity", async () => {
    const server = await startTestServer();
    const primary = await identifyGateway({ server, token: server.manifest.botToken });
    const driver = await identifyGateway({ server, token: server.manifest.driverBotToken });
    const primaryCreate = nextMessage(primary.socket);
    const driverCreate = nextMessage(driver.socket);
    const createResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`,
      {
        body: JSON.stringify({ content: "reaction state" }),
        headers: auth(server),
        method: "POST",
      },
    );
    const message = (await createResponse.json()) as { id: string };
    await Promise.all([primaryCreate, driverCreate]);

    const reactionPath = `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}/reactions/%F0%9F%91%80/@me`;
    const primaryReaction = nextMessage(primary.socket);
    const driverReaction = nextMessage(driver.socket);
    expect((await fetch(reactionPath, { headers: driverAuth(server), method: "PUT" })).status).toBe(
      204,
    );
    await Promise.all([primaryReaction, driverReaction]);

    const primaryUpdate = nextMessage(primary.socket);
    const driverUpdate = nextMessage(driver.socket);
    const edit = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}`,
      {
        body: JSON.stringify({ content: "reaction state updated" }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    await expect(edit.json()).resolves.toMatchObject({ reactions: [{ me: false }] });
    await expect(primaryUpdate).resolves.toMatchObject({
      d: { reactions: [{ me: false }] },
      t: "MESSAGE_UPDATE",
    });
    await expect(driverUpdate).resolves.toMatchObject({
      d: { reactions: [{ me: true }] },
      t: "MESSAGE_UPDATE",
    });

    const customEmojiId = "135000000000000099";
    const customReaction = `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}/reactions/${encodeURIComponent(`wave:${customEmojiId}`)}/@me`;
    const primaryCustom = nextMessage(primary.socket);
    const driverCustom = nextMessage(driver.socket);
    expect(
      (await fetch(customReaction, { headers: driverAuth(server), method: "PUT" })).status,
    ).toBe(204);
    await expect(primaryCustom).resolves.toMatchObject({
      d: { emoji: { id: customEmojiId, name: "wave" } },
      t: "MESSAGE_REACTION_ADD",
    });
    await expect(driverCustom).resolves.toMatchObject({
      d: { emoji: { id: customEmojiId, name: "wave" } },
      t: "MESSAGE_REACTION_ADD",
    });
    const driverView = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${message.id}`,
      { headers: driverAuth(server) },
    );
    await expect(driverView.json()).resolves.toMatchObject({
      reactions: [
        { emoji: { id: null, name: "👀" }, me: true },
        { emoji: { id: customEmojiId, name: "wave" }, me: true },
      ],
    });
    primary.socket.close();
    driver.socket.close();
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

    const deleteParent = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${inboundPayload.message.id}`,
      { headers: auth(server), method: "DELETE" },
    );
    expect(deleteParent.status).toBe(204);
    const replyAfterParentDelete = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${String(outboundMessage.id)}`,
      { headers: auth(server) },
    );
    expect(replyAfterParentDelete.status).toBe(200);
    await expect(replyAfterParentDelete.json()).resolves.toMatchObject({
      referenced_message: null,
    });

    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).toContain(`/api/v10/channels/${CHANNEL_ID}/messages`);
    expect(recorder).toContain('"accepted":true');
  });

  it("bounds reply references across REST, admin ingress, and Gateway dispatches", async () => {
    const server = await startTestServer();
    const url = `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages`;
    const messages: Array<{ id: string }> = [];
    for (const content of ["root", "parent", "reply"]) {
      const previous = messages.at(-1);
      const response = await fetch(url, {
        body: JSON.stringify({
          content,
          ...(previous ? { message_reference: { message_id: previous.id } } : {}),
        }),
        headers: auth(server),
        method: "POST",
      });
      expect(response.status).toBe(200);
      const message = (await response.json()) as { id: string };
      expect(message).not.toHaveProperty("referenced_message.referenced_message");
      messages.push(message);
    }

    const { socket } = await identifyGateway({ server, token: server.manifest.botToken });
    const dispatched = nextMessage(socket);
    const injected = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        content: "injected reply",
        guildId: GUILD_ID,
        message_reference: { message_id: messages[2]!.id },
        senderId: USER_ID,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    expect(injected.status).toBe(200);
    const ingress = (await injected.json()) as Record<string, unknown>;
    expect(ingress).toMatchObject({
      message: { referenced_message: { content: "reply", id: messages[2]!.id } },
    });
    expect(ingress).not.toHaveProperty("message.referenced_message.referenced_message");
    expect(ingress).not.toHaveProperty("event.d.referenced_message.referenced_message");
    const event = await dispatched;
    expect(event).toMatchObject({
      d: { referenced_message: { content: "reply", id: messages[2]!.id } },
      t: "MESSAGE_CREATE",
    });
    expect(event).not.toHaveProperty("d.referenced_message.referenced_message");

    const updated = nextMessage(socket);
    const edit = await fetch(`${url}/${messages[1]!.id}`, {
      body: JSON.stringify({ content: "edited parent" }),
      headers: auth(server),
      method: "PATCH",
    });
    expect(edit.status).toBe(200);
    await updated;
    const fetched = await fetch(`${url}/${messages[2]!.id}`, { headers: auth(server) });
    const reply = (await fetched.json()) as Record<string, unknown>;
    expect(reply).toMatchObject({ referenced_message: { content: "edited parent" } });
    expect(reply).not.toHaveProperty("referenced_message.referenced_message");
    const history = await fetch(url, { headers: auth(server) });
    const entries = (await history.json()) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("referenced_message.referenced_message");
    }
    socket.close();
  });

  it("resumes a retained Gateway session after a normal disconnect", async () => {
    const server = await startTestServer();
    const first = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const firstHello = nextMessage(first);
    await waitForOpen(first);
    await firstHello;
    const readyPromise = nextMessages(first, 2);
    first.send(JSON.stringify({ d: { intents: 0, token: server.manifest.botToken }, op: 2 }));
    const [ready, guildCreate] = await readyPromise;
    if (!ready || !guildCreate) {
      throw new Error("Discord READY and fixture guild were not emitted.");
    }
    const sessionId = (ready.d as { session_id?: string }).session_id;
    expect(sessionId).toEqual(expect.any(String));
    const firstClose = waitForClose(first);
    first.close(1000, "test reconnect");
    await firstClose;

    const expectInvalidResume = async (sequence: unknown) => {
      const invalid = new WebSocket(server.manifest.endpoints.gatewayUrl);
      const invalidHello = nextMessage(invalid);
      await waitForOpen(invalid);
      await invalidHello;
      const invalidSession = nextMessage(invalid);
      invalid.send(
        JSON.stringify({
          d: { seq: sequence, session_id: sessionId, token: server.manifest.botToken },
          op: 6,
        }),
      );
      await expect(invalidSession).resolves.toEqual({ d: false, op: 9 });
      const invalidClose = waitForClose(invalid);
      invalid.close();
      await invalidClose;
    };
    await expectInvalidResume("1");
    await expectInvalidResume((guildCreate.s as number) - 1);

    const resumed = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const resumedHello = nextMessage(resumed);
    await waitForOpen(resumed);
    await resumedHello;
    const resumedEvent = nextMessage(resumed);
    resumed.send(
      JSON.stringify({
        d: { seq: guildCreate.s, session_id: sessionId, token: server.manifest.botToken },
        op: 6,
      }),
    );
    const resumedPayload = await resumedEvent;
    expect(resumedPayload).toMatchObject({ d: {}, op: 0, t: "RESUMED" });
    const resumedClose = waitForClose(resumed);
    resumed.close();
    await resumedClose;

    const secondResume = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const secondHello = nextMessage(secondResume);
    await waitForOpen(secondResume);
    await secondHello;
    const secondResumedEvent = nextMessage(secondResume);
    secondResume.send(
      JSON.stringify({
        d: {
          seq: resumedPayload.s,
          session_id: sessionId,
          token: server.manifest.botToken,
        },
        op: 6,
      }),
    );
    await expect(secondResumedEvent).resolves.toMatchObject({ d: {}, op: 0, t: "RESUMED" });
    const secondClose = waitForClose(secondResume);
    secondResume.close();
    await secondClose;
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
    const overwrittenCommands = (await overwrite.json()) as Array<Record<string, unknown>>;
    expect(overwrittenCommands).toEqual([
      expect.objectContaining({
        application_id: server.manifest.applicationId,
        description: "Run a Crabline check",
        name: "check",
        type: 1,
      }),
    ]);
    const overwrittenId = overwrittenCommands[0]!.id;
    const upsert = await fetch(commandUrl, {
      body: JSON.stringify({ description: "Updated check", name: "check", type: 1 }),
      headers: auth(server),
      method: "POST",
    });
    expect(upsert.status).toBe(200);
    await expect(upsert.json()).resolves.toMatchObject({
      description: "Updated check",
      id: overwrittenId,
      name: "check",
      type: 1,
    });
    const distinctType = await fetch(commandUrl, {
      body: JSON.stringify({ name: "check", type: 2 }),
      headers: auth(server),
      method: "POST",
    });
    expect(distinctType.status).toBe(201);
    await expect(distinctType.json()).resolves.toMatchObject({ name: "check", type: 2 });
    const list = await fetch(commandUrl, { headers: auth(server) });
    await expect(list.json()).resolves.toEqual([
      expect.objectContaining({ id: overwrittenId, name: "check", type: 1 }),
      expect.objectContaining({ name: "check", type: 2 }),
    ]);

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
      expect.objectContaining({ id: overwrittenId, name: "check", type: 1 }),
      expect.objectContaining({ name: "check", type: 2 }),
    ]);
  });

  it("initializes custom fixtures and emits identifiable native thread membership events", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const fixtureGuildId = "135000000000000101";
    const fixtureChannelId = "135000000000000102";
    const fixtureVoiceChannelId = "135000000000000103";
    const server = await startDiscordServer({
      fixtureChannelId,
      fixtureGuildId,
      fixtureVoiceChannelId,
      heartbeatIntervalMs: 100,
      recorderPath: path.join(directory, "discord.jsonl"),
    });
    servers.push(server);
    expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}/v10/guilds/${fixtureGuildId}`, {
          headers: auth(server),
        })
      ).status,
    ).toBe(200);
    await expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}/v10/channels/${fixtureVoiceChannelId}`, {
          headers: auth(server),
        })
      ).json(),
    ).resolves.toMatchObject({ guild_id: fixtureGuildId, id: fixtureVoiceChannelId, type: 2 });

    const primary = await identifyGateway({ server, token: server.manifest.botToken });
    const driver = await identifyGateway({ server, token: server.manifest.driverBotToken });
    const inboundResponse = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: fixtureChannelId,
        content: "thread source",
        guildId: fixtureGuildId,
        senderId: USER_ID,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    const inbound = (await inboundResponse.json()) as { message: { id: string } };
    const primaryCreateEvents = nextMessages(primary.socket, 2);
    const threadResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${fixtureChannelId}/messages/${inbound.message.id}/threads`,
      {
        body: JSON.stringify({ name: "native-events" }),
        headers: auth(server),
        method: "POST",
      },
    );
    expect(threadResponse.status).toBe(201);
    const thread = (await threadResponse.json()) as { id: string };
    await expect(primaryCreateEvents).resolves.toEqual([
      expect.objectContaining({
        d: expect.objectContaining({ id: inbound.message.id }),
        t: "MESSAGE_UPDATE",
      }),
      expect.objectContaining({
        d: expect.objectContaining({ guild_id: fixtureGuildId, id: thread.id }),
        t: "THREAD_CREATE",
      }),
    ]);

    const driverJoinEvents = nextMessages(driver.socket, 2);
    const primaryMembershipEvent = nextMessage(primary.socket);
    expect(
      (
        await fetch(
          `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/thread-members/@me`,
          { headers: driverAuth(server), method: "PUT" },
        )
      ).status,
    ).toBe(204);
    await expect(driverJoinEvents).resolves.toEqual([
      expect.objectContaining({
        d: expect.objectContaining({ guild_id: fixtureGuildId, id: thread.id }),
        t: "THREAD_CREATE",
      }),
      expect.objectContaining({
        d: expect.objectContaining({
          added_members: [expect.objectContaining({ user_id: server.manifest.driverBotUserId })],
          guild_id: fixtureGuildId,
          id: thread.id,
          member_count: 2,
        }),
        t: "THREAD_MEMBERS_UPDATE",
      }),
    ]);
    await expect(primaryMembershipEvent).resolves.toMatchObject({
      d: { guild_id: fixtureGuildId, id: thread.id, member_count: 2 },
      t: "THREAD_MEMBERS_UPDATE",
    });
    primary.socket.close();
    driver.socket.close();
  });

  it("supports message lifecycle, reactions, threads, attachments, and voice state", async () => {
    const server = await startTestServer();
    const socket = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const hello = nextMessage(socket);
    await waitForOpen(socket);
    await hello;
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ d: { intents: 0, token: server.manifest.botToken }, op: 2 }));
    await ready;

    const inboundResponse = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        content: "parent",
        guildId: GUILD_ID,
        senderId: USER_ID,
        voiceChannelId: server.manifest.fixture.voiceChannelId,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    const inbound = (await inboundResponse.json()) as { message: { id: string } };

    const threadResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${inbound.message.id}/threads`,
      {
        body: JSON.stringify({ name: "qa-thread" }),
        headers: auth(server),
        method: "POST",
      },
    );
    expect(threadResponse.status).toBe(201);
    const thread = (await threadResponse.json()) as { id: string; name: string; parent_id: string };
    expect(thread).toMatchObject({
      id: inbound.message.id,
      name: "qa-thread",
      parent_id: CHANNEL_ID,
      thread_metadata: { archived: false },
    });
    expect(
      (
        await fetch(
          `${server.manifest.endpoints.apiRoot}/v10/channels/${CHANNEL_ID}/messages/${inbound.message.id}/threads`,
          { body: JSON.stringify({ name: "duplicate" }), headers: auth(server), method: "POST" },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/thread-members/@me`,
          { headers: auth(server), method: "PUT" },
        )
      ).status,
    ).toBe(204);

    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        attachments: [{ filename: "proof.txt", id: "0" }],
        content: "draft",
      }),
    );
    form.set("files[0]", new Blob(["proof"], { type: "text/plain" }), "proof.txt");
    const createResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages`,
      { body: form, headers: { authorization: `Bot ${server.manifest.botToken}` }, method: "POST" },
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      attachments: Array<{ filename: string; id: string; size: number; url: string }>;
      id: string;
    };
    expect(created.attachments).toEqual([
      expect.objectContaining({ filename: "proof.txt", size: 5 }),
    ]);
    const downloaded = await fetch(created.attachments[0]!.url);
    expect(downloaded.status).toBe(200);
    await expect(downloaded.text()).resolves.toBe("proof");

    const forbiddenEdit = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      {
        body: JSON.stringify({ content: "driver overwrite" }),
        headers: driverAuth(server),
        method: "PATCH",
      },
    );
    expect(forbiddenEdit.status).toBe(403);

    const rejectedAttachmentEdit = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      {
        body: JSON.stringify({
          attachments: [{ id: "135000000000000098" }],
          content: "must not persist",
        }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    expect(rejectedAttachmentEdit.status).toBe(400);
    const unchanged = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      { headers: auth(server) },
    );
    await expect(unchanged.json()).resolves.toMatchObject({ content: "draft" });

    const editResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      {
        body: JSON.stringify({
          attachments: [{ id: created.attachments[0]!.id }],
          content: "final",
        }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    await expect(editResponse.json()).resolves.toMatchObject({
      attachments: [
        expect.objectContaining({
          filename: "proof.txt",
          url: created.attachments[0]!.url,
        }),
      ],
      content: "final",
      edited_timestamp: expect.any(String),
    });

    const clearContentResponse = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      {
        body: JSON.stringify({
          attachments: [{ id: created.attachments[0]!.id }],
          content: null,
          embeds: [{ description: "replacement" }],
        }),
        headers: auth(server),
        method: "PATCH",
      },
    );
    expect(clearContentResponse.status).toBe(200);
    await expect(clearContentResponse.json()).resolves.toMatchObject({
      content: "",
      embeds: [{ description: "replacement" }],
    });

    const reactionUrl = `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}/reactions/%F0%9F%91%80/@me`;
    expect((await fetch(reactionUrl, { headers: auth(server), method: "PUT" })).status).toBe(204);
    expect((await fetch(reactionUrl, { headers: driverAuth(server), method: "PUT" })).status).toBe(
      204,
    );
    const reacted = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      { headers: auth(server) },
    );
    await expect(reacted.json()).resolves.toMatchObject({
      reactions: [{ count: 2, emoji: { name: "👀" }, me: true }],
    });
    expect(
      (await fetch(reactionUrl, { headers: driverAuth(server), method: "DELETE" })).status,
    ).toBe(204);
    const driverView = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      { headers: driverAuth(server) },
    );
    await expect(driverView.json()).resolves.toMatchObject({
      reactions: [{ count: 1, emoji: { name: "👀" }, me: false }],
    });

    const retainForm = new FormData();
    retainForm.set(
      "payload_json",
      JSON.stringify({
        attachments: [{ id: created.attachments[0]!.id }],
        content: "final multipart",
      }),
    );
    retainForm.set("files[1]", new Blob(["second"], { type: "text/plain" }), "second.txt");
    const retained = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
      {
        body: retainForm,
        headers: { authorization: `Bot ${server.manifest.botToken}` },
        method: "PATCH",
      },
    );
    await expect(retained.json()).resolves.toMatchObject({
      attachments: [
        expect.objectContaining({ filename: "proof.txt" }),
        expect.objectContaining({ filename: "second.txt" }),
      ],
    });

    const malformedForm = new FormData();
    malformedForm.set("payload_json", "{");
    const malformed = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages`,
      {
        body: malformedForm,
        headers: { authorization: `Bot ${server.manifest.botToken}` },
        method: "POST",
      },
    );
    expect(malformed.status).toBe(400);

    const archive = await fetch(`${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}`, {
      body: JSON.stringify({ archived: true }),
      headers: auth(server),
      method: "PATCH",
    });
    await expect(archive.json()).resolves.toMatchObject({ thread_metadata: { archived: true } });
    expect(
      (
        await fetch(
          `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/thread-members/@me`,
          { headers: driverAuth(server), method: "PUT" },
        )
      ).status,
    ).toBe(403);

    const voiceDispatches = nextMessages(socket, 2);
    socket.send(
      JSON.stringify({
        d: {
          channel_id: server.manifest.fixture.voiceChannelId,
          guild_id: GUILD_ID,
          self_deaf: false,
          self_mute: false,
        },
        op: 4,
      }),
    );
    await expect(voiceDispatches).resolves.toEqual([
      expect.objectContaining({
        d: expect.objectContaining({
          channel_id: server.manifest.fixture.voiceChannelId,
          user_id: server.manifest.botUserId,
        }),
        t: "VOICE_STATE_UPDATE",
      }),
      expect.objectContaining({ t: "VOICE_SERVER_UPDATE" }),
    ]);
    const voiceState = await fetch(
      `${server.manifest.endpoints.apiRoot}/v10/guilds/${GUILD_ID}/voice-states/@me`,
      { headers: auth(server) },
    );
    await expect(voiceState.json()).resolves.toMatchObject({
      channel_id: server.manifest.fixture.voiceChannelId,
    });
    const muteUpdate = nextMessage(socket);
    socket.send(
      JSON.stringify({
        d: {
          channel_id: server.manifest.fixture.voiceChannelId,
          guild_id: GUILD_ID,
          self_deaf: false,
          self_mute: true,
        },
        op: 4,
      }),
    );
    await expect(muteUpdate).resolves.toMatchObject({
      d: { deaf: false, mute: false, self_mute: true, session_id: expect.any(String) },
      t: "VOICE_STATE_UPDATE",
    });
    await expectNoMessage(socket);

    expect(
      (
        await fetch(
          `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
          { headers: auth(server), method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(
          `${server.manifest.endpoints.apiRoot}/v10/channels/${thread.id}/messages/${created.id}`,
          { headers: auth(server) },
        )
      ).status,
    ).toBe(404);
    socket.close();
  });

  it("performs the Discord voice WebSocket and UDP handshake", async () => {
    const server = await startTestServer();
    await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        content: "voice fixture",
        guildId: GUILD_ID,
        senderId: USER_ID,
        voiceChannelId: server.manifest.fixture.voiceChannelId,
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    const gateway = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const gatewayHello = nextMessage(gateway);
    await waitForOpen(gateway);
    await gatewayHello;
    const gatewayReady = nextMessage(gateway);
    gateway.send(JSON.stringify({ d: { intents: 0, token: server.manifest.botToken }, op: 2 }));
    await gatewayReady;
    const voiceUpdates = nextMessages(gateway, 2);
    gateway.send(
      JSON.stringify({
        d: {
          channel_id: server.manifest.fixture.voiceChannelId,
          guild_id: GUILD_ID,
          self_deaf: false,
          self_mute: false,
        },
        op: 4,
      }),
    );
    const [voiceState, voiceServer] = await voiceUpdates;
    if (!voiceState || !voiceServer) {
      throw new Error("Discord voice state and server updates were not emitted.");
    }
    const sessionId = (voiceState.d as { session_id: string }).session_id;
    const voiceToken = (voiceServer.d as { token: string }).token;

    const unauthorized = new WebSocket(`wss://${server.manifest.endpoints.voiceEndpoint}?v=8`, {
      ca: server.manifest.endpoints.voiceCaCertificate,
    });
    const unauthorizedHello = nextMessage(unauthorized);
    await waitForOpen(unauthorized);
    await unauthorizedHello;
    const unauthorizedClose = waitForClose(unauthorized);
    unauthorized.send(
      JSON.stringify({
        op: 0,
        d: { server_id: GUILD_ID, session_id: "invalid", token: "invalid", user_id: USER_ID },
      }),
    );
    await expect(unauthorizedClose).resolves.toBe(4_004);

    const invalidProtocol = new WebSocket(`wss://${server.manifest.endpoints.voiceEndpoint}?v=8`, {
      ca: server.manifest.endpoints.voiceCaCertificate,
    });
    const invalidProtocolHello = nextMessage(invalidProtocol);
    await waitForOpen(invalidProtocol);
    await invalidProtocolHello;
    const invalidProtocolReady = nextMessage(invalidProtocol);
    invalidProtocol.send(
      JSON.stringify({
        op: 0,
        d: {
          server_id: GUILD_ID,
          session_id: sessionId,
          token: voiceToken,
          user_id: server.manifest.botUserId,
        },
      }),
    );
    await invalidProtocolReady;
    const invalidProtocolClose = waitForClose(invalidProtocol);
    invalidProtocol.send(
      JSON.stringify({
        op: 1,
        d: { protocol: "tcp", data: { address: "127.0.0.1", mode: "plain", port: 1 } },
      }),
    );
    await expect(invalidProtocolClose).resolves.toBe(4_002);

    const socket = new WebSocket(`wss://${server.manifest.endpoints.voiceEndpoint}?v=8`, {
      ca: server.manifest.endpoints.voiceCaCertificate,
    });
    const hello = nextMessage(socket);
    await waitForOpen(socket);
    await expect(hello).resolves.toMatchObject({ op: 8 });

    const ready = nextMessage(socket);
    socket.send(
      JSON.stringify({
        op: 0,
        d: {
          server_id: GUILD_ID,
          session_id: sessionId,
          token: voiceToken,
          user_id: server.manifest.botUserId,
        },
      }),
    );
    const readyPayload = await ready;
    expect(readyPayload).toMatchObject({
      op: 2,
      d: { ip: "127.0.0.1", ssrc: 1 },
    });
    const udpPort = (readyPayload.d as { port: number }).port;
    const udp = createSocket("udp4");
    const discoveryResponse = new Promise<Buffer>((resolve, reject) => {
      udp.once("message", resolve);
      udp.once("error", reject);
    });
    const discovery = Buffer.alloc(74);
    discovery.writeUInt16BE(1, 0);
    discovery.writeUInt16BE(70, 2);
    discovery.writeUInt32BE(1, 4);
    await new Promise<void>((resolve, reject) => {
      udp.send(discovery, udpPort, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
    });
    const discovered = await discoveryResponse;
    expect(discovered).toEqual(expect.objectContaining({ length: 74 }));
    const discoveredAddress = discovered.subarray(8, 72).toString("utf8").split("\0", 1)[0];
    const udpAddress = udp.address();
    expect(discoveredAddress).toBe("127.0.0.1");
    expect(discovered.readUInt16BE(72)).toBe(typeof udpAddress === "string" ? 0 : udpAddress.port);
    udp.close();

    const sessionDescription = nextMessage(socket);
    socket.send(
      JSON.stringify({
        op: 1,
        d: {
          protocol: "udp",
          data: {
            address: "127.0.0.1",
            mode: "aead_xchacha20_poly1305_rtpsize",
            port: udpPort,
          },
        },
      }),
    );
    await expect(sessionDescription).resolves.toMatchObject({
      op: 4,
      d: { mode: "aead_xchacha20_poly1305_rtpsize", secret_key: expect.any(Array) },
    });
    const muteUpdate = nextMessage(gateway);
    gateway.send(
      JSON.stringify({
        d: {
          channel_id: server.manifest.fixture.voiceChannelId,
          guild_id: GUILD_ID,
          self_deaf: false,
          self_mute: true,
        },
        op: 4,
      }),
    );
    await expect(muteUpdate).resolves.toMatchObject({
      d: { deaf: false, mute: false, self_mute: true, session_id: sessionId },
      t: "VOICE_STATE_UPDATE",
    });
    await expectNoMessage(gateway);
    const heartbeatAck = nextMessage(socket);
    socket.send(JSON.stringify({ d: 42, op: 3 }));
    await expect(heartbeatAck).resolves.toEqual({ d: 42, op: 6 });
    const revoked = waitForClose(socket);
    gateway.send(
      JSON.stringify({
        d: { channel_id: null, guild_id: GUILD_ID, self_deaf: false, self_mute: false },
        op: 4,
      }),
    );
    await expect(revoked).resolves.toBe(4_006);
    const staleResume = new WebSocket(`wss://${server.manifest.endpoints.voiceEndpoint}?v=8`, {
      ca: server.manifest.endpoints.voiceCaCertificate,
    });
    const staleHello = nextMessage(staleResume);
    await waitForOpen(staleResume);
    await staleHello;
    const staleClose = waitForClose(staleResume);
    staleResume.send(
      JSON.stringify({
        op: 7,
        d: { server_id: GUILD_ID, session_id: sessionId, token: voiceToken },
      }),
    );
    await expect(staleClose).resolves.toBe(4_006);
    gateway.close();
    await server.close();
    servers.splice(servers.indexOf(server), 1);

    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).toContain('"method":"WS","path":"/voice?v=8"');
    expect(recorder).toContain('"kind":"ip-discovery"');
    expect(recorder).toContain('"method":"UDP","path":"/voice"');
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

  it("bounds voice shutdown while a regular HTTPS request remains active", async () => {
    const server = await startTestServer();
    const hangingRequest = request(`https://${server.manifest.endpoints.voiceEndpoint}`, {
      ca: server.manifest.endpoints.voiceCaCertificate,
    });
    hangingRequest.on("error", () => undefined);
    const connected = new Promise<void>((resolve, reject) => {
      hangingRequest.once("socket", (socket) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      hangingRequest.once("error", reject);
    });
    hangingRequest.end();
    await connected;

    await expect(server.close()).resolves.toBeUndefined();
    servers.splice(servers.indexOf(server), 1);
  });

  it("rejects malformed and nonexistent Gateway voice-state selections without crashing", async () => {
    const server = await startTestServer();
    const gateway = new WebSocket(server.manifest.endpoints.gatewayUrl);
    const hello = nextMessage(gateway);
    await waitForOpen(gateway);
    await hello;
    const ready = nextMessage(gateway);
    gateway.send(JSON.stringify({ d: { intents: 0, token: server.manifest.botToken }, op: 2 }));
    await ready;
    const malformedClose = waitForClose(gateway);
    gateway.send(JSON.stringify({ d: { channel_id: {}, guild_id: null }, op: 4 }));
    await expect(malformedClose).resolves.toBe(4_002);
    const identity = await fetch(`${server.manifest.endpoints.apiRoot}/v10/users/@me`, {
      headers: auth(server),
    });
    expect(identity.status).toBe(200);
  });

  it("randomizes both accepted bot credentials for external binds", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startDiscordServer({
      host: "0.0.0.0",
      recorderPath: path.join(directory, "discord.jsonl"),
    });
    servers.push(server);
    const deterministicDriver = `${Buffer.from(server.manifest.driverBotUserId).toString("base64url")}.crabline.discord`;
    expect(server.manifest.driverBotToken).not.toBe(deterministicDriver);
    expect(server.manifest.botToken.split(".")).toHaveLength(3);
    expect(server.manifest.driverBotToken.split(".")).toHaveLength(3);
  });

  it("starts and closes cleanly on IPv6 loopback", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startDiscordServer({
      host: "::1",
      recorderPath: path.join(directory, "discord.jsonl"),
    });
    servers.push(server);
    expect(server.manifest.endpoints.voiceEndpoint).toMatch(/^\[::1\]:\d+\/voice$/u);
    expect(
      new X509Certificate(server.manifest.endpoints.voiceCaCertificate).subjectAltName,
    ).toContain("IP Address:0:0:0:0:0:0:0:1");
    const voiceUrl = new URL(`wss://${server.manifest.endpoints.voiceEndpoint}?v=8`);
    voiceUrl.hostname = "localhost";
    const socket = new WebSocket(voiceUrl, {
      ca: server.manifest.endpoints.voiceCaCertificate,
      // Node 22.23.x regressed matching IPv6 IP SANs. Keep certificate verification enabled
      // against the certificate's localhost SAN while still connecting over the advertised ::1.
      agent: new Agent({
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address: "::1", family: 6 }]);
            return;
          }
          callback(null, "::1", 6);
        },
      }),
    });
    const hello = nextMessage(socket);
    await waitForOpen(socket);
    await expect(hello).resolves.toMatchObject({ op: 8 });
    socket.close();
  });
});
