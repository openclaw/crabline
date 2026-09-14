import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  adminAuthError,
  constantTimeTokenEqual,
  createServerClose,
  drainRequestBody,
  hasAdminToken,
  InvalidJsonBodyError,
  isJsonObject,
  jsonResponse,
  parseUnknownRequestBody,
  RequestBodyTooLargeError,
  startHttpJsonServer,
} from "./http.js";
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuHeader,
  type FeishuFrame,
} from "./feishu-wire.js";
import { createServerRecorder, type ServerEventObserver } from "./recorder.js";
import { closeWebSocketServer } from "./websocket.js";

export type FeishuServerManifest = {
  provider: "feishu";
  version: 1;
  appId: string;
  appSecret: string;
  adminToken: string;
  botOpenId: string;
  baseUrl: string;
  recorderPath: string;
  endpoints: { apiRoot: string; adminInboundUrl: string; discoveryUrl: string };
};

export type StartedFeishuServer = { manifest: FeishuServerManifest; close(): Promise<void> };

export type StartFeishuServerParams = {
  appId?: string | undefined;
  appSecret?: string | undefined;
  adminToken?: string | undefined;
  botOpenId?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  tls?: { key: string | Buffer; cert: string | Buffer } | undefined;
  recorderPath?: string | undefined;
  onEvent?: ServerEventObserver | undefined;
  maxMessages?: number | undefined;
  maxStateBytes?: number | undefined;
  maxPendingEvents?: number | undefined;
  maxEventBytes?: number | undefined;
  maxFragments?: number | undefined;
  maxSockets?: number | undefined;
  maxOutstandingAcks?: number | undefined;
  ackTimeoutMs?: number | undefined;
};

type NativeMessage = {
  message_id: string;
  chat_id: string;
  msg_type: string;
  body: { content: string };
  sender: { id: string; id_type: "open_id"; sender_type: "user" | "app"; tenant_key: string };
  create_time: string;
  update_time: string;
  deleted: false;
  root_id?: string;
  parent_id?: string;
};
type Delivery = { eventId: string; messageId: string; frames: FeishuFrame[] };
type PendingAck = { delivery: Delivery; completing: FeishuFrame; timer?: NodeJS.Timeout };

const messageRoute = /^\/open-apis\/im\/v1\/messages\/([^/]+)(\/reply)?$/u;

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function identifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 256) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function messageIdentifier(value: unknown): value is string {
  if (!identifier(value)) {
    return false;
  }
  // The SDK substitutes IDs without encoding; both REST routes must preserve the exact identity.
  try {
    return ["", "/reply"].every((suffix) => {
      const url = new URL(`http://localhost/open-apis/im/v1/messages/${value}${suffix}`);
      const match = messageRoute.exec(url.pathname);
      return (
        !url.search &&
        !url.hash &&
        match !== null &&
        (match[2] ?? "") === suffix &&
        decodeURIComponent(match[1]!) === value
      );
    });
  } catch {
    return false;
  }
}

function failure(msg: string, status = 400): Response {
  return jsonResponse({ code: status, msg }, status);
}

function contentValid(type: unknown, value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  let content: unknown;
  try {
    content = JSON.parse(value);
  } catch {
    return false;
  }
  if (!isJsonObject(content)) {
    return false;
  }
  if (type === "text") {
    return typeof content.text === "string" && content.text.length > 0;
  }
  if (type === "post") {
    const locales = Object.values(content);
    return (
      locales.length > 0 &&
      locales.every((post) => isJsonObject(post) && Array.isArray(post.content))
    );
  }
  // This subset accepts static cards, not CardKit entity references.
  return type === "interactive" && Array.isArray(content.elements);
}

