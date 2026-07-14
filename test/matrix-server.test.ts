import fs from "node:fs/promises";
import path from "node:path";
import {
  ClientEvent,
  createClient,
  EventType,
  RoomEvent,
  SyncState,
  type MatrixEvent,
} from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMatrixServer, type StartedMatrixServer } from "../src/index.js";
import { ADMIN_TOKEN_HEADER } from "../src/servers/http.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

const servers: StartedMatrixServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
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

    const invalidJson = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!qa:matrix.test")}/send/m.room.message/invalid-json`,
      {
        body: "{",
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      errcode: "M_NOT_JSON",
      error: "Request body is not valid JSON",
    });

    const whoami = await fetch(`${server.manifest.endpoints.clientApiRoot}/account/whoami`, {
      headers: auth("test-token-placeholder"),
    });
    await expect(whoami.json()).resolves.toMatchObject({
      device_id: "CRABLINE",
      user_id: server.manifest.botUserId,
    });

    const sent = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!qa:matrix.test")}/send/m.room.message/txn-1`,
      {
        body: JSON.stringify({ body: "hello Matrix", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(sent.json()).resolves.toMatchObject({ event_id: expect.stringMatching(/^\$/u) });

    const sync = await fetch(`${server.manifest.endpoints.syncUrl}?timeout=0`, {
      headers: auth("test-token-placeholder"),
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
        accepted: true,
        body: { body: "hello Matrix", msgtype: "m.text" },
        method: "PUT",
        path: "/_matrix/client/v3/rooms/!qa%3Amatrix.test/send/m.room.message/txn-1",
        type: "api",
      }),
    );
  });

  it("validates object bodies, rejects oversized payloads, and records only authenticated API calls", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const observed: unknown[] = [];
    const server = await startMatrixServer({
      accessToken: "test-token",
      onEvent: (event) => {
        observed.push(event);
      },
      recorderPath: path.join(directory, "matrix-ingress.jsonl"),
      roomId: "!qa:matrix.test",
    });
    servers.push(server);
    const sendUrl = `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!qa:matrix.test")}/send/m.room.message/ingress`;

    const unauthorized = await fetch(sendUrl, {
      body: JSON.stringify({ body: "untrusted matrix body", msgtype: "m.text" }),
      headers: { ...auth("wrong-token"), "content-type": "application/json" },
      method: "PUT",
    });
    expect(unauthorized.status).toBe(401);
    const trailingAuthorization = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/account/whoami`,
      {
        headers: { authorization: "Bearer test-token trailing" },
      },
    );
    expect(trailingAuthorization.status).toBe(401);
    await expect(trailingAuthorization.json()).resolves.toEqual({
      errcode: "M_UNKNOWN_TOKEN",
      error: "Invalid access token",
    });
    const unauthorizedOversized = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        ...auth("wrong-token"),
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "PUT",
      url: sendUrl,
    });
    expect(unauthorizedOversized.status).toBe(401);

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalid = await fetch(sendUrl, {
        body: scalarBody,
        headers: { ...auth("test-token"), "content-type": "application/json" },
        method: "PUT",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        errcode: "M_BAD_JSON",
        error: "Request body must be a JSON object",
      });
    }

    const oversized = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        ...auth("test-token"),
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "PUT",
      url: sendUrl,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({
      errcode: "M_TOO_LARGE",
      error: "Request body is too large",
    });

    const whoami = await fetch(`${server.manifest.endpoints.clientApiRoot}/account/whoami`, {
      headers: auth("test-token"),
    });
    expect(whoami.status).toBe(200);

    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).not.toContain("untrusted matrix body");
    expect(observed).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/_matrix/client/v3/account/whoami",
        type: "api",
      }),
    ]);
  });

  it("returns filters only through their owning user URL", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      recorderPath: path.join(directory, "matrix-filter-owner.jsonl"),
      roomId: "!filter:matrix.test",
    });
    servers.push(server);
    const filter = { room: { timeline: { limit: 1 } } };
    const created = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/user/${encodeURIComponent(server.manifest.botUserId)}/filter`,
      {
        body: JSON.stringify(filter),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "POST",
      },
    );
    const createdBody = (await created.json()) as { filter_id: string };

    const owned = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/user/${encodeURIComponent(server.manifest.botUserId)}/filter/${createdBody.filter_id}`,
      { headers: auth("test-token-placeholder") },
    );
    await expect(owned.json()).resolves.toEqual(filter);

    for (const [index, text] of ["first", "second"].entries()) {
      const sent = await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!filter:matrix.test")}/send/m.room.message/filter-${index}`,
        {
          body: JSON.stringify({ body: text, msgtype: "m.text" }),
          headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
          method: "PUT",
        },
      );
      expect(sent.status).toBe(200);
    }
    const filteredSync = await fetch(
      `${server.manifest.endpoints.syncUrl}?filter=${createdBody.filter_id}`,
      { headers: auth("test-token-placeholder") },
    );
    const filteredSyncBody = (await filteredSync.json()) as {
      rooms: {
        join: Record<
          string,
          { timeline: { events: Array<{ content: { body?: string } }>; limited: boolean } }
        >;
      };
    };
    expect(Object.values(filteredSyncBody.rooms.join)[0]?.timeline).toMatchObject({
      events: [{ content: { body: "second" } }],
      limited: true,
    });

    const forged = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/user/${encodeURIComponent("@other:matrix.test")}/filter/${createdBody.filter_id}`,
      { headers: auth("test-token-placeholder") },
    );
    expect(forged.status).toBe(403);
    await expect(forged.json()).resolves.toEqual({
      errcode: "M_FORBIDDEN",
      error: "Cannot get filters for another user",
    });
  });

  it("bounds retained filters by count and aggregate bytes", async () => {
    const server = await startMatrixServer({ accessToken: "test-token-placeholder" });
    servers.push(server);
    const filtersUrl = `${server.manifest.endpoints.clientApiRoot}/user/${encodeURIComponent(server.manifest.botUserId)}/filter`;
    const createFilter = (body: Record<string, unknown>) =>
      fetch(filtersUrl, {
        body: JSON.stringify(body),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "POST",
      });

    expect((await createFilter({ value: "x".repeat(700_000) })).status).toBe(200);
    const oversizedAggregate = await createFilter({ value: "y".repeat(400_000) });
    expect(oversizedAggregate.status).toBe(503);
    await expect(oversizedAggregate.json()).resolves.toEqual({
      admin_contact: "mailto:admin@localhost",
      errcode: "M_RESOURCE_LIMIT_EXCEEDED",
      error: "Too many stored filters",
    });

    const countServer = await startMatrixServer();
    servers.push(countServer);
    const countUrl = `${countServer.manifest.endpoints.clientApiRoot}/user/${encodeURIComponent(countServer.manifest.botUserId)}/filter`;
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(countUrl, {
        body: JSON.stringify({ index }),
        headers: {
          ...auth(countServer.manifest.accessToken),
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
    }
    const overCount = await fetch(countUrl, {
      body: "{}",
      headers: {
        ...auth(countServer.manifest.accessToken),
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(overCount.status).toBe(503);
  });

  it("bounds committed room and user state before mutation", async () => {
    const server = await startMatrixServer({
      accessToken: "fake",
      adminToken: "admin",
      maxCommittedRooms: 2,
      maxCommittedUsers: 2,
      roomId: "!default:matrix.test",
    });
    servers.push(server);
    const sendInbound = (body: Record<string, unknown>) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: "admin",
        },
        method: "POST",
      });

    expect(
      (
        await sendInbound({
          roomId: "!dynamic:matrix.test",
          senderId: "@alice:matrix.test",
          text: "fills committed state",
        })
      ).status,
    ).toBe(200);

    const roomLimit = await sendInbound({
      roomId: "!overflow:matrix.test",
      senderId: "@alice:matrix.test",
      text: "new room",
    });
    expect(roomLimit.status).toBe(503);
    await expect(roomLimit.json()).resolves.toEqual({
      error: "Committed Matrix rooms limit reached",
      ok: false,
    });

    const userLimit = await sendInbound({
      roomId: "!dynamic:matrix.test",
      senderId: "@bob:matrix.test",
      text: "new user",
    });
    expect(userLimit.status).toBe(503);
    await expect(userLimit.json()).resolves.toEqual({
      error: "Committed Matrix users limit reached",
      ok: false,
    });

    const rooms = await fetch(`${server.manifest.endpoints.clientApiRoot}/joined_rooms`, {
      headers: auth("fake"),
    });
    await expect(rooms.json()).resolves.toEqual({
      joined_rooms: ["!default:matrix.test", "!dynamic:matrix.test"],
    });
    const bobProfile = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/profile/${encodeURIComponent("@bob:matrix.test")}`,
      { headers: auth("fake") },
    );
    expect(bobProfile.status).toBe(404);
    const members = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!dynamic:matrix.test")}/joined_members`,
      { headers: auth("fake") },
    );
    await expect(members.json()).resolves.toEqual({
      joined: {
        "@alice:matrix.test": {},
        [server.manifest.botUserId]: { display_name: "OpenClaw QA" },
      },
    });
  });

  it("validates committed Matrix state limits", async () => {
    await expect(startMatrixServer({ maxCommittedRooms: 0 })).rejects.toThrow(
      "maxCommittedRooms must be a positive safe integer.",
    );
    await expect(startMatrixServer({ maxCommittedUsers: 0 })).rejects.toThrow(
      "maxCommittedUsers must be a positive safe integer.",
    );
  });

  it("rejects malformed native identifiers before mutating room state", async () => {
    const server = await startMatrixServer();
    servers.push(server);
    for (const body of [
      { roomId: "room", senderId: "@alice:matrix.test", text: "bad room" },
      { roomId: "!short", senderId: "@alice:matrix.test", text: "bad room hash" },
      { roomId: "!room:matrix.test", senderId: "alice", text: "bad sender" },
      { roomId: "!room:bad/name", senderId: "@alice:matrix.test", text: "bad room host" },
      {
        roomId: "!room:invalid_host",
        senderId: "@alice:matrix.test",
        text: "bad DNS room host",
      },
      { roomId: "!room:matrix.test", senderId: "@alice:bad?host", text: "bad sender host" },
      {
        roomId: "!room:matrix.test",
        senderId: "@alice:invalid_host",
        text: "bad DNS sender host",
      },
      { roomId: "!room:256.2.3.4", senderId: "@alice:matrix.test", text: "bad IPv4" },
      {
        roomId: "!room:matrix.test",
        senderId: "@alice:matrix.test",
        text: "bad thread",
        threadId: "event",
      },
      {
        roomId: "!room:matrix.test",
        senderId: "@alice:matrix.test",
        text: "bad event hash",
        threadId: "$short",
      },
    ]) {
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
        },
        method: "POST",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid Matrix identifier",
        ok: false,
      });
    }
    const rooms = await fetch(`${server.manifest.endpoints.clientApiRoot}/joined_rooms`, {
      headers: auth(server.manifest.accessToken),
    });
    const body = (await rooms.json()) as { joined_rooms: string[] };
    expect(body.joined_rooms).not.toContain("!room:matrix.test");
  });

  it("accepts version-specific domainless room and event identifiers", async () => {
    const server = await startMatrixServer();
    servers.push(server);
    const roomId = `!${Buffer.alloc(32, 0xab).toString("base64url")}`;
    const threadId = `$${Buffer.alloc(32, 0xff).toString("base64").replace(/=+$/u, "")}`;

    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId,
        senderId: "@alice:matrix.test",
        text: "domainless identifiers",
        threadId,
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: {
        content: {
          "m.relates_to": {
            event_id: threadId,
            "m.in_reply_to": { event_id: threadId },
          },
        },
        room_id: roomId,
      },
      ok: true,
    });
  });

  it("accepts historical user localparts for inbound event senders", async () => {
    const server = await startMatrixServer();
    servers.push(server);
    const roomId = "!room name:matrix.test";
    const threadId = "$event root:matrix.test";

    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId,
        senderId: "@Alice Smith:matrix.test",
        text: "scoped identifiers",
        threadId,
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: {
        content: {
          "m.relates_to": {
            event_id: threadId,
            "m.in_reply_to": { event_id: threadId },
          },
        },
        room_id: roomId,
        sender: "@Alice Smith:matrix.test",
      },
      ok: true,
    });

    const emptyLocalpart = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId,
        senderId: "@:matrix.test",
        text: "historical empty localpart",
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
      },
      method: "POST",
    });
    expect(emptyLocalpart.status).toBe(200);
    await expect(emptyLocalpart.json()).resolves.toMatchObject({
      event: { sender: "@:matrix.test" },
      ok: true,
    });
  });

  it("requires a canonical configured bot user ID", async () => {
    for (const botUserId of [
      "@:matrix.test",
      "@Alice:matrix.test",
      "@alice smith:matrix.test",
      "@alice*:matrix.test",
    ]) {
      await expect(startMatrixServer({ botUserId })).rejects.toThrow(
        "botUserId must be a canonical Matrix user ID.",
      );
    }

    const server = await startMatrixServer({ botUserId: "@open+claw:matrix.test" });
    servers.push(server);
    expect(server.manifest.botUserId).toBe("@open+claw:matrix.test");
  });

  it("accepts numeric DNS-form Matrix server names", async () => {
    const server = await startMatrixServer();
    servers.push(server);

    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId: "!room:123",
        senderId: "@alice:123",
        text: "numeric server name",
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: {
        room_id: "!room:123",
        sender: "@alice:123",
      },
      ok: true,
    });
  });

  it("accepts five-digit Matrix ports", async () => {
    const server = await startMatrixServer();
    servers.push(server);

    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId: "!room:matrix.test:99999",
        senderId: "@:matrix.test:99999",
        text: "five-digit port and historical empty localpart",
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: {
        room_id: "!room:matrix.test:99999",
        sender: "@:matrix.test:99999",
      },
      ok: true,
    });
  });

  it("accepts Matrix IPv4 server names with leading-zero octets", async () => {
    const server = await startMatrixServer();
    servers.push(server);

    const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId: "!room:01.2.003.4",
        senderId: "@alice:01.2.003.4",
        text: "Matrix IPv4 grammar",
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: {
        room_id: "!room:01.2.003.4",
        sender: "@alice:01.2.003.4",
      },
      ok: true,
    });
  });

  it("returns M_UNKNOWN_POS for malformed sync tokens instead of initial sync", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "test-auth-token",
      recorderPath: path.join(directory, "matrix-sync-token.jsonl"),
    });
    servers.push(server);

    for (const since of ["", "0", "s-1", "s1", "snot-a-sequence", `s${"9".repeat(32)}`]) {
      const response = await fetch(
        `${server.manifest.endpoints.syncUrl}?since=${encodeURIComponent(since)}`,
        {
          headers: auth("test-auth-token"),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        errcode: "M_UNKNOWN_POS",
        error: "Unknown position",
      });
    }

    const initial = await fetch(server.manifest.endpoints.syncUrl, {
      headers: auth("test-auth-token"),
    });
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      next_batch: expect.stringMatching(/^s\d+$/u),
      rooms: { join: expect.any(Object) },
    });
  });

  it("returns provider-native internal errors without exception details", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      onEvent() {
        throw new Error("sensitive Matrix observer detail");
      },
      recorderPath: path.join(directory, "matrix-internal-error.jsonl"),
    });
    servers.push(server);

    const response = await fetch(`${server.manifest.endpoints.clientApiRoot}/account/whoami`, {
      headers: auth("test-token-placeholder"),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      errcode: "M_UNKNOWN",
      error: "Internal server error",
    });
  });

  it("preserves committed transaction success when recording callbacks fail", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "matrix-committed.jsonl");
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      onEvent() {
        throw new Error("observer failed");
      },
      recorderPath,
      roomId: "!committed:matrix.test",
    });
    servers.push(server);
    const transactionUrl = `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!committed:matrix.test")}/send/m.room.message/stable-transaction`;
    const request = () =>
      fetch(transactionUrl, {
        body: JSON.stringify({ body: "committed once", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      });

    const first = await request();
    const firstBody = (await first.json()) as { event_id: string };
    expect(first.status).toBe(200);
    const replay = await request();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);

    const records = (await fs.readFile(recorderPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { accepted?: boolean; path: string });
    expect(records.filter((record) => record.path === new URL(transactionUrl).pathname)).toEqual([
      expect.objectContaining({ accepted: true }),
      expect.objectContaining({ accepted: true }),
    ]);
  });

  it("works with matrix-js-sdk sync and delivers admin inbound as a room event", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
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
    try {
      await ready;

      const dynamicRoomId = "!dynamic:matrix.test";
      const inbound = new Promise<MatrixEvent>((resolve) => {
        client.on(RoomEvent.Timeline, (event) => {
          if (event.getSender() === "@alice:matrix.test" && event.getType() === "m.room.message") {
            resolve(event);
          }
        });
      });
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          roomId: dynamicRoomId,
          roomName: "Dynamic QA Room",
          senderId: "@alice:matrix.test",
          senderName: "Alice",
          text: "hello from Alice",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "test-auth-token",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);

      const event = await inbound;
      expect(event.getRoomId()).toBe(dynamicRoomId);
      expect(event.getType()).toBe("m.room.message");
      expect(event.getContent()).toMatchObject({ body: "hello from Alice", msgtype: "m.text" });
      await expect
        .poll(() =>
          client
            .getRoom(dynamicRoomId)
            ?.currentState.getStateEvents("m.room.name", "")
            ?.getContent(),
        )
        .toEqual({ name: "Dynamic QA Room" });
      const room = client.getRoom(dynamicRoomId);
      expect(room?.getMember(server.manifest.botUserId)?.membership).toBe("join");
      expect(room?.getMember("@alice:matrix.test")?.membership).toBe("join");

      const profile = await client.getProfileInfo("@alice:matrix.test");
      expect(profile).toEqual({ displayname: "Alice" });

      const sent = await client.sendTextMessage(dynamicRoomId, "hello from the SDK");
      expect(sent.event_id).toMatch(/^\$/u);

      const firstRetry = await client.sendTextMessage(
        dynamicRoomId,
        "idempotent send",
        "stable-transaction",
      );
      const replayClient = createClient({
        accessToken: server.manifest.accessToken,
        baseUrl: server.manifest.baseUrl,
        deviceId: server.manifest.deviceId,
        userId: server.manifest.botUserId,
        useAuthorizationHeader: true,
      });
      const secondRetry = await replayClient.sendTextMessage(
        dynamicRoomId,
        "changed body is ignored on retry",
        "stable-transaction",
      );
      expect(secondRetry.event_id).toBe(firstRetry.event_id);

      const retrySync = await fetch(`${server.manifest.endpoints.syncUrl}?timeout=0`, {
        headers: auth("test-token-placeholder"),
      });
      const retrySyncBody = (await retrySync.json()) as {
        rooms: {
          join: Record<
            string,
            { timeline: { events: Array<{ content: Record<string, unknown>; event_id: string }> } }
          >;
        };
      };
      const retryEvents = retrySyncBody.rooms.join[dynamicRoomId]?.timeline.events.filter(
        (timelineEvent) => timelineEvent.event_id === firstRetry.event_id,
      );
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents?.[0]?.content).toMatchObject({ body: "idempotent send" });
    } finally {
      client.stopClient();
    }
  });

  it("preserves whitespace-only message content and keeps global profiles separate", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "admin",
      recorderPath: path.join(directory, "matrix-profile.jsonl"),
    });
    servers.push(server);
    const senderId = "@alice:matrix.test";

    for (const [roomId, senderName, text] of [
      ["!first:matrix.test", "Alice", " \t "],
      ["!second:matrix.test", "Alicia", "second room"],
    ] as const) {
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ roomId, senderId, senderName, text }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: "admin",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        event: { content: { body: text } },
      });
    }

    const profile = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/profile/${encodeURIComponent(senderId)}`,
      { headers: auth("test-token-placeholder") },
    );
    await expect(profile.json()).resolves.toEqual({ displayname: "Alicia" });

    for (const [roomId, displayname] of [
      ["!first:matrix.test", "Alice"],
      ["!second:matrix.test", "Alicia"],
    ] as const) {
      const member = await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(senderId)}`,
        { headers: auth("test-token-placeholder") },
      );
      await expect(member.json()).resolves.toMatchObject({ displayname });
    }
  });

  it("replays a transaction room error after the room is created", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      recorderPath: path.join(directory, "matrix-transaction-error.jsonl"),
    });
    servers.push(server);
    const roomId = "!later:matrix.test";
    const transactionUrl = `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/send/m.room.message/stable-error`;

    const firstAttempt = await fetch(transactionUrl, {
      body: JSON.stringify({ body: "room does not exist yet", msgtype: "m.text" }),
      headers: { ...auth(server.manifest.accessToken), "content-type": "application/json" },
      method: "PUT",
    });
    expect(firstAttempt.status).toBe(404);
    const firstBody = await firstAttempt.json();
    expect(firstBody).toEqual({
      errcode: "M_NOT_FOUND",
      error: "Unknown room",
    });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId,
        senderId: "@alice:matrix.test",
        text: "create the room",
      }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);

    const retry = await fetch(transactionUrl, {
      body: JSON.stringify({ body: "must not be sent", msgtype: "m.text" }),
      headers: { ...auth(server.manifest.accessToken), "content-type": "application/json" },
      method: "PUT",
    });
    expect(retry.status).toBe(firstAttempt.status);
    await expect(retry.json()).resolves.toEqual(firstBody);

    const nextTransaction = await fetch(`${transactionUrl}-next`, {
      body: JSON.stringify({ body: "new transaction succeeds", msgtype: "m.text" }),
      headers: { ...auth(server.manifest.accessToken), "content-type": "application/json" },
      method: "PUT",
    });
    expect(nextTransaction.status).toBe(200);
    await expect(nextTransaction.json()).resolves.toMatchObject({
      event_id: expect.stringMatching(/^\$/u),
    });
  });

  it("canonicalizes decoded transaction keys and rejects malformed path encoding", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      roomId: "!canonical:matrix.test",
    });
    servers.push(server);
    const first = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!canonical:matrix.test")}/send/m.room.%6dessage/canonical%2Dtransaction`,
      {
        body: JSON.stringify({ body: "canonical body", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    const firstBody = (await first.json()) as { event_id: string };
    const replay = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!canonical:matrix.test")}/send/m.room.message/canonical-transaction`,
      {
        body: JSON.stringify({ body: "must be ignored", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(replay.json()).resolves.toEqual(firstBody);

    const malformed = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/%E0%A4%A/send/m.room.message/malformed`,
      {
        body: JSON.stringify({ body: "not sent", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      errcode: "M_INVALID_PARAM",
      error: "Invalid request path encoding",
    });
  });

  it("provisions direct rooms with native Matrix membership evidence", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
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
        "x-crabline-admin-token": "test-auth-token",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);

    const members = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/joined_members`,
      { headers: auth("test-token-placeholder") },
    );
    await expect(members.json()).resolves.toEqual({
      joined: {
        "@alice:matrix.test": {},
        [server.manifest.botUserId]: { display_name: "OpenClaw QA" },
      },
    });
    const botMembership = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(server.manifest.botUserId)}`,
      { headers: auth("test-token-placeholder") },
    );
    await expect(botMembership.json()).resolves.toMatchObject({
      displayname: "OpenClaw QA",
      is_direct: true,
      membership: "join",
    });

    const { accessToken, baseUrl, botUserId: userId, deviceId } = server.manifest;
    const client = createClient({
      accessToken,
      baseUrl,
      deviceId,
      userId,
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
    try {
      await ready;
      expect(client.getAccountData(EventType.Direct)?.getContent()).toEqual({
        "@alice:matrix.test": [roomId],
      });
    } finally {
      client.stopClient();
    }
  });

  it("publishes typing and receipt updates through room ephemeral sync", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      roomId: "!ephemeral:matrix.test",
    });
    servers.push(server);
    const initial = (await (
      await fetch(server.manifest.endpoints.syncUrl, { headers: auth("test-token-placeholder") })
    ).json()) as { next_batch: string };
    const sent = (await (
      await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/send/m.room.message/ephemeral-message`,
        {
          body: JSON.stringify({ body: "read me", msgtype: "m.text" }),
          headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
          method: "PUT",
        },
      )
    ).json()) as { event_id: string };

    const typing = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: 30_000, typing: true }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(typing.status).toBe(200);
    const stringTimeout = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: "30000", typing: true }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(stringTimeout.status).toBe(400);
    const foreignUser = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent("@alice:matrix.test")}`,
      {
        body: JSON.stringify({ timeout: 30_000, typing: true }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(foreignUser.status).toBe(403);
    await expect(foreignUser.json()).resolves.toMatchObject({ errcode: "M_FORBIDDEN" });
    const oversizedTimeout = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: 2_147_483_648, typing: true }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(oversizedTimeout.status).toBe(400);
    const receipt = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/receipt/m.read/${encodeURIComponent(sent.event_id)}`,
      {
        body: "{}",
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(receipt.status).toBe(200);

    const sync = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${initial.next_batch}`, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      rooms: { join: Record<string, { ephemeral: { events: unknown[] } }> };
    };
    expect(sync.rooms.join["!ephemeral:matrix.test"]?.ephemeral.events).toEqual([
      { content: { user_ids: [server.manifest.botUserId] }, type: "m.typing" },
      {
        content: {
          [sent.event_id]: {
            "m.read": {
              [server.manifest.botUserId]: { ts: expect.any(Number) },
            },
          },
        },
        type: "m.receipt",
      },
    ]);

    const beforeExpiry = (await (
      await fetch(server.manifest.endpoints.syncUrl, { headers: auth("test-token-placeholder") })
    ).json()) as { next_batch: string };
    await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: 10, typing: true }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const expired = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${beforeExpiry.next_batch}`, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      rooms: { join: Record<string, { ephemeral: { events: unknown[] } }> };
    };
    expect(expired.rooms.join["!ephemeral:matrix.test"]?.ephemeral.events).toEqual([
      { content: { user_ids: [server.manifest.botUserId] }, type: "m.typing" },
      { content: { user_ids: [] }, type: "m.typing" },
    ]);
  });

  it("updates membership state when an inbound sender is renamed", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
    });
    servers.push(server);
    const roomId = "!rename:matrix.test";
    const initial = (await (
      await fetch(server.manifest.endpoints.syncUrl, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as { next_batch: string };
    const sendInbound = (senderName: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          roomId,
          senderId: "@alice:matrix.test",
          senderName,
          text: `hello from ${senderName}`,
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "test-auth-token",
        },
        method: "POST",
      });
    expect((await sendInbound("Alice")).status).toBe(200);
    const firstSync = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${initial.next_batch}`, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      rooms: { join: Record<string, { timeline: { events: Array<{ type: string }> } }> };
    };
    expect(
      firstSync.rooms.join[roomId]?.timeline.events.filter(
        (event) => event.type === "m.room.member",
      ),
    ).toHaveLength(1);
    expect((await sendInbound("Alicia")).status).toBe(200);

    const membership = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent("@alice:matrix.test")}`,
      { headers: auth("test-token-placeholder") },
    );
    await expect(membership.json()).resolves.toEqual({
      displayname: "Alicia",
      membership: "join",
    });

    const freshSync = (await (
      await fetch(server.manifest.endpoints.syncUrl, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      rooms: { join: Record<string, { state: { events: MatrixEvent[] } }> };
    };
    expect(freshSync.rooms.join[roomId]?.state.events).not.toContainEqual(
      expect.objectContaining({
        content: { displayname: "Alicia", membership: "join" },
        state_key: "@alice:matrix.test",
      }),
    );
  });

  it("includes omitted state changes when an incremental timeline is limited", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
    });
    servers.push(server);
    const roomId = "!limited-state:matrix.test";
    const sendInbound = (senderName: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          roomId,
          senderId: "@alice:matrix.test",
          senderName,
          text: `hello from ${senderName}`,
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "test-auth-token",
        },
        method: "POST",
      });
    expect((await sendInbound("Alice")).status).toBe(200);
    const initial = (await (
      await fetch(server.manifest.endpoints.syncUrl, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as { next_batch: string };
    expect((await sendInbound("Alicia")).status).toBe(200);

    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }));
    const sync = (await (
      await fetch(
        `${server.manifest.endpoints.syncUrl}?since=${initial.next_batch}&filter=${filter}`,
        { headers: auth("test-token-placeholder") },
      )
    ).json()) as {
      rooms: {
        join: Record<
          string,
          {
            state: { events: MatrixEvent[] };
            timeline: { events: MatrixEvent[]; limited: boolean };
          }
        >;
      };
    };
    const room = sync.rooms.join[roomId];
    expect(room?.timeline.limited).toBe(true);
    expect(room?.timeline.events).toHaveLength(1);
    expect(room?.state.events).toContainEqual(
      expect.objectContaining({
        content: { displayname: "Alicia", membership: "join" },
        state_key: "@alice:matrix.test",
        type: "m.room.member",
      }),
    );
  });

  it("omits unchanged rooms from incremental syncs", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
      roomId: "!quiet:matrix.test",
    });
    servers.push(server);
    const changedRoomId = "!changed:matrix.test";
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          roomId: changedRoomId,
          senderId: "@alice:matrix.test",
          text,
        }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: "test-auth-token",
        },
        method: "POST",
      });

    expect((await sendInbound("before initial sync")).status).toBe(200);
    const initial = (await (
      await fetch(server.manifest.endpoints.syncUrl, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      next_batch: string;
      rooms: { join: Record<string, unknown> };
    };
    expect(Object.keys(initial.rooms.join).sort()).toEqual([
      "!changed:matrix.test",
      "!quiet:matrix.test",
    ]);

    expect((await sendInbound("after initial sync")).status).toBe(200);
    const incremental = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${initial.next_batch}`, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      next_batch: string;
      rooms: { join: Record<string, unknown> };
    };
    expect(Object.keys(incremental.rooms.join)).toEqual([changedRoomId]);

    const unchanged = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${incremental.next_batch}`, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as { rooms: { join: Record<string, unknown> } };
    expect(unchanged.rooms.join).toEqual({});
  });

  it("bounds timelines and retains recently replayed transactions", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const probe = await fs.open(path.join(directory, "sync-probe"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>;
    };
    vi.spyOn(fileHandlePrototype, "sync").mockResolvedValue();
    await probe.close();
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      recorderPath: path.join(directory, "matrix-bounded.jsonl"),
      roomId: "!bounded:matrix.test",
    });
    servers.push(server);
    let firstEventId = "";
    let secondEventId = "";
    let firstBatch = "";
    let typingStatus: number | undefined;
    for (let index = 0; index < 1_000; index += 1) {
      const response = await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-${index}`,
        {
          body: JSON.stringify({ body: `message ${index}`, msgtype: "m.text" }),
          headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
          method: "PUT",
        },
      );
      const body = (await response.json()) as { event_id: string };
      if (index === 0) {
        firstEventId = body.event_id;
        const sync = (await (
          await fetch(server.manifest.endpoints.syncUrl, {
            headers: auth("test-token-placeholder"),
          })
        ).json()) as { next_batch: string };
        firstBatch = sync.next_batch;
        const typing = await fetch(
          `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
          {
            body: JSON.stringify({ typing: false }),
            headers: {
              ...auth("test-token-placeholder"),
              "content-type": "application/json",
            },
            method: "PUT",
          },
        );
        typingStatus = typing.status;
      }
      if (index === 1) {
        secondEventId = body.event_id;
      }
    }
    expect(typingStatus).toBe(200);
    const refreshed = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-0`,
      {
        body: JSON.stringify({ body: "transaction remains idempotent", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(refreshed.json()).resolves.toEqual({ event_id: firstEventId });
    const admitted = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-1000`,
      {
        body: JSON.stringify({ body: "after capacity", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(admitted.status).toBe(503);
    await expect(admitted.json()).resolves.toEqual({
      admin_contact: "mailto:admin@localhost",
      errcode: "M_RESOURCE_LIMIT_EXCEEDED",
      error: "Too many retained transaction responses",
    });
    for (const text of ["advance the bounded timeline", "overflow the bounded timeline"]) {
      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          roomId: "!bounded:matrix.test",
          senderId: server.manifest.botUserId,
          text,
        }),
        headers: new Headers([
          ["content-type", "application/json"],
          ["x-crabline-admin-token", server.manifest.adminToken],
        ]),
        method: "POST",
      });
      expect(inbound.status).toBe(200);
    }

    const sync = (await (
      await fetch(server.manifest.endpoints.syncUrl, { headers: auth("test-token-placeholder") })
    ).json()) as {
      rooms: { join: Record<string, { timeline: { events: unknown[]; limited: boolean } }> };
    };
    expect(sync.rooms.join["!bounded:matrix.test"]?.timeline).toMatchObject({
      limited: true,
    });
    expect(sync.rooms.join["!bounded:matrix.test"]?.timeline.events).toHaveLength(1_000);
    const resumed = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${firstBatch}`, {
        headers: auth("test-token-placeholder"),
      })
    ).json()) as {
      rooms: { join: Record<string, { timeline: { limited: boolean } }> };
    };
    expect(resumed.rooms.join["!bounded:matrix.test"]?.timeline.limited).toBe(true);

    const retried = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-0`,
      {
        body: JSON.stringify({ body: "transaction remains idempotent", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(retried.json()).resolves.toEqual({ event_id: firstEventId });
    const untouchedRetry = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-1`,
      {
        body: JSON.stringify({ body: "transaction remains idempotent", msgtype: "m.text" }),
        headers: { ...auth("test-token-placeholder"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(untouchedRetry.json()).resolves.toEqual({ event_id: secondEventId });
  }, 15_000);

  it("bounds sync responses without skipping the newest deliverable event", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      maxSyncResponseBytes: 2_500,
      roomId: "!sync-budget:matrix.test",
    });
    servers.push(server);
    for (let index = 0; index < 12; index += 1) {
      const response = await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!sync-budget:matrix.test")}/send/m.room.message/budget-${index}`,
        {
          body: JSON.stringify({
            body: `${index}:${"x".repeat(300)}`,
            msgtype: "m.text",
          }),
          headers: {
            ...auth("test-token-placeholder"),
            "content-type": "application/json",
          },
          method: "PUT",
        },
      );
      expect(response.status).toBe(200);
    }

    const response = await fetch(server.manifest.endpoints.syncUrl, {
      headers: auth("test-token-placeholder"),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as {
      rooms: {
        join: Record<
          string,
          { timeline: { events: Array<{ content: { body: string } }>; limited: boolean } }
        >;
      };
    };
    const timeline = body.rooms.join["!sync-budget:matrix.test"]?.timeline;

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(rawBody, "utf8")).toBeLessThanOrEqual(2_500);
    expect(timeline?.limited).toBe(true);
    expect(timeline?.events.length).toBeGreaterThan(0);
    expect(timeline?.events.length).toBeLessThan(12);
    expect(timeline?.events.at(-1)?.content.body).toBe(`11:${"x".repeat(300)}`);
  });

  it("returns a native resource-limit error when the newest sync event cannot fit", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      maxSyncResponseBytes: 1_500,
      roomId: "!sync-too-large:matrix.test",
    });
    servers.push(server);
    const sent = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!sync-too-large:matrix.test")}/send/m.room.message/oversized-sync`,
      {
        body: JSON.stringify({ body: "x".repeat(3_000), msgtype: "m.text" }),
        headers: {
          ...auth("test-token-placeholder"),
          "content-type": "application/json",
        },
        method: "PUT",
      },
    );
    expect(sent.status).toBe(200);

    const response = await fetch(server.manifest.endpoints.syncUrl, {
      headers: auth("test-token-placeholder"),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      admin_contact: "mailto:admin@localhost",
      errcode: "M_RESOURCE_LIMIT_EXCEEDED",
      error: "Sync response exceeds the configured byte limit",
    });
  });

  it("does not advance past the sole deliverable event when room framing exceeds the limit", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      maxSyncResponseBytes: 1_200,
      roomId: "!sync-framing-limit:matrix.test",
    });
    servers.push(server);
    const sent = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!sync-framing-limit:matrix.test")}/send/m.room.message/framing-limit`,
      {
        body: JSON.stringify({ body: "x".repeat(100), msgtype: "m.text" }),
        headers: {
          ...auth("test-token-placeholder"),
          "content-type": "application/json",
        },
        method: "PUT",
      },
    );
    expect(sent.status).toBe(200);

    const response = await fetch(server.manifest.endpoints.syncUrl, {
      headers: auth("test-token-placeholder"),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      admin_contact: "mailto:admin@localhost",
      errcode: "M_RESOURCE_LIMIT_EXCEEDED",
      error: "Sync response exceeds the configured byte limit",
    });
  });

  it("reserves sync capacity for later rooms before adding optional history", async () => {
    const server = await startMatrixServer({
      accessToken: "test-token-placeholder",
      adminToken: "test-auth-token",
      maxSyncResponseBytes: 4_000,
      roomId: "!first-budget:matrix.test",
    });
    servers.push(server);
    for (let index = 0; index < 8; index += 1) {
      const sent = await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!first-budget:matrix.test")}/send/m.room.message/first-${index}`,
        {
          body: JSON.stringify({ body: `${index}:${"x".repeat(300)}`, msgtype: "m.text" }),
          headers: {
            ...auth("test-token-placeholder"),
            "content-type": "application/json",
          },
          method: "PUT",
        },
      );
      expect(sent.status).toBe(200);
    }
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        roomId: "!second-budget:matrix.test",
        senderId: "@alice:matrix.test",
        text: "later room event",
      }),
      headers: {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: "test-auth-token",
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);

    const response = await fetch(server.manifest.endpoints.syncUrl, {
      headers: auth("test-token-placeholder"),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as {
      rooms: {
        join: Record<
          string,
          { timeline: { events: Array<{ content: { body?: string } }>; limited: boolean } }
        >;
      };
    };

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(rawBody, "utf8")).toBeLessThanOrEqual(4_000);
    expect(Object.keys(body.rooms.join).sort()).toEqual([
      "!first-budget:matrix.test",
      "!second-budget:matrix.test",
    ]);
    expect(body.rooms.join["!first-budget:matrix.test"]?.timeline.limited).toBe(true);
    expect(
      body.rooms.join["!second-budget:matrix.test"]?.timeline.events.some(
        (event) => event.content.body === "later room event",
      ),
    ).toBe(true);
  });
});
