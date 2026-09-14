import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import path from "node:path";
import { expect, it } from "vitest";
import { startFeishuServer, type ServerRequestEvent } from "../src/index.js";
import { FEISHU_TEST_CERTIFICATE, FEISHU_TEST_KEY } from "./fixtures/feishu-tls.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

it.for(["admission-first", "send-first"] as const)(
  "preserves native DM chat identity through official SDK routes (%s)",
  async (order, { onTestFinished, signal }) => {
    const directory = await createTempDir();
    const events: ServerRequestEvent[] = [];
    const server = await startFeishuServer({
      recorderPath: path.join(directory, "events.jsonl"),
      onEvent: (event) => {
        events.push(event);
      },
    });
    const child = fork(path.resolve("test/fixtures/feishu-sdk-client.ts"), [], {
      execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exit = once(child, "exit");
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
      });
    }
    onTestFinished(async () => {
      if (child.connected) {
        child.send({ type: "stop" });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        const [code, exitSignal] = await exit;
        expect({ code, exitSignal, output }).toMatchObject({ code: 0, exitSignal: null });
      } finally {
        clearTimeout(timer);
        await server.close();
        await disposeTempDir(directory);
      }
    });
    const admit = (chatId: string) =>
      requestHttp({
        method: "POST",
        url: server.manifest.endpoints.adminInboundUrl,
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": server.manifest.adminToken,
        },
        body: JSON.stringify({
          messageId: "om_dm_inbound",
          eventId: "event-dm-inbound",
          chatId,
          senderId: "ou_dm_peer",
          text: "SDK DM input",
        }),
      });
    let chatId = "oc_existing_dm";
    let admitted: Awaited<ReturnType<typeof admit>> | undefined;
    if (order === "admission-first") {
      admitted = await admit(chatId);
    }
    expect(admitted?.status).toBe(order === "admission-first" ? 200 : undefined);
    const outcome = once(child, "message", { signal });
    child.send({ type: "start", ...server.manifest, chatIdentity: order });
    let [result] = await outcome;
    const firstSend = {
      type: "first-dm",
      first: { code: 0, data: { chat_id: expect.any(String) } },
    };
    expect({ result, output }).toMatchObject({
      result: order === "send-first" ? firstSend : { type: "chat-identity" },
    });
    if (order === "send-first") {
      chatId = result.first.data.chat_id;
      admitted = await admit(chatId);
    }
    expect(admitted?.status).toBe(200);
    if (order === "send-first") {
      const completed = once(child, "message", { signal });
      child.send({ type: "release" });
      [result] = await completed;
    }
    expect({ result, output }).toMatchObject({ result: { type: "chat-identity" } });
    for (const response of [result.direct, result.explicit, result.reply]) {
      expect(response).toMatchObject({ code: 0, data: { chat_id: chatId } });
    }
    expect(result.direct.data.parent_id).toBeUndefined();
    expect(result.explicit.data.parent_id).toBeUndefined();
    expect(result.reply.data.parent_id).toBe("om_dm_inbound");
    expect(
      events.filter((event) => (event.body as { stage?: string }).stage === "outbound.accepted"),
    ).toHaveLength(order === "send-first" ? 4 : 3);
  },
);

it.for(["secret", "app ID"])(
  "reports an invalid discovery %s as terminal through the reconnect-enabled SDK",
  async (credential, { onTestFinished, signal }) => {
    const directory = await createTempDir();
    const events: ServerRequestEvent[] = [];
    const server = await startFeishuServer({
      appId: "cli_0123456789abcdef",
      recorderPath: path.join(directory, "events.jsonl"),
      onEvent: (event) => {
        events.push(event);
      },
    });
    const child = fork(path.resolve("test/fixtures/feishu-sdk-client.ts"), [], {
      execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exit = once(child, "exit");
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
      });
    }
    onTestFinished(async () => {
      if (child.connected) {
        child.send({ type: "stop" });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        const [code, exitSignal] = await exit;
        expect({ code, exitSignal, output }).toMatchObject({ code: 0, exitSignal: null });
      } finally {
        clearTimeout(timer);
        await server.close();
        await disposeTempDir(directory);
      }
    });
    const outcome = once(child, "message", { signal });
    child.send({
      type: "start",
      ...server.manifest,
      appId: credential === "app ID" ? "cli_ffffffffffffffff" : server.manifest.appId,
      appSecret: credential === "secret" ? "wrong" : server.manifest.appSecret,
      rejectCredentials: true,
    });
    const [result] = await outcome;
    expect({ result, output }).toMatchObject({
      result: {
        type: "auth-error",
        message: "pullConnectConfig failed: code=514, msg=Invalid application credentials",
        status: { state: "failed", reconnectAttempts: 0 },
        discoveryRequests: 1,
      },
    });
    expect(result.status).not.toHaveProperty("nextConnectTime");
    expect(
      events.filter((event) => (event.body as { stage?: string }).stage === "websocket.discovered"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => (event.body as { stage?: string }).stage === "websocket.connected"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => (event.body as { stage?: string }).stage === "inbound.admitted"),
    ).toHaveLength(0);
  },
);