export async function startFeishuServer(
  params: StartFeishuServerParams = {},
): Promise<StartedFeishuServer> {
  const appId = params.appId ?? `cli_${randomBytes(8).toString("hex")}`;
  const appSecret = params.appSecret ?? randomBytes(24).toString("base64url");
  const adminToken = params.adminToken ?? randomBytes(24).toString("base64url");
  const botOpenId = params.botOpenId ?? `ou_${randomBytes(16).toString("hex")}`;
  for (const [name, value] of Object.entries({ appId, appSecret, adminToken, botOpenId })) {
    if (!identifier(value)) {
      throw new Error(`${name} must be a nonempty identifier of at most 256 bytes.`);
    }
  }
  // The SDK refuses to connect when a custom app ID does not match this format.
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error("appId must be cli_ followed by 16 hexadecimal characters.");
  }
  const maxMessages = positive(params.maxMessages, 1_000, "maxMessages");
  const maxStateBytes = positive(params.maxStateBytes, 16 * 1024 * 1024, "maxStateBytes");
  const maxPendingEvents = positive(params.maxPendingEvents, 100, "maxPendingEvents");
  const maxEventBytes = positive(params.maxEventBytes, 256 * 1024, "maxEventBytes");
  const maxFragments = positive(params.maxFragments, 64, "maxFragments");
  const maxSockets = positive(params.maxSockets, 8, "maxSockets");
  const maxOutstandingAcks = positive(params.maxOutstandingAcks, 100, "maxOutstandingAcks");
  const ackTimeoutMs = positive(params.ackTimeoutMs, 30_000, "ackTimeoutMs");
  if (ackTimeoutMs > 2_147_483_647) {
    throw new Error("ackTimeoutMs exceeds the timer limit.");
  }
  const recorderPath = params.recorderPath ?? path.resolve(".crabline", "servers", "feishu.jsonl");
  const recorder = createServerRecorder({ recorderPath, onEvent: params.onEvent });
  const tenantToken = randomBytes(24).toString("base64url");
  const ticket = randomBytes(24).toString("base64url");
  const deviceId = randomUUID();
  const clientConfig = {
    PingInterval: 1,
    ReconnectCount: 0,
    ReconnectInterval: 1,
    ReconnectNonce: 0,
  };
  const messages = new Map<string, NativeMessage>();
  // Only admitted p2p senders or explicit recipients establish peer identity.
  // Null marks known groups; self events and bot-authored messages cannot invent a peer.
  const chatPeers = new Map<string, string | null>();
  const eventIds = new Set<string>();
  const pending: Delivery[] = [];
  const sockets = new Map<WebSocket, Map<string, PendingAck>>();
  const writes = new Set<Promise<boolean>>();
  let stateBytes = 0;
  let outstanding = 0;
  let closed = false;
  let baseUrl = "";
  let sequence = 1n;
  let flushing = false;

  const record = (stage: string, body: Record<string, unknown>, route: string, method = "POST") =>
    recorder.recordCommitted({
      at: new Date().toISOString(),
      body: { stage, ...body },
      method,
      path: route,
      query: {},
      type: route.startsWith("/crabline/") ? "admin" : "api",
    });
  const clearAck = (acks: Map<string, PendingAck>, eventId: string) => {
    const ack = acks.get(eventId);
    if (ack) {
      clearTimeout(ack.timer);
      acks.delete(eventId);
      outstanding -= 1;
    }
  };
  const send = async (socket: WebSocket, frame: FeishuFrame): Promise<boolean> => {
    const bytes = encodeFeishuFrame(frame);
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount + bytes.length > maxEventBytes * 2
    ) {
      socket.close(1013, "client too slow");
      return false;
    }
    // ws.send's return only means queued. Its callback observes write completion,
    // which remains distinct from the SDK's acknowledgement.
    const written = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off("close", onClose);
        resolve(success);
      };
      const onClose = () => finish(false);
      const timer = setTimeout(() => {
        socket.terminate();
        finish(false);
      }, ackTimeoutMs);
      timer.unref();
      socket.once("close", onClose);
      try {
        socket.send(bytes, { binary: true }, (error) => {
          if (error) {
            socket.terminate();
          }
          finish(!error);
        });
      } catch {
        socket.terminate();
        finish(false);
      }
    });
    writes.add(written);
    void written.then(() => writes.delete(written));
    return written;
  };
  const flush = async () => {
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      while (pending.length > 0) {
        if (closed) {
          return;
        }
        const targets = [...sockets.entries()].filter(
          ([socket]) => socket.readyState === WebSocket.OPEN,
        );
        if (targets.length === 0 || outstanding >= maxOutstandingAcks) {
          return;
        }
        // Feishu delivers each clustered event to one client; all fragments and
        // the completing-frame ACK reservation belong to that socket.
        const [socket, acks] = targets[randomInt(targets.length)]!;
        const delivery = pending.shift()!;
        const completing = delivery.frames.at(-1)!;
        const reservation: PendingAck = { delivery, completing };
        acks.set(delivery.eventId, reservation);
        outstanding += 1;
        let delivered = true;
        for (const frame of delivery.frames) {
          if (!(await send(socket, frame))) {
            delivered = false;
            break;
          }
        }
        if (!delivered) {
          clearAck(acks, delivery.eventId);
        } else if (acks.get(delivery.eventId) === reservation) {
          // An ACK can arrive before the final write callback. Do not revive
          // a reservation already released by an ACK or a closed connection.
          reservation.timer = setTimeout(() => {
            clearAck(acks, delivery.eventId);
            void record(
              "sdk.ack.expired",
              { messageId: delivery.messageId, eventId: delivery.eventId },
              "/callback/ws",
            );
            void flush();
          }, ackTimeoutMs);
          reservation.timer.unref();
        }
        await record(
          "websocket.delivery",
          {
            messageId: delivery.messageId,
            eventId: delivery.eventId,
            delivered,
            fragments: delivery.frames.length,
          },
          "/callback/ws",
        );
      }
    } finally {
      flushing = false;
    }
  };
  const chatForPeer = (peer: string) =>
    [...chatPeers].find(([, knownPeer]) => knownPeer === peer)?.[0];
  const chatConflict = (chatId: string, peer: string | null | undefined) => {
    const knownPeer = chatPeers.get(chatId);
    const knownChat = typeof peer === "string" ? chatForPeer(peer) : undefined;
    return (
      (knownPeer !== undefined &&
        (peer === null
          ? knownPeer !== null
          : knownPeer === null || (peer !== undefined && knownPeer !== peer))) ||
      (knownChat !== undefined && knownChat !== chatId)
    );
  };
  const retain = (message: NativeMessage, extraBytes = 0, peer?: string | null): boolean => {
    const newChat = peer !== undefined && !chatPeers.has(message.chat_id);
    const bytes =
      Buffer.byteLength(JSON.stringify(message)) +
      extraBytes +
      (newChat ? Buffer.byteLength(JSON.stringify([message.chat_id, peer])) : 0);
    if (messages.size >= maxMessages || stateBytes + bytes > maxStateBytes) {
      return false;
    }
    messages.set(message.message_id, message);
    // Each association requires a retained message and shares its byte/count bounds.
    // Commit before telemetry so reentrant sends observe the established identity.
    if (newChat) {
      chatPeers.set(message.chat_id, peer);
    }
    stateBytes += bytes;
    return true;
  };
  const nativeMessage = (
    id: string,
    chatId: string,
    type: string,
    content: string,
    senderId: string,
    senderType: "user" | "app",
  ): NativeMessage => ({
    message_id: id,
    chat_id: chatId,
    msg_type: type,
    body: { content },
    sender: { id: senderId, id_type: "open_id", sender_type: senderType, tenant_key: appId },
    create_time: String(Date.now()),
    update_time: String(Date.now()),
    deleted: false,
  });

  const admit = async (body: Record<string, unknown>): Promise<Response> => {
    const messageId = body.messageId ?? `om_${randomBytes(16).toString("hex")}`;
    const eventId = body.eventId ?? randomUUID();
    if (
      !messageIdentifier(messageId) ||
      !identifier(eventId) ||
      !identifier(body.chatId) ||
      !identifier(body.senderId) ||
      typeof body.text !== "string" ||
      body.text.length === 0 ||
      (body.chatType !== undefined && body.chatType !== "p2p" && body.chatType !== "group")
    ) {
      return failure("messageId, eventId, chatId, senderId and nonempty text must be valid");
    }
    if (messages.has(messageId) || eventIds.has(eventId)) {
      return failure("messageId or eventId already admitted", 409);
    }
    const fragments = body.fragments ?? 1;
    if (
      !Number.isSafeInteger(fragments) ||
      typeof fragments !== "number" ||
      fragments < 1 ||
      fragments > maxFragments
    ) {
      return failure("fragments exceeds the configured bound");
    }
    const order = body.fragmentOrder ?? Array.from({ length: fragments }, (_, index) => index);
    if (
      !Array.isArray(order) ||
      order.length !== fragments ||
      new Set(order).size !== fragments ||
      order.some((index) => !Number.isInteger(index) || index < 0 || index >= fragments)
    ) {
      return failure("fragmentOrder must be a permutation of fragment indexes");
    }
    const content = JSON.stringify({ text: body.text });
    const native = nativeMessage(messageId, body.chatId, "text", content, body.senderId, "user");
    const bytes = Buffer.from(
      JSON.stringify({
        schema: "2.0",
        header: {
          event_id: eventId,
          event_type: "im.message.receive_v1",
          create_time: String(Date.now()),
          app_id: appId,
          tenant_key: appId,
        },
        event: {
          sender: {
            sender_id: { open_id: body.senderId, user_id: body.senderId, union_id: body.senderId },
            sender_type: "user",
            tenant_key: appId,
          },
          message: {
            message_id: messageId,
            create_time: native.create_time,
            chat_id: body.chatId,
            chat_type: body.chatType ?? "p2p",
            message_type: "text",
            content,
          },
        },
      }),
    );
    if (bytes.length > maxEventBytes || fragments > bytes.length) {
      return failure("event exceeds the configured byte bound", 413);
    }
    if (pending.length >= maxPendingEvents || outstanding >= maxOutstandingAcks) {
      return failure("pending event or acknowledgement limit reached", 503);
    }
    const peer =
      body.chatType === "group" ? null : body.senderId === botOpenId ? undefined : body.senderId;
    if (chatConflict(body.chatId, peer)) {
      return failure("Chat identity conflicts with retained state", 409);
    }
    const frames = order.map((index: number): FeishuFrame => ({
      SeqID: String(sequence++),
      LogID: String(sequence++),
      service: 1,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: eventId },
        { key: "sum", value: String(fragments) },
        { key: "seq", value: String(index) },
        { key: "trace_id", value: eventId },
      ],
      payloadEncoding: "json",
      payloadType: "application/json",
      payload: bytes.subarray(
        Math.floor((index * bytes.length) / fragments),
        Math.floor(((index + 1) * bytes.length) / fragments),
      ),
    }));
    if (!retain(native, bytes.length + Buffer.byteLength(eventId), peer)) {
      return failure("retained message state limit reached", 503);
    }
    eventIds.add(eventId);
    pending.push({ eventId, messageId, frames });
    // Admission is committed independently of socket delivery and the client's ACK.
    await record(
      "inbound.admitted",
      { messageId, eventId, chatId: body.chatId },
      "/crabline/feishu/inbound",
    );
    await flush();
    return jsonResponse({ ok: true, messageId, eventId });
  };

  const handle = async (request: IncomingMessage): Promise<Response> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    if (closed) {
      return failure("server closing", 503);
    }
    const admin = url.pathname === "/crabline/feishu/inbound";
    const token = url.pathname === "/open-apis/auth/v3/tenant_access_token/internal";
    const discovery = url.pathname === "/callback/ws/endpoint";
    if (admin && !hasAdminToken(request, adminToken)) {
      drainRequestBody(request);
      return adminAuthError();
    }
    if (!admin && !token && !discovery) {
      const provided = /^Bearer (\S+)$/iu.exec(request.headers.authorization ?? "")?.[1];
      if (!provided || !constantTimeTokenEqual(provided, tenantToken)) {
        drainRequestBody(request);
        return jsonResponse({ code: 99991663, msg: "Invalid access token" }, 401);
      }
    }
    const body = method === "POST" ? await parseUnknownRequestBody(request, maxEventBytes) : {};
    if (closed) {
      return failure("server closing", 503);
    }
    if (!isJsonObject(body)) {
      return failure("JSON object required");
    }
    if (admin && method === "POST") {
      return admit(body);
    }
    if ((token || discovery) && method === "POST") {
      const id = token ? body.app_id : body.AppID;
      const secret = token ? body.app_secret : body.AppSecret;
      if (
        id !== appId ||
        typeof secret !== "string" ||
        !constantTimeTokenEqual(secret, appSecret)
      ) {
        // The SDK destructures data before classifying discovery code 514 as terminal.
        // HTTP errors instead enter its reconnect path.
        return discovery
          ? jsonResponse({
              code: 514,
              msg: "Invalid application credentials",
              data: { URL: "", ClientConfig: {} },
            })
          : failure("Invalid application credentials", 401);
      }
      await record(token ? "tenant.token.issued" : "websocket.discovered", { appId }, url.pathname);
      return token
        ? jsonResponse({ code: 0, msg: "ok", tenant_access_token: tenantToken, expire: 7200 })
        : jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              URL: `${baseUrl.replace(/^http/u, "ws")}/callback/ws?device_id=${deviceId}&service_id=1&ticket=${ticket}`,
              ClientConfig: clientConfig,
            },
          });
    }
    if (url.pathname === "/open-apis/bot/v3/info" && method === "GET") {
      return jsonResponse({
        code: 0,
        msg: "ok",
        bot: { app_name: "Crabline", open_id: botOpenId },
      });
    }
    const match = messageRoute.exec(url.pathname);
    let messageId: string | undefined;
    try {
      messageId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    } catch {
      return failure("Invalid message ID encoding");
    }
    const prior = messageId ? messages.get(messageId) : undefined;
    if (match && !match[2] && method === "GET") {
      return prior
        ? jsonResponse({ code: 0, msg: "ok", data: { items: [prior] } })
        : failure("Message not found", 404);
    }
    const create = url.pathname === "/open-apis/im/v1/messages";
    if (method === "POST" && (create || match?.[2])) {
      if (!create && !prior) {
        return failure("Message not found", 404);
      }
      if (!contentValid(body.msg_type, body.content)) {
        return failure("Only text, localized post and static interactive content are supported");
      }
      const receiveType = url.searchParams.get("receive_id_type");
      if (
        create &&
        (!identifier(body.receive_id) || (receiveType !== "chat_id" && receiveType !== "open_id"))
      ) {
        return failure("receive_id and supported receive_id_type are required");
      }
      const target = create ? String(body.receive_id) : prior!.chat_id;
      const peer = create && receiveType === "open_id" && target !== botOpenId ? target : undefined;
      const chatId =
        create && receiveType === "open_id"
          ? (chatForPeer(target) ??
            `oc_${createHash("sha256").update(target).digest("hex").slice(0, 32)}`)
          : target;
      if (create && receiveType === "open_id" && chatConflict(chatId, peer)) {
        return failure("Chat identity conflicts with retained state", 409);
      }
      const message = nativeMessage(
        `om_${randomBytes(16).toString("hex")}`,
        chatId,
        String(body.msg_type),
        body.content,
        botOpenId,
        "app",
      );
      if (prior) {
        message.root_id = prior.root_id ?? prior.message_id;
        message.parent_id = prior.message_id;
      }
      if (!retain(message, 0, peer)) {
        return failure("retained message state limit reached", 503);
      }
      await record(
        "outbound.accepted",
        { message, receiveId: target, receiveIdType: receiveType },
        url.pathname,
      );
      return jsonResponse({ code: 0, msg: "ok", data: message });
    }
    return failure("Unsupported Feishu route", 404);
  };

  const http = await startHttpJsonServer({
    host: params.host ?? "127.0.0.1",
    port: params.port ?? 0,
    tls: params.tls,
    serverName: "Feishu",
    handle,
    handleError: (error) =>
      error instanceof InvalidJsonBodyError
        ? failure("Invalid JSON")
        : error instanceof RequestBodyTooLargeError
          ? failure("Request too large", 413)
          : undefined,
  });
  baseUrl = http.baseUrl;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: maxEventBytes });
  const rawSockets = new Set<import("node:stream").Duplex>();
  const upgrade = (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    let url: URL;
    try {
      url = new URL(request.url ?? "/", baseUrl);
    } catch {
      const timeout = setTimeout(() => socket.destroy(), 250);
      timeout.unref();
      socket.once("close", () => clearTimeout(timeout));
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () =>
        socket.destroy(),
      );
      return;
    }
    if (
      closed ||
      url.pathname !== "/callback/ws" ||
      url.searchParams.get("device_id") !== deviceId ||
      url.searchParams.get("service_id") !== "1" ||
      !constantTimeTokenEqual(url.searchParams.get("ticket") ?? "", ticket) ||
      sockets.size >= maxSockets
    ) {
      const timeout = setTimeout(() => socket.destroy(), 250);
      timeout.unref();
      socket.once("close", () => clearTimeout(timeout));
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        () => socket.destroy(),
      );
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => {
      rawSockets.delete(socket);
      websocket.emit("connection", client);
    });
  };
  http.server.on("upgrade", upgrade);
  websocket.on("connection", (socket: WebSocket) => {
    const acks = new Map<string, PendingAck>();
    sockets.set(socket, acks);
    socket.on("error", () => socket.terminate());
    socket.once("close", () => {
      for (const id of acks.keys()) {
        clearAck(acks, id);
      }
      sockets.delete(socket);
      void flush();
    });
    socket.on("message", (raw: RawData, binary: boolean) => {
      const receive = async () => {
        if (!binary) {
          throw new Error("binary frames required");
        }
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const frame = decodeFeishuFrame(bytes);
        if (frame.service !== 1) {
          throw new Error("invalid service");
        }
        if (frame.method === 0 && feishuHeader(frame, "type") === "ping") {
          if (
            await send(socket, {
              ...frame,
              headers: [{ key: "type", value: "pong" }],
              payload: Buffer.from(JSON.stringify(clientConfig)),
            })
          ) {
            await record("websocket.pong", {}, "/callback/ws");
          }
          return;
        }
        const eventId = feishuHeader(frame, "message_id");
        const ack = eventId ? acks.get(eventId) : undefined;
        if (
          frame.method !== 1 ||
          !eventId ||
          !ack ||
          frame.SeqID !== ack.completing.SeqID ||
          frame.LogID !== ack.completing.LogID ||
          !ack.completing.headers.every(
            (header) => feishuHeader(frame, header.key) === header.value,
          )
        ) {
          throw new Error("unmatched acknowledgement");
        }
        const payload: unknown = JSON.parse(Buffer.from(frame.payload ?? []).toString("utf8"));
        if (
          !isJsonObject(payload) ||
          (payload.code !== 200 && payload.code !== 500) ||
          (payload.data !== undefined &&
            (typeof payload.data !== "string" ||
              Buffer.from(payload.data, "base64").toString("base64") !== payload.data))
        ) {
          throw new Error("invalid acknowledgement payload");
        }
        clearAck(acks, eventId);
        await record(
          "sdk.ack",
          {
            eventId,
            messageId: ack.delivery.messageId,
            code: payload.code,
            seqId: frame.SeqID,
            logId: frame.LogID,
            headers: frame.headers,
            ...(payload.data === undefined ? {} : { data: payload.data }),
          },
          "/callback/ws",
        );
        await flush();
      };
      void receive().catch(() => socket.close(1002, "invalid Feishu frame"));
    });
    void record("websocket.connected", { appId }, "/callback/ws", "GET")
      .then(flush)
      .catch(() => socket.terminate());
  });
  return {
    manifest: {
      provider: "feishu",
      version: 1,
      appId,
      appSecret,
      adminToken,
      botOpenId,
      baseUrl,
      recorderPath,
      endpoints: {
        apiRoot: `${baseUrl}/open-apis`,
        adminInboundUrl: `${baseUrl}/crabline/feishu/inbound`,
        discoveryUrl: `${baseUrl}/callback/ws/endpoint`,
      },
    },
    close: createServerClose(recorder, async () => {
      closed = true;
      http.server.off("upgrade", upgrade);
      // HTTP close does not own upgraded sockets that never reached ws.clients.
      for (const socket of rawSockets) {
        socket.destroy();
      }
      pending.length = 0;
      for (const acks of sockets.values()) {
        for (const id of acks.keys()) {
          clearAck(acks, id);
        }
      }
      await closeWebSocketServer(websocket);
      // Join native writes only. A flush may be awaiting an observer that called close.
      await Promise.all(writes);
      await http.close();
    }),
  };
}
