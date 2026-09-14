import { EventEmitter, once } from "node:events";
import { connect as connectTcp } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startFeishuServer, type StartedFeishuServer } from "../src/index.js";
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuHeader,
  type FeishuFrame,
} from "../src/servers/feishu-wire.js";
import type { ServerRequestEvent } from "../src/servers/http.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

type DiscoveryResponse = { code: number; data: { URL: string } };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  // A timed-out test body may never reach its local finally.
  vi.useRealTimers();
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Feishu cleanup failed");
  }
});

async function start(params: Parameters<typeof startFeishuServer>[0] = {}) {
  const directory = await createTempDir();
  const events: ServerRequestEvent[] = [];
  const server = await startFeishuServer({
    ...params,
    recorderPath: path.join(directory, "events.jsonl"),
    onEvent: (event) => {
      events.push(event);
      return params.onEvent?.(event);
    },
  });
  cleanups.push(async () => {
    await server.close();
    await disposeTempDir(directory);
  });
  return { server, events };
}

async function json(url: string, body?: unknown, token?: string, method = "POST") {
  return fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function connect(server: StartedFeishuServer) {
  const { manifest } = server;
  const discovery = await json(manifest.endpoints.discoveryUrl, {
    AppID: manifest.appId,
    AppSecret: manifest.appSecret,
  });
  const body = (await discovery.json()) as DiscoveryResponse;
  expect(body.code).toBe(0);
  const socket = new WebSocket(body.data.URL);
  const frames: FeishuFrame[] = [];
  socket.on("message", (bytes: Buffer) => frames.push(decodeFeishuFrame(bytes)));
  await once(socket, "open");
  cleanups.push(async () => {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
    }
  });
  return { socket, frames, url: body.data.URL };
}

function stages(events: ServerRequestEvent[], stage: string) {
  return events.filter((event) => (event.body as { stage?: string } | undefined)?.stage === stage);
}

