import { once } from "node:events";
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
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type DiscoveryResponse = { code: number; data: { URL: string } };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
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

describe("Feishu native wire", () => {
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

  it("authenticates discovery and upgrade separately, answers native pings, and bounds sockets", async () => {
    const { server, events } = await start({ maxSockets: 1 });
    expect(
      (
        await json(server.manifest.endpoints.discoveryUrl, {
          AppID: server.manifest.appId,
          AppSecret: "wrong",
        })
      ).status,
    ).toBe(401);
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

  it("keeps credentials, same native IDs, receipts and replies isolated across servers", async () => {
    const first = await start({ appId: "cli_same", appSecret: "secret-first" });
    const second = await start({ appId: "cli_same", appSecret: "secret-second" });
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
      { app_id: "cli_same", app_secret: "secret-first" },
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
    expect(stages(events, "inbound.admitted")).toHaveLength(1);
    expect(stages(events, "websocket.delivery")).toHaveLength(0);
    releaseWrite!();
    expect((await response).status).toBe(200);
    // Admission can finish while the connection-triggered flush owns delivery.
    await expect.poll(() => stages(events, "websocket.delivery").length).toBe(1);
    expect(stages(events, "websocket.delivery")[0]!.body).toMatchObject({ delivered: true });
    expect(stages(events, "sdk.ack")).toHaveLength(0);
  });

  it.each(["callback", "throw", "close", "deadline"] as const)(
    "records a failed write on %s without claiming an SDK ACK",
    async (failure) => {
      const { server, events } = await start({ ackTimeoutMs: 100 });
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
      await server.close();
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
