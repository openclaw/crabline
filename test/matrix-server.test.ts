import fs from "node:fs/promises";
import path from "node:path";
import { ClientEvent, createClient, RoomEvent, SyncState, type MatrixEvent } from "matrix-js-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { startMatrixServer, type StartedMatrixServer } from "../src/index.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

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
          headers: { ...auth("matrix-token"), "content-type": "application/json" },
          method: "PUT",
        },
      );
      expect(sent.status).toBe(200);
    }
    const filteredSync = await fetch(
      `${server.manifest.endpoints.syncUrl}?filter=${createdBody.filter_id}`,
      { headers: auth("matrix-token") },
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
  });

  it("publishes typing and receipt updates through room ephemeral sync", async () => {
    const server = await startMatrixServer({
      accessToken: "matrix-token",
      roomId: "!ephemeral:matrix.test",
    });
    servers.push(server);
    const initial = (await (
      await fetch(server.manifest.endpoints.syncUrl, { headers: auth("matrix-token") })
    ).json()) as { next_batch: string };
    const sent = (await (
      await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/send/m.room.message/ephemeral-message`,
        {
          body: JSON.stringify({ body: "read me", msgtype: "m.text" }),
          headers: { ...auth("matrix-token"), "content-type": "application/json" },
          method: "PUT",
        },
      )
    ).json()) as { event_id: string };

    const typing = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: 30_000, typing: true }),
        headers: { ...auth("matrix-token"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(typing.status).toBe(200);
    const stringTimeout = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: "30000", typing: true }),
        headers: { ...auth("matrix-token"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(stringTimeout.status).toBe(400);
    const receipt = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/receipt/m.read/${encodeURIComponent(sent.event_id)}`,
      {
        body: "{}",
        headers: { ...auth("matrix-token"), "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(receipt.status).toBe(200);

    const sync = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${initial.next_batch}`, {
        headers: auth("matrix-token"),
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
      await fetch(server.manifest.endpoints.syncUrl, { headers: auth("matrix-token") })
    ).json()) as { next_batch: string };
    await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!ephemeral:matrix.test")}/typing/${encodeURIComponent(server.manifest.botUserId)}`,
      {
        body: JSON.stringify({ timeout: 10, typing: true }),
        headers: { ...auth("matrix-token"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const expired = (await (
      await fetch(`${server.manifest.endpoints.syncUrl}?since=${beforeExpiry.next_batch}`, {
        headers: auth("matrix-token"),
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
      accessToken: "matrix-token",
      adminToken: "admin-secret",
    });
    servers.push(server);
    const roomId = "!rename:matrix.test";
    for (const senderName of ["Alice", "Alicia"]) {
      const response = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          roomId,
          senderId: "@alice:matrix.test",
          senderName,
          text: `hello from ${senderName}`,
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin-secret",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
    }

    const membership = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent("@alice:matrix.test")}`,
      { headers: auth("matrix-token") },
    );
    await expect(membership.json()).resolves.toEqual({
      displayname: "Alicia",
      membership: "join",
    });
  });

  it("bounds retained timelines and transaction responses", async () => {
    const server = await startMatrixServer({
      accessToken: "matrix-token",
      roomId: "!bounded:matrix.test",
    });
    servers.push(server);
    let firstEventId = "";
    for (let index = 0; index <= 1_000; index += 1) {
      const response = await fetch(
        `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-${index}`,
        {
          body: JSON.stringify({ body: `message ${index}`, msgtype: "m.text" }),
          headers: { ...auth("matrix-token"), "content-type": "application/json" },
          method: "PUT",
        },
      );
      const body = (await response.json()) as { event_id: string };
      if (index === 0) {
        firstEventId = body.event_id;
      }
    }

    const sync = (await (
      await fetch(server.manifest.endpoints.syncUrl, { headers: auth("matrix-token") })
    ).json()) as {
      rooms: { join: Record<string, { timeline: { events: unknown[]; limited: boolean } }> };
    };
    expect(sync.rooms.join["!bounded:matrix.test"]?.timeline).toMatchObject({
      limited: true,
    });
    expect(sync.rooms.join["!bounded:matrix.test"]?.timeline.events).toHaveLength(1_000);

    const retried = await fetch(
      `${server.manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent("!bounded:matrix.test")}/send/m.room.message/bounded-0`,
      {
        body: JSON.stringify({ body: "transaction was evicted", msgtype: "m.text" }),
        headers: { ...auth("matrix-token"), "content-type": "application/json" },
        method: "PUT",
      },
    );
    await expect(retried.json()).resolves.not.toEqual({ event_id: firstEventId });
  });
});