describe("Feishu DM chat identity", () => {
  const fixture = async (params: Parameters<typeof start>[0] = {}) => {
    const result = await start(params);
    const { manifest } = result.server;
    const auth = await json(`${manifest.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: manifest.appId,
      app_secret: manifest.appSecret,
    });
    expect(auth.status).toBe(200);
    const { tenant_access_token: token } = (await auth.json()) as { tenant_access_token: string };
    const root = `${manifest.baseUrl}/open-apis/im/v1/messages`;
    return {
      ...result,
      admit: (input: Record<string, unknown>) =>
        json(
          manifest.endpoints.adminInboundUrl,
          { text: "DM input", ...input },
          manifest.adminToken,
        ),
      send: (type: "open_id" | "chat_id", id: string, text = "DM response") =>
        json(
          `${root}?receive_id_type=${type}`,
          { receive_id: id, msg_type: "text", content: JSON.stringify({ text }) },
          token,
        ),
      reply: (id: string) =>
        json(
          `${root}/${id}/reply`,
          { msg_type: "text", content: JSON.stringify({ text: "DM reply" }) },
          token,
        ),
    };
  };

  it("does not infer peers from groups, bot self events, chat_id sends or replies", async () => {
    const f = await fixture({ botOpenId: "ou_bot" });
    expect(
      (
        await f.admit({
          messageId: "om_group",
          chatId: "oc_group",
          senderId: "ou_member",
          chatType: "group",
        })
      ).status,
    ).toBe(200);
    expect((await f.reply("om_group")).status).toBe(200);
    const unbound = await f.send("chat_id", "oc_unbound");
    expect(unbound.status).toBe(200);
    const unboundBody = (await unbound.json()) as { data: { message_id: string } };
    expect((await f.reply(unboundBody.data.message_id)).status).toBe(200);
    expect((await f.admit({ chatId: "oc_self", senderId: "ou_bot" })).status).toBe(200);
    for (const peer of ["ou_member", "ou_bot"]) {
      const sent = await f.send("open_id", peer);
      expect(sent.status).toBe(200);
      const body = (await sent.json()) as { data: { chat_id: string } };
      expect(["oc_group", "oc_unbound", "oc_self"]).not.toContain(body.data.chat_id);
    }
    expect((await f.admit({ chatId: "oc_unbound", senderId: "ou_later" })).status).toBe(200);
    const later = await f.send("open_id", "ou_later");
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({ data: { chat_id: "oc_unbound" } });
  });

  it.each(["self-first", "peer-first"] as const)(
    "preserves a p2p peer across bot self events (%s)",
    async (order) => {
      const f = await fixture({ botOpenId: "ou_bot" });
      const peers = order === "self-first" ? ["ou_bot", "ou_peer"] : ["ou_peer", "ou_bot"];
      const statuses: number[] = [];
      for (const senderId of peers) {
        statuses.push((await f.admit({ chatId: "oc_shared", senderId })).status);
      }
      expect(statuses).toEqual([200, 200]);
      const sent = await f.send("open_id", "ou_peer");
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({ data: { chat_id: "oc_shared" } });
    },
  );

  it("keeps self-addressed sends unbound and preserves a subsequently admitted peer", async () => {
    const f = await fixture({ botOpenId: "ou_bot" });
    const first = await f.send("open_id", "ou_bot");
    expect(first.status).toBe(200);
    const { data } = (await first.json()) as { data: { chat_id: string } };
    expect((await f.admit({ chatId: data.chat_id, senderId: "ou_peer" })).status).toBe(200);
    for (const recipient of ["ou_bot", "ou_peer"]) {
      const sent = await f.send("open_id", recipient);
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({ data: { chat_id: data.chat_id } });
    }
    expect((await f.admit({ chatId: "oc_other", senderId: "ou_peer" })).status).toBe(409);
  });

  it("rejects bot self p2p admission and self-addressed sends into a known group", async () => {
    const probe = await fixture({ botOpenId: "ou_bot" });
    const sent = await probe.send("open_id", "ou_bot");
    expect(sent.status).toBe(200);
    const { data } = (await sent.json()) as { data: { chat_id: string } };
    const f = await fixture({ botOpenId: "ou_bot" });
    expect(
      (await f.admit({ chatId: data.chat_id, senderId: "ou_member", chatType: "group" })).status,
    ).toBe(200);
    expect((await f.admit({ chatId: data.chat_id, senderId: "ou_bot" })).status).toBe(409);
    expect((await f.send("open_id", "ou_bot")).status).toBe(409);
    expect(stages(f.events, "inbound.admitted")).toHaveLength(1);
    expect(stages(f.events, "outbound.accepted")).toHaveLength(0);
  });

  it("rejects conflicting peers and chats without overwriting or consuming admission IDs", async () => {
    const f = await fixture();
    expect((await f.admit({ chatId: "oc_left", senderId: "ou_left" })).status).toBe(200);
    expect(
      (await f.admit({ chatId: "oc_group", senderId: "ou_member", chatType: "group" })).status,
    ).toBe(200);
    const ids = { messageId: "om_reused", eventId: "event-reused" };
    for (const input of [
      { chatId: "oc_right", senderId: "ou_left" },
      { chatId: "oc_left", senderId: "ou_right" },
      { chatId: "oc_left", senderId: "ou_member", chatType: "group" },
      { chatId: "oc_group", senderId: "ou_right" },
    ]) {
      expect((await f.admit({ ...ids, ...input })).status).toBe(409);
    }
    expect((await f.admit({ ...ids, chatId: "oc_right", senderId: "ou_right" })).status).toBe(200);
    for (const side of ["left", "right"]) {
      const sent = await f.send("open_id", `ou_${side}`);
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({ data: { chat_id: `oc_${side}` } });
    }
    expect(stages(f.events, "inbound.admitted")).toHaveLength(3);
    const { frames } = await connect(f.server);
    await expect.poll(() => frames.length).toBe(3);
    expect(frames[2]).toMatchObject({ SeqID: "5", LogID: "6" });
  });

  it("preserves outbound-first associations and rejects synthetic chat collisions", async () => {
    const f = await fixture();
    const first = await f.send("open_id", "ou_first");
    expect(first.status).toBe(200);
    const { data } = (await first.json()) as { data: { chat_id: string } };
    const input = { messageId: "om_first", eventId: "event-first", senderId: "ou_first" };
    expect((await f.admit({ ...input, chatId: "oc_other" })).status).toBe(409);
    expect((await f.admit({ ...input, chatId: data.chat_id })).status).toBe(200);
    expect(
      (await f.admit({ chatId: data.chat_id, senderId: "ou_member", chatType: "group" })).status,
    ).toBe(409);
    const collision = await fixture();
    expect(
      (
        await collision.admit({
          chatId: data.chat_id,
          senderId: "ou_member",
          chatType: "group",
        })
      ).status,
    ).toBe(200);
    expect((await collision.send("open_id", "ou_first")).status).toBe(409);
    expect(stages(collision.events, "outbound.accepted")).toHaveLength(0);
  });

  it.each(["admission", "create"] as const)(
    "does not reserve identity on failed %s validation or byte retention",
    async (route) => {
      const f = await fixture({ maxStateBytes: 2048, maxMessages: 2 });
      const input = {
        messageId: "om_reused",
        eventId: "event-reused",
        chatId: "oc_rejected",
        senderId: "ou_peer",
      };
      for (const [text, status] of [
        ["", 400],
        ["x".repeat(4096), 503],
      ] as const) {
        const rejected =
          route === "admission"
            ? await f.admit({ ...input, text })
            : await f.send("open_id", input.senderId, text);
        expect(rejected.status).toBe(status);
      }
      expect((await f.admit({ ...input, chatId: "oc_accepted" })).status).toBe(200);
      const sent = await f.send("open_id", input.senderId);
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({ data: { chat_id: "oc_accepted" } });
      expect((await f.send("open_id", "ou_overflow")).status).toBe(503);
      expect(stages(f.events, "inbound.admitted")).toHaveLength(1);
      expect(stages(f.events, "outbound.accepted")).toHaveLength(1);
    },
  );

  it("does not reserve a peer when pending admission capacity is exhausted", async () => {
    const f = await fixture({ maxPendingEvents: 1 });
    expect((await f.admit({ chatId: "oc_occupied", senderId: "ou_occupied" })).status).toBe(200);
    const input = { messageId: "om_reused", eventId: "event-reused", senderId: "ou_peer" };
    expect((await f.admit({ ...input, chatId: "oc_rejected" })).status).toBe(503);
    await connect(f.server);
    await expect.poll(() => stages(f.events, "websocket.delivery").length).toBe(1);
    expect((await f.admit({ ...input, chatId: "oc_accepted" })).status).toBe(200);
    const sent = await f.send("open_id", input.senderId);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ data: { chat_id: "oc_accepted" } });
    expect(stages(f.events, "inbound.admitted")).toHaveLength(2);
  });

  it("keeps peer associations and message-count limits isolated per server", async () => {
    for (const [index, f] of [
      await fixture({ maxMessages: 2 }),
      await fixture({ maxMessages: 2 }),
    ].entries()) {
      const chatId = `oc_server_${index}`;
      expect(
        (
          await f.admit({
            messageId: "om_same",
            eventId: "event-same",
            chatId,
            senderId: "ou_same",
          })
        ).status,
      ).toBe(200);
      const sent = await f.send("open_id", "ou_same");
      expect(sent.status).toBe(200);
      expect(await sent.json()).toMatchObject({ data: { chat_id: chatId } });
      expect((await f.send("open_id", "ou_overflow")).status).toBe(503);
      expect(stages(f.events, "inbound.admitted")).toHaveLength(1);
      expect(stages(f.events, "outbound.accepted")).toHaveLength(1);
    }
  });
});

describe("Feishu native wire", () => {
  it.each(["cli_same", "cli_0123456789abcdeG", "cli_0123456789abcdef0", "app_0123456789abcdef"])(
    "rejects SDK-incompatible custom app ID %s before startup",
    async (appId) => {
      const directory = await createTempDir();
      const owner: { server?: StartedFeishuServer } = {};
      cleanups.push(async () => {
        try {
          await owner.server?.close();
        } finally {
          await disposeTempDir(directory);
        }
      });
      await expect(
        startFeishuServer({
          appId,
          recorderPath: path.join(directory, "events.jsonl"),
        }).then((server) => {
          owner.server = server;
        }),
      ).rejects.toThrow("appId must be cli_ followed by 16 hexadecimal characters.");
    },
  );

  it("preserves full uint64 IDs and rejects absent required proto2 fields", () => {
    const frame: FeishuFrame = {
      SeqID: "18446744073709551615",
      LogID: "9007199254740993",
      service: 1,
      method: 0,
      headers: [{ key: "type", value: "ping" }],
    };
    expect(decodeFeishuFrame(encodeFeishuFrame(frame))).toEqual(frame);
    expect(() => decodeFeishuFrame(new Uint8Array())).toThrow("missing required 'SeqID'");
    expect(() => encodeFeishuFrame({ ...frame, SeqID: "18446744073709551616" })).toThrow("uint64");
  });

  it.each(["secret", "app ID"])(
    "rejects an invalid discovery %s with a terminal SDK envelope",
    async (credential) => {
      const { server, events } = await start({ appId: "cli_0123456789abcdef" });
      const response = await json(server.manifest.endpoints.discoveryUrl, {
        AppID: credential === "app ID" ? "cli_ffffffffffffffff" : server.manifest.appId,
        AppSecret: credential === "secret" ? "wrong" : server.manifest.appSecret,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        code: 514,
        msg: "Invalid application credentials",
        data: { URL: "", ClientConfig: {} },
      });
      const tenantToken = await json(
        `${server.manifest.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          app_id: credential === "app ID" ? "cli_ffffffffffffffff" : server.manifest.appId,
          app_secret: credential === "secret" ? "wrong" : server.manifest.appSecret,
        },
      );
      expect(tenantToken.status).toBe(401);
      expect(await tenantToken.json()).toEqual({
        code: 401,
        msg: "Invalid application credentials",
      });
      expect(stages(events, "websocket.discovered")).toHaveLength(0);
      expect(stages(events, "websocket.connected")).toHaveLength(0);
      expect(stages(events, "inbound.admitted")).toHaveLength(0);
    },
  );

  it("authenticates upgrades, answers native pings, and bounds sockets", async () => {
    const { server, events } = await start({ maxSockets: 1 });
    const { socket, frames, url } = await connect(server);
    const rejected = new WebSocket(url.replace(/ticket=[^&]+/u, "ticket=wrong"));
    rejected.on("error", () => {});
    const rejection = once(rejected, "unexpected-response");
    const [, response] = await rejection;
    expect(response.statusCode).toBe(401);
    response.resume();
    rejected.terminate();
    socket.send(
      encodeFeishuFrame({
        SeqID: "0",
        LogID: "0",
        service: 1,
        method: 0,
        headers: [{ key: "type", value: "ping" }],
      }),
    );
    await expect.poll(() => frames.length).toBe(1);
    expect(feishuHeader(frames[0]!, "type")).toBe("pong");
    expect(JSON.parse(Buffer.from(frames[0]!.payload!).toString())).toMatchObject({
      PingInterval: 1,
    });
    await expect.poll(() => stages(events, "websocket.pong").length).toBe(1);
    const overflow = new WebSocket(url);
    overflow.on("error", () => {});
    const [, overflowResponse] = await once(overflow, "unexpected-response");
    expect(overflowResponse.statusCode).toBe(401);
    overflowResponse.resume();
    overflow.terminate();
  });

  it("delivers out-of-order UTF-8 fragments and records only the completing-frame ACK", async () => {
    const { server, events } = await start();
    const { socket, frames } = await connect(server);
    const text = "你好🦊，分片必须先拼接字节，再解码。".repeat(7);
    const response = await json(
      server.manifest.endpoints.adminInboundUrl,
      {
        messageId: "om_inbound",
        eventId: "event-inbound",
        chatId: "oc_chat",
        senderId: "ou_sender",
        text,
        fragments: 7,
        fragmentOrder: [6, 2, 4, 1, 5, 3, 0],
      },
      server.manifest.adminToken,
    );
    expect(response.status).toBe(200);
    await expect.poll(() => frames.length).toBe(7);
    const assembled = Buffer.concat(
      [...frames]
        .sort((a, b) => Number(feishuHeader(a, "seq")) - Number(feishuHeader(b, "seq")))
        .map((frame) => Buffer.from(frame.payload!)),
    );
    expect(JSON.parse(JSON.parse(assembled.toString()).event.message.content).text).toBe(text);
    expect(stages(events, "inbound.admitted")).toHaveLength(1);
    expect(stages(events, "sdk.ack")).toHaveLength(0);
    const completing = frames.at(-1)!;
    expect(feishuHeader(completing, "seq")).toBe("0");
    socket.send(
      encodeFeishuFrame({
        ...completing,
        headers: [...completing.headers, { key: "biz_rt", value: "-12" }],
        payload: Buffer.from(JSON.stringify({ code: 200 })),
      }),
    );
    await expect.poll(() => stages(events, "sdk.ack").length).toBe(1);
    expect(stages(events, "sdk.ack")[0]!.body).toMatchObject({
      messageId: "om_inbound",
      code: 200,
      seqId: completing.SeqID,
      logId: completing.LogID,
    });
  });

  it.each([1, 2])(
    "routes clustered fragments to one ACK owner with capacity %i",
    async (maxOutstandingAcks) => {
      const { server, events } = await start({ maxOutstandingAcks });
      const clients = [await connect(server), await connect(server)];
      await expect.poll(() => stages(events, "websocket.connected").length).toBe(2);
      const pongBarrier = async (connections: typeof clients, committedPongs: number) => {
        for (const [index, client] of connections.entries()) {
          client.socket.send(
            encodeFeishuFrame({
              SeqID: String(committedPongs * 10 + index),
              LogID: String(committedPongs * 100 + index),
              service: 1,
              method: 0,
              headers: [{ key: "type", value: "ping" }],
            }),
          );
        }
        await expect
          .poll(() =>
            connections.every((client, index) =>
              client.frames.some(
                (frame) =>
                  feishuHeader(frame, "type") === "pong" &&
                  frame.SeqID === String(committedPongs * 10 + index) &&
                  frame.LogID === String(committedPongs * 100 + index),
              ),
            ),
          )
          .toBe(true);
        // Socket writes and recorder commits must both finish before judging delivery.
        await expect.poll(() => stages(events, "websocket.pong").length).toBe(committedPongs);
      };
      await pongBarrier(clients, 2);
      const input = {
        messageId: "om_cluster_first",
        eventId: "event-cluster-first",
        chatId: "oc_cluster",
        senderId: "ou_cluster",
        text: "集群只投递一次🦊，先拼接字节再解码。".repeat(7),
        fragments: 3,
        fragmentOrder: [2, 0, 1],
      };
      const admin = server.manifest.endpoints.adminInboundUrl;
      const token = server.manifest.adminToken;
      expect((await json(admin, input, token)).status).toBe(200);
      await pongBarrier(clients, 4);
      const perClient = clients.map((client) =>
        client.frames.filter(
          (frame) =>
            feishuHeader(frame, "type") === "event" &&
            feishuHeader(frame, "message_id") === input.eventId,
        ),
      );
      expect(perClient.map((frames) => frames.length).sort((a, b) => a - b)).toEqual([0, 3]);
      expect(stages(events, "websocket.delivery")).toHaveLength(1);
      expect(stages(events, "websocket.delivery")[0]!.body).toMatchObject({
        eventId: input.eventId,
        messageId: input.messageId,
        delivered: true,
        fragments: 3,
      });
      const recipientIndex = perClient.findIndex((frames) => frames.length === 3);
      const recipient = clients[recipientIndex]!;
      const other = clients.find((client) => client !== recipient)!;
      const received = perClient[recipientIndex]!;
      expect(received.map((frame) => feishuHeader(frame, "seq"))).toEqual(["2", "0", "1"]);
      const assembled = Buffer.concat(
        [...received]
          .sort((a, b) => Number(feishuHeader(a, "seq")) - Number(feishuHeader(b, "seq")))
          .map((frame) => Buffer.from(frame.payload!)),
      );
      expect(JSON.parse(assembled.toString("utf8"))).toMatchObject({
        schema: "2.0",
        header: { event_id: input.eventId, app_id: server.manifest.appId },
        event: {
          sender: { sender_id: { open_id: input.senderId } },
          message: {
            message_id: input.messageId,
            chat_id: input.chatId,
            content: JSON.stringify({ text: input.text }),
          },
        },
      });
      const completing = received.at(-1)!;
      const ack = encodeFeishuFrame({
        ...completing,
        payload: Buffer.from(JSON.stringify({ code: 200 })),
      });
      const otherClosed = once(other.socket, "close");
      other.socket.send(ack);
      expect((await otherClosed)[0]).toBe(1002);
      expect(stages(events, "sdk.ack")).toHaveLength(0);
      const nextInput = {
        messageId: "om_cluster_second",
        eventId: "event-cluster-second",
        chatId: input.chatId,
        senderId: input.senderId,
        text: "正确确认后才释放容量🦊。",
      };
      const preAckStatus =
        maxOutstandingAcks === 1 ? (await json(admin, nextInput, token)).status : undefined;
      expect(preAckStatus).toBe(maxOutstandingAcks === 1 ? 503 : undefined);
      recipient.socket.send(ack);
      await expect.poll(() => stages(events, "sdk.ack").length).toBe(1);
      expect(stages(events, "sdk.ack")[0]!.body).toMatchObject({
        eventId: input.eventId,
        messageId: input.messageId,
        code: 200,
        seqId: completing.SeqID,
        logId: completing.LogID,
      });
      expect((await json(admin, nextInput, token)).status).toBe(200);
      await pongBarrier([recipient], 5);
      const nextFrames = recipient.frames.filter(
        (frame) =>
          feishuHeader(frame, "type") === "event" &&
          feishuHeader(frame, "message_id") === nextInput.eventId,
      );
      expect(nextFrames).toHaveLength(1);
      expect(
        other.frames.filter((frame) => feishuHeader(frame, "message_id") === nextInput.eventId),
      ).toHaveLength(0);
      expect(stages(events, "websocket.delivery")).toHaveLength(2);
      expect(stages(events, "websocket.delivery")[1]!.body).toMatchObject({
        eventId: nextInput.eventId,
        messageId: nextInput.messageId,
        delivered: true,
        fragments: 1,
      });
      const nextCompleting = nextFrames.at(-1)!;
      expect(JSON.parse(Buffer.from(nextCompleting.payload!).toString("utf8"))).toMatchObject({
        header: { event_id: nextInput.eventId, app_id: server.manifest.appId },
        event: {
          sender: { sender_id: { open_id: nextInput.senderId } },
          message: {
            message_id: nextInput.messageId,
            chat_id: nextInput.chatId,
            content: JSON.stringify({ text: nextInput.text }),
          },
        },
      });
      recipient.socket.send(
        encodeFeishuFrame({
          ...nextCompleting,
          payload: Buffer.from(JSON.stringify({ code: 200 })),
        }),
      );
      await expect.poll(() => stages(events, "sdk.ack").length).toBe(2);
      expect(stages(events, "sdk.ack")[1]!.body).toMatchObject({
        eventId: nextInput.eventId,
        messageId: nextInput.messageId,
        code: 200,
        seqId: nextCompleting.SeqID,
        logId: nextCompleting.LogID,
      });
    },
  );

  it("enforces admission bounds before mutation and closes malformed native traffic", async () => {
    const { server, events } = await start({
      maxMessages: 1,
      maxOutstandingAcks: 1,
      maxFragments: 2,
    });
    const input = { messageId: "om_one", chatId: "oc_chat", senderId: "ou_sender", text: "边界" };
    const admin = server.manifest.endpoints.adminInboundUrl;
    expect((await json(admin, input, "wrong")).status).toBe(401);
    expect((await json(admin, { ...input, fragments: 3 }, server.manifest.adminToken)).status).toBe(
      400,
    );
    expect((await json(admin, input, server.manifest.adminToken)).status).toBe(200);
    expect((await json(admin, input, server.manifest.adminToken)).status).toBe(409);
    expect(
      (await json(admin, { ...input, messageId: "om_two" }, server.manifest.adminToken)).status,
    ).toBe(503);
    const { socket } = await connect(server);
    const closed = once(socket, "close");
    socket.send(new Uint8Array());
    expect((await closed)[0]).toBe(1002);
    expect(stages(events, "inbound.admitted")).toHaveLength(1);
  });

  it.each([
    ".",
    "..",
    "bad/id",
    "bad\\id",
    "bad?id",
    "bad#id",
    "%2e",
    "%2e%2e",
    "%2f",
    "%41",
    "%",
    "\ud800",
    "\udc00",
  ])("rejects unaddressable message ID %j without consuming admission state", async (messageId) => {
    const { server, events } = await start({
      maxMessages: 1,
      maxPendingEvents: 1,
      maxOutstandingAcks: 1,
    });
    const input = {
      eventId: "event/reused?#%",
      chatId: "chat/body?#%",
      senderId: "sender/body?#%",
      text: "地址",
    };
    const admin = server.manifest.endpoints.adminInboundUrl;
    const token = server.manifest.adminToken;
    const invalid = await json(admin, { ...input, messageId }, token);
    const validId = "custom.valid.消息🦊";
    const valid = await json(admin, { ...input, messageId: validId }, token);
    expect([invalid.status, valid.status]).toEqual([400, 200]);
    expect(stages(events, "inbound.admitted")).toHaveLength(1);
    const { frames } = await connect(server);
    await expect.poll(() => frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ SeqID: "1", LogID: "2" });
    expect(JSON.parse(Buffer.from(frames[0]!.payload!).toString("utf8"))).toMatchObject({
      header: { event_id: input.eventId },
      event: {
        sender: { sender_id: { open_id: input.senderId } },
        message: { message_id: validId, chat_id: input.chatId },
      },
    });
    await expect.poll(() => stages(events, "websocket.delivery").length).toBe(1);
    expect(stages(events, "websocket.delivery")[0]!.body).toMatchObject({ messageId: validId });
  });

  it.each(["%", "%FF"])(
    "rejects malformed message path %s before retained state mutation",
    async (encodedId) => {
      const { server, events } = await start({ maxMessages: 2, maxPendingEvents: 1 });
      const { manifest } = server;
      const tokenResponse = await json(
        `${manifest.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        { app_id: manifest.appId, app_secret: manifest.appSecret },
      );
      expect(tokenResponse.status).toBe(200);
      const { tenant_access_token: token } = (await tokenResponse.json()) as {
        tenant_access_token: string;
      };
      const root = `${manifest.baseUrl}/open-apis/im/v1/messages`;
      const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
      const replyBody = JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text: "valid reply" }),
      });
      const statuses: number[][] = [];
      const invalidBodies: unknown[] = [];
      for (const [method, suffix] of [
        ["GET", ""],
        ["POST", "/reply"],
      ] as const) {
        const request = {
          url: `${root}/${encodedId}${suffix}`,
          method,
          headers,
          ...(method === "POST" ? { body: replyBody } : {}),
        };
        const unauthorized = await requestHttp({
          ...request,
          headers: { "content-type": "application/json" },
        });
        const invalid = await requestHttp(request);
        const missing = await requestHttp({ ...request, url: `${root}/missing${suffix}` });
        statuses.push([unauthorized.status, invalid.status, missing.status]);
        invalidBodies.push(JSON.parse(invalid.body));
      }
      expect(statuses).toEqual([
        [401, 400, 404],
        [401, 400, 404],
      ]);
      expect(invalidBodies).toEqual([
        { code: 400, msg: "Invalid message ID encoding" },
        { code: 400, msg: "Invalid message ID encoding" },
      ]);
      expect(stages(events, "inbound.admitted")).toHaveLength(0);
      expect(stages(events, "outbound.accepted")).toHaveLength(0);
      const messageId = "custom.valid.消息🦊";
      const admitted = await json(
        manifest.endpoints.adminInboundUrl,
        { messageId, chatId: "oc_chat", senderId: "ou_sender", text: "valid message" },
        manifest.adminToken,
      );
      expect(admitted.status).toBe(200);
      const url = `${root}/${encodeURIComponent(messageId)}`;
      const lookup = await requestHttp({ url, method: "GET", headers });
      expect(lookup.status).toBe(200);
      expect(JSON.parse(lookup.body)).toMatchObject({
        code: 0,
        data: { items: [{ message_id: messageId }] },
      });
      const reply = await requestHttp({
        url: `${url}/reply`,
        method: "POST",
        headers,
        body: replyBody,
      });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toMatchObject({
        code: 0,
        data: { parent_id: messageId, root_id: messageId },
      });
      expect(stages(events, "inbound.admitted")).toHaveLength(1);
      expect(stages(events, "outbound.accepted")).toHaveLength(1);
    },
  );

  it("keeps credentials, same native IDs, receipts and replies isolated across servers", async () => {
    const first = await start({ appId: "cli_0123456789abcdef", appSecret: "secret-first" });
    const second = await start({ appId: "cli_0123456789abcdef", appSecret: "secret-second" });
    const input = {
      messageId: "om_same",
      eventId: "event-same",
      chatId: "oc_same",
      senderId: "ou_same",
      text: "隔离",
    };
    for (const fixture of [first, second]) {
      expect(
        (
          await json(
            fixture.server.manifest.endpoints.adminInboundUrl,
            input,
            fixture.server.manifest.adminToken,
          )
        ).status,
      ).toBe(200);
    }
    const tokenResponse = await json(
      `${first.server.manifest.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: "cli_0123456789abcdef", app_secret: "secret-first" },
    );
    const { tenant_access_token: token } = (await tokenResponse.json()) as {
      tenant_access_token: string;
    };
    expect(
      (
        await json(
          `${second.server.manifest.baseUrl}/open-apis/bot/v3/info`,
          undefined,
          token,
          "GET",
        )
      ).status,
    ).toBe(401);
    const reply = await json(
      `${first.server.manifest.baseUrl}/open-apis/im/v1/messages/om_same/reply`,
      {
        msg_type: "post",
        content: JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "回复一" }]] } }),
      },
      token,
    );
    expect(((await reply.json()) as { data: unknown }).data).toMatchObject({
      chat_id: "oc_same",
      parent_id: "om_same",
      msg_type: "post",
    });
    expect(stages(first.events, "outbound.accepted")).toHaveLength(1);
    expect(stages(second.events, "outbound.accepted")).toHaveLength(0);
    expect(JSON.stringify(first.events)).not.toContain("secret-first");
    expect(JSON.stringify(first.events)).not.toContain(token);
  });

  it("records written fragments only after the native send callback completes", async () => {
    const { server, events } = await start();
    await connect(server);
    const original = WebSocket.prototype.send;
    let releaseWrite: (() => void) | undefined;
    vi.spyOn(WebSocket.prototype, "send").mockImplementationOnce(
      function (this: WebSocket, data, options, callback) {
        original.call(this, data, options, (error) => {
          releaseWrite = () => callback?.(error);
        });
      },
    );
    const response = json(
      server.manifest.endpoints.adminInboundUrl,
      { chatId: "oc_write", senderId: "ou_write", text: "写入" },
      server.manifest.adminToken,
    );
    await expect.poll(() => Boolean(releaseWrite)).toBe(true);
    await expect.poll(() => stages(events, "inbound.admitted").length).toBe(1);
    expect(stages(events, "websocket.delivery")).toHaveLength(0);
    releaseWrite!();
    expect((await response).status).toBe(200);
    // Admission can finish while the connection-triggered flush owns delivery.
    await expect.poll(() => stages(events, "websocket.delivery").length).toBe(1);
    expect(stages(events, "websocket.delivery")[0]!.body).toMatchObject({ delivered: true });
    expect(stages(events, "sdk.ack")).toHaveLength(0);
  });

  it.each(["after delivery", "before final callback"] as const)(
    "keeps the ACK window separate from fragment writes (%s)",
    async (ackOrder) => {
      const observed = new EventEmitter();
      const { server, events } = await start({
        ackTimeoutMs: 100,
        maxOutstandingAcks: 1,
        onEvent: (event) => {
          observed.emit((event.body as { stage: string }).stage);
        },
      });
      const { socket, frames } = await connect(server);
      await expect.poll(() => stages(events, "websocket.connected").length).toBe(1);
      const original = WebSocket.prototype.send;
      const send = vi.spyOn(WebSocket.prototype, "send");
      const writes = Array.from(
        { length: 2 },
        () =>
          new Promise<() => void>((resolve) => {
            send.mockImplementationOnce(function (this: WebSocket, data, options, callback) {
              original.call(this, data, options, (error) => {
                resolve(() => callback?.(error));
              });
            });
          }),
      );
      const admin = server.manifest.endpoints.adminInboundUrl;
      const token = server.manifest.adminToken;
      const input = { chatId: "oc_deadline", senderId: "ou_deadline", text: "分片" };
      // Fetch can defer reused-socket dispatch through the clock held by this test.
      const post = (body: unknown) =>
        requestHttp({
          url: admin,
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const firstFrame = once(socket, "message");
        const delivered = once(observed, "websocket.delivery");
        const response = post({ ...input, fragments: 2 });
        await Promise.all([
          response.then(({ status }) => {
            expect(status).toBe(200);
          }),
          (async () => {
            const releaseFirst = await writes[0]!;
            await firstFrame;
            const lastFrame = once(socket, "message");
            await vi.advanceTimersByTimeAsync(60);
            releaseFirst();
            const releaseLast = await writes[1]!;
            await lastFrame;
            if (ackOrder === "after delivery") {
              // Each write consumes 60% of its own deadline; total delivery exceeds one window.
              await vi.advanceTimersByTimeAsync(60);
              releaseLast();
              await delivered;
            }
            const ack = once(observed, "sdk.ack").then(() => "ack");
            const closed = once(socket, "close").then(([code]) => `close:${String(code)}`);
            socket.send(
              encodeFeishuFrame({
                ...frames.at(-1)!,
                payload: Buffer.from(JSON.stringify({ code: 200 })),
              }),
            );
            expect(await Promise.race([ack, closed])).toBe("ack");
            if (ackOrder === "before final callback") {
              releaseLast();
              await delivered;
            }
          })(),
        ]);
        // An early ACK must not acquire a new timer when the final write callback arrives.
        await vi.advanceTimersByTimeAsync(101);
        const nextDelivered = once(observed, "websocket.delivery");
        expect((await post(input)).status).toBe(200);
        await nextDelivered;
        expect((await post(input)).status).toBe(503);
        expect(stages(events, "sdk.ack")).toHaveLength(1);
        expect(stages(events, "sdk.ack.expired")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["callback", "throw", "close", "deadline"] as const)(
    "records a failed write on %s without claiming an SDK ACK",
    async (failure) => {
      const observed = new EventEmitter();
      const { server, events } = await start({
        ackTimeoutMs: 100,
        maxOutstandingAcks: 1,
        onEvent: (event) => {
          observed.emit((event.body as { stage: string }).stage);
        },
      });
      await connect(server);
      vi.spyOn(WebSocket.prototype, "send").mockImplementationOnce(
        function (this: WebSocket, _data, _options, callback) {
          if (failure === "callback") {
            callback?.(new Error("Fixture write failure"));
          } else if (failure === "throw") {
            throw new Error("Fixture send failure");
          } else if (failure === "close") {
            this.terminate();
          }
        },
      );
      expect(
        (
          await json(
            server.manifest.endpoints.adminInboundUrl,
            { chatId: "oc_failure", senderId: "ou_failure", text: "失败" },
            server.manifest.adminToken,
          )
        ).status,
      ).toBe(200);
      await expect.poll(() => stages(events, "websocket.delivery").length).toBe(1);
      expect(stages(events, "websocket.delivery")[0]!.body).toMatchObject({ delivered: false });
      expect(stages(events, "sdk.ack")).toHaveLength(0);
      await connect(server);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const nextDelivered = once(observed, "websocket.delivery");
        const input = { chatId: "oc_capacity", senderId: "ou_capacity", text: "恢复" };
        const recover = () =>
          requestHttp({
            url: server.manifest.endpoints.adminInboundUrl,
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${server.manifest.adminToken}`,
            },
            body: JSON.stringify(input),
          });
        expect((await recover()).status).toBe(200);
        await nextDelivered;
        expect(stages(events, "websocket.delivery")[1]!.body).toMatchObject({ delivered: true });
        expect((await recover()).status).toBe(503);
        expect(stages(events, "sdk.ack")).toHaveLength(0);
        expect(stages(events, "sdk.ack.expired")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
        await server.close();
      }
    },
  );

  it("expires outstanding ACKs without reporting successful acknowledgement", async () => {
    const { server, events } = await start({ maxOutstandingAcks: 1, ackTimeoutMs: 50 });
    await connect(server);
    const input = { chatId: "oc_expiry", senderId: "ou_expiry", text: "超时" };
    expect(
      (await json(server.manifest.endpoints.adminInboundUrl, input, server.manifest.adminToken))
        .status,
    ).toBe(200);
    await expect.poll(() => stages(events, "sdk.ack.expired").length).toBe(1);
    expect(stages(events, "sdk.ack")).toHaveLength(0);
    expect(
      (await json(server.manifest.endpoints.adminInboundUrl, input, server.manifest.adminToken))
        .status,
    ).toBe(200);
    await server.close();
    expect(stages(events, "sdk.ack")).toHaveLength(0);
  });

  it("rejects malformed native upgrade targets without terminating the server", async () => {
    const { server, events } = await start();
    const url = new URL(server.manifest.baseUrl);
    const raw = connectTcp({ host: url.hostname, port: Number(url.port) });
    raw.on("error", () => {});
    const closed = once(raw, "close");
    cleanups.push(async () => {
      raw.destroy();
      await closed;
    });
    await once(raw, "connect");
    let received = "";
    raw.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    let timedOut = false;
    raw.setTimeout(1_000, () => {
      timedOut = true;
      raw.destroy();
    });
    raw.write(
      `GET //[ HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    await closed;
    expect(timedOut).toBe(false);
    expect(received).toBe(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    const { socket, frames } = await connect(server);
    socket.send(
      encodeFeishuFrame({
        SeqID: "0",
        LogID: "0",
        service: 1,
        method: 0,
        headers: [{ key: "type", value: "ping" }],
      }),
    );
    await expect.poll(() => frames.length).toBe(1);
    expect(feishuHeader(frames[0]!, "type")).toBe("pong");
    await expect.poll(() => stages(events, "websocket.pong").length).toBe(1);
  });

  it("closes a held native socket and outstanding ACK without waiting for the peer", async () => {
    const { server, events } = await start();
    const discovery = await json(server.manifest.endpoints.discoveryUrl, {
      AppID: server.manifest.appId,
      AppSecret: server.manifest.appSecret,
    });
    const url = new URL(((await discovery.json()) as DiscoveryResponse).data.URL);
    const socket = connectTcp({ host: url.hostname, port: Number(url.port) });
    socket.on("error", () => {});
    const closed = once(socket, "close");
    cleanups.push(async () => {
      socket.destroy();
      await closed;
    });
    await once(socket, "connect");
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    await expect.poll(() => received.includes("101 Switching Protocols")).toBe(true);
    expect(
      (
        await json(
          server.manifest.endpoints.adminInboundUrl,
          { chatId: "oc_hold", senderId: "ou_hold", text: "持有" },
          server.manifest.adminToken,
        )
      ).status,
    ).toBe(200);
    await Promise.all([server.close(), server.close()]);
    await closed;
    expect(stages(events, "websocket.delivery")).toHaveLength(1);
    expect(stages(events, "sdk.ack")).toHaveLength(0);
    expect(stages(events, "sdk.ack.expired")).toHaveLength(0);
  });

  it("allows a recorder observer to close its own server", async () => {
    const directory = await createTempDir();
    let server: StartedFeishuServer | undefined;
    server = await startFeishuServer({
      recorderPath: path.join(directory, "events.jsonl"),
      onEvent: async (event) => {
        if ((event.body as { stage?: string }).stage === "inbound.admitted") {
          await server!.close();
        }
      },
    });
    cleanups.push(async () => {
      await server!.close();
      await disposeTempDir(directory);
    });
    await json(
      server.manifest.endpoints.adminInboundUrl,
      { chatId: "oc_close", senderId: "ou_close", text: "关闭" },
      server.manifest.adminToken,
    ).catch(() => undefined);
    await server.close();
    await expect(
      fetch(server.manifest.baseUrl, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow("fetch failed");
  });
});