it("uses a custom app ID with the official SDK for TLS auth, REST, fragmented events and dispatcher-barrier ACKs", async ({
  onTestFinished,
  signal,
}) => {
  const directory = await createTempDir();
  const caPath = path.join(directory, "ca.pem");
  await writeFile(caPath, FEISHU_TEST_CERTIFICATE);
  const events: ServerRequestEvent[] = [];
  const server = await startFeishuServer({
    appId: "cli_0123456789aBcDeF",
    tls: { key: FEISHU_TEST_KEY, cert: FEISHU_TEST_CERTIFICATE },
    recorderPath: path.join(directory, "events.jsonl"),
    onEvent: (event) => {
      events.push(event);
    },
  });
  const agent = new Agent({ ca: FEISHU_TEST_CERTIFICATE });
  const child = fork(path.resolve("test/fixtures/feishu-sdk-client.ts"), [], {
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: directory,
      NODE_EXTRA_CA_CERTS: caPath,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exit = once(child, "exit");
  const messages: Array<{
    type: string;
    event?: unknown;
    message?: string;
    lookup?: unknown;
    reply?: unknown;
  }> = [];
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
    });
  }
  child.on("message", (message) => messages.push(message as (typeof messages)[number]));
  const stop = async () => {
    if (child.connected) {
      child.send({ type: "stop" });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      const [code, exitSignal] = await exit;
      expect({ code, exitSignal }).toEqual({ code: 0, exitSignal: null });
    } finally {
      clearTimeout(timer);
      agent.destroy();
      await server.close();
      await disposeTempDir(directory);
    }
  };
  onTestFinished(stop);
  const deadline = Date.now() + 20_000;
  const wait = async (predicate: () => boolean) => {
    while (!predicate()) {
      signal.throwIfAborted();
      const failure = messages.find((message) => message.type === "failure");
      if (failure || child.exitCode !== null || Date.now() >= deadline) {
        throw new Error(failure?.message ?? `SDK fixture did not progress: ${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const stage = (name: string) =>
    events.filter((event) => (event.body as { stage?: string }).stage === name);
  child.send({ type: "start", ...server.manifest });
  await wait(() => stage("websocket.connected").length === 1);
  expect(stage("outbound.accepted")).toHaveLength(6);
  expect(stage("tenant.token.issued")).toHaveLength(1);
  const inboundMessages = [
    ["custom-id", "中文跨片🦊".repeat(21)],
    ["custom.dotted.id", "SDK dotted ID"],
    ["消息🦊", "SDK_THROW"],
  ] as const;
  for (const [index, [messageId, text]] of inboundMessages.entries()) {
    const result = await requestHttp({
      requestImpl: request,
      agent,
      method: "POST",
      url: server.manifest.endpoints.adminInboundUrl,
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
      body: JSON.stringify({
        messageId,
        eventId: `event-sdk-${index}`,
        chatId: "oc_sdk",
        senderId: "ou_sdk",
        text,
        fragments: 7,
        fragmentOrder: [4, 2, 1, 5, 3, 0, 6],
      }),
    });
    expect(result.status).toBe(200);
    await wait(() => messages.filter((message) => message.type === "event").length === index + 1);
    expect(messages.filter((message) => message.type === "event")[index]).toMatchObject({
      lookup: { code: 0, data: { items: [{ message_id: messageId }] } },
      reply: { code: 0, data: { parent_id: messageId, root_id: messageId } },
    });
    expect(stage("sdk.ack")).toHaveLength(index);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stage("sdk.ack")).toHaveLength(index);
    child.send({ type: "release" });
    await wait(() => stage("sdk.ack").length === index + 1);
    expect(stage("sdk.ack")[index]!.body).toMatchObject({
      messageId,
      code: text === "SDK_THROW" ? 500 : 200,
    });
    expect(stage("sdk.ack")[index]!.body).toHaveProperty(
      "headers",
      expect.arrayContaining([{ key: "seq", value: "6" }]),
    );
  }
  expect(stage("sdk.ack")[0]!.body).toHaveProperty(
    "data",
    Buffer.from(JSON.stringify({ handled: true })).toString("base64"),
  );
  expect(stage("outbound.accepted")).toHaveLength(9);
  await wait(() => stage("websocket.pong").length > 0);
  expect(messages.filter((message) => message.type === "event")[0]!.event).toMatchObject({
    message: { content: JSON.stringify({ text: "中文跨片🦊".repeat(21) }) },
  });
}, 30_000);
