import fs from "node:fs/promises";
import path from "node:path";
import { ClientEvent, createClient, RoomEvent, SyncState, type MatrixEvent } from "matrix-js-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { startMatrixServer, type StartedMatrixServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedMatrixServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Matrix local provider server", () => {
  it("serves the native client-server API and records room sends", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "matrix.jsonl");
    const server = await startMatrixServer({
      accessToken: "matrix-token",
      adminToken: "admin-secret",
      recorderPath,
      roomId: "!qa:matrix.test",
    });
    servers.push(server);

    const unauthorized = await fetch(`${server.manifest.endpoints.clientApiRoot}/account/whoami`);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      errcode: "M_UNKNOWN_TOKEN",
      error: "Invalid access token",
    });

    const whoami = await fetch(`${server.manifest.endpoints.clientApiRoot}/account/whoami`, {
      headers: auth("matrix-token"),
    });
    await expect(whoami.json()).resolves.toMatchObject({
      device_id: "CRABLINE",
      user_id: server.manifest.botUserId,
    });

    const sent = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!qa:matrix.test")}/send/m.room.message/txn-1`,
      {
        body: JSON.stringify({ body: "hello Matrix", msgtype: "m.text" }),
        headers: { ...auth("matrix-token"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(sent.json()).resolves.toMatchObject({ event_id: expect.stringMatching(/^\$/u) });

    const sync = await fetch(`${server.manifest.endpoints.syncUrl}?timeout=0`, {
      headers: auth("matrix-token"),
    });
    const syncBody = (await sync.json()) as {
      rooms: { join: Record<string, { timeline: { events: unknown[] } }> };
    };
    expect(syncBody.rooms.join["!qa:matrix.test"]?.timeline.events).toContainEqual(
      expect.objectContaining({
        content: { body: "hello Matrix", msgtype: "m.text" },
        sender: server.manifest.botUserId,
        type: "m.room.message",
      }),
    );

    const records = (await fs.readFile(recorderPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toContainEqual(
      expect.objectContaining({
        body: { body: "hello Matrix", msgtype: "m.text" },
        method: "PUT",
        path: "/_matrix/client/v3/rooms/!qa%3Amatrix.test/send/m.room.message/txn-1",
        type: "api",
      }),
    );
  });

  it("works with matrix-js-sdk sync and delivers admin inbound as a room event", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "matrix-token",
      adminToken: "admin-secret",
      recorderPath: path.join(directory, "matrix-sdk.jsonl"),
      roomId: "!qa:matrix.test",
    });
    servers.push(server);

    const client = createClient({
      accessToken: server.manifest.accessToken,
      baseUrl: server.manifest.baseUrl,
      deviceId: server.manifest.deviceId,
      userId: server.manifest.botUserId,
      useAuthorizationHeader: true,
    });
    const ready = new Promise<void>((resolve, reject) => {
      client.on(ClientEvent.Sync, (state) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          resolve();
        }
        if (state === SyncState.Error) {
          reject(new Error("Matrix SDK entered an error sync state"));
        }
      });
    });
    client.startClient({ initialSyncLimit: 10 });
    await ready;

    const inbound = new Promise<MatrixEvent>((resolve) => {
      client.on(RoomEvent.Timeline, (event) => {
        if (event.getSender() === "@alice:matrix.test" && event.getType() === "m.room.message") {
          resolve(event);
        }
      });
    });
    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId: "!qa:matrix.test",
        senderId: "@alice:matrix.test",
        senderName: "Alice",
        text: "hello from Alice",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin-secret",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);

    const event = await inbound;
    expect(event.getRoomId()).toBe("!qa:matrix.test");
    expect(event.getType()).toBe("m.room.message");
    expect(event.getContent()).toMatchObject({ body: "hello from Alice", msgtype: "m.text" });
    expect(client.getRoom("!qa:matrix.test")?.getMember("@alice:matrix.test")?.membership).toBe(
      "join",
    );

    const profile = await client.getProfileInfo("@alice:matrix.test");
    expect(profile).toEqual({ displayname: "Alice" });

    const sent = await client.sendTextMessage("!qa:matrix.test", "hello from the SDK");
    expect(sent.event_id).toMatch(/^\$/u);
    client.stopClient();
  });

  it("provisions direct rooms with native Matrix membership evidence", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "matrix-token",
      adminToken: "admin-secret",
      recorderPath: path.join(directory, "matrix-direct.jsonl"),
    });
    servers.push(server);

    const roomId = "!direct:matrix.test";
    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        direct: true,
        roomId,
        senderId: "@alice:matrix.test",
        text: "direct hello",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin-secret",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);

    const members = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/joined_members`,
      { headers: auth("matrix-token") },
    );
    await expect(members.json()).resolves.toEqual({
      joined: {
        "@alice:matrix.test": {},
        [server.manifest.botUserId]: { display_name: "OpenClaw QA" },
      },
    });
    const botMembership = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(server.manifest.botUserId)}`,
      { headers: auth("matrix-token") },
    );
    await expect(botMembership.json()).resolves.toMatchObject({
      displayname: "OpenClaw QA",
      is_direct: true,
      membership: "join",
    });
  });
});
