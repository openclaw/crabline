import { Agent, createServer, ServerResponse, type ClientRequest } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startZaloServer, type StartedZaloServer } from "../src/index.js";
import { postZaloWebhook } from "../src/servers/zalo.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

const servers: StartedZaloServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

function adminHeaders(server: StartedZaloServer) {
  return {
    "content-type": "application/json",
    "x-crabline-admin-token": server.manifest.adminToken,
  };
}

describe("Zalo local provider server", () => {
  it("serves the Bot API over GET and POST and delivers admin inbound", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "zalo.jsonl");
    const server = await startZaloServer({ botToken: "test-token-placeholder", recorderPath });
    servers.push(server);

    const getMe = await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/getMe`, {
      method: "POST",
    });
    await expect(getMe.json()).resolves.toMatchObject({
      ok: true,
      result: {
        account_name: "bot.crabline",
        account_type: "BASIC",
        can_join_groups: true,
        id: "1459232241454765289",
      },
    });

    const invalidJson = await fetch(
      `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`,
      {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      description: "Bad Request: can't parse JSON object",
      error_code: 400,
      ok: false,
    });

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalidBody = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`,
        {
          body: scalarBody,
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(invalidBody.status).toBe(400);
      await expect(invalidBody.json()).resolves.toEqual({
        description: "Bad Request: can't parse JSON object",
        error_code: 400,
        ok: false,
      });
    }

    const oversized = await requestHttp({
      headers: {
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({
      description: "Request Entity Too Large",
      error_code: 413,
      ok: false,
    });

    const invalidAdminBody = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: "[]",
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(invalidAdminBody.status).toBe(400);
    await expect(invalidAdminBody.json()).resolves.toEqual({
      description: "Bad Request: can't parse JSON object",
      error_code: 400,
      ok: false,
    });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        chatId: "group-1",
        chatType: "GROUP",
        senderId: "user-1",
        senderName: "Alice",
        text: "user nonce-1",
      }),
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(inbound.ok).toBe(true);

    const updates = await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/getUpdates`, {
      body: JSON.stringify({ timeout: "0" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(updates.json()).resolves.toMatchObject({
      ok: true,
      result: {
        event_name: "message.text.received",
        message: {
          chat: { chat_type: "GROUP", id: "group-1" },
          from: { display_name: "Alice", id: "user-1", is_bot: false },
          text: "user nonce-1",
        },
      },
    });

    const timeout = await fetch(
      `${server.manifest.baseUrl}/bottest-token-placeholder/getUpdates?timeout=0`,
    );
    expect(timeout.status).toBe(408);
    await expect(timeout.json()).resolves.toMatchObject({ error_code: 408, ok: false });

    const sendMessage = await fetch(
      `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage?chat_id=group-1&text=hello`,
    );
    await expect(sendMessage.json()).resolves.toMatchObject({
      ok: true,
      result: { message_id: expect.any(String) },
    });

    const recorder = await fs.readFile(recorderPath, "utf8");
    expect(recorder).toContain('"path":"/bot<redacted>/sendMessage"');
    expect(recorder).not.toContain("test-token-placeholder");
  });

  it("delivers native webhook envelopes with the configured secret header", async () => {
    const received: Array<{ body: unknown; secret?: string }> = [];
    const webhook = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const secret = request.headers["x-bot-api-secret-token"];
      received.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        ...(typeof secret === "string" ? { secret } : {}),
      });
      response.statusCode = 200;
      response.end("ok");
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }

    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "zalo-webhook.jsonl");
    const server = await startZaloServer({ botToken: "test-token-placeholder", recorderPath });
    servers.push(server);
    try {
      const webhookUrl = new URL(
        ["http://", "alice", ":", "sample", `@127.0.0.1:${address.port}/zalo`].join(""),
      );
      for (const [key, value] of [
        ["mode", "test"],
        [["access", "Token"].join(""), "alpha"],
        ["password", "bravo"],
        [["api", "Key"].join(""), "charlie"],
        [["client", "Secret"].join(""), "delta"],
        ["auth", "echo"],
        [["callback", "Id"].join(""), "keep"],
      ] as Array<[string, string]>) {
        webhookUrl.searchParams.set(key, value);
      }
      const setWebhook = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({
            metadata: {
              authorization: "placeholder",
              callbacks: [
                {
                  callbackUrl:
                    "http://fixture-user:placeholder@example.com/hook?api_key=placeholder",
                },
              ],
            },
            secret_token: "test-auth-token",
            url: webhookUrl.href,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(setWebhook.ok).toBe(true);

      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "hello" }),
        headers: adminHeaders(server),
        method: "POST",
      });
      expect(inbound.ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        body: {
          event_name: "message.text.received",
          message: { text: "hello" },
        },
        secret: "test-auth-token",
      });

      const blockedPolling = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/getUpdates?timeout=0`,
        { method: "POST" },
      );
      expect(blockedPolling.status).toBe(400);
      const accessTokenParam = ["access", "Token"].join("");
      const malformedCredentialUrl = [
        "http://",
        "user",
        ":",
        "credential-placeholder",
        "@",
        `127.0.0.1:bad/zalo?${accessTokenParam}=foxtrot&mode=invalid`,
      ].join("");
      const invalidWebhook = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({
            url: malformedCredentialUrl,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(invalidWebhook.status).toBe(400);
      const protocolRelativeCredential = [
        " \t//protocol-user:",
        "protocol-relative-credential-placeholder",
        "@example.com/hook",
      ].join("");
      const invalidProtocolRelativeWebhook = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({
            url: protocolRelativeCredential,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(invalidProtocolRelativeWebhook.status).toBe(400);

      const recorder = await fs.readFile(recorderPath, "utf8");
      expect(recorder).toContain('"secret_token":"<redacted>"');
      expect(recorder).toContain(
        `http://<redacted>@127.0.0.1:${address.port}/zalo?mode=test&accessToken=<redacted>&password=<redacted>&apiKey=<redacted>&clientSecret=<redacted>&auth=<redacted>&callbackId=keep`,
      );
      expect(recorder).toContain(
        "http://<redacted>@127.0.0.1:bad/zalo?accessToken=<redacted>&mode=invalid",
      );
      expect(recorder).toContain("<redacted>@example.com/hook");
      expect(recorder).not.toContain("test-auth-token");
      expect(recorder).not.toContain("alice");
      expect(recorder).not.toContain("sample");
      expect(recorder).not.toContain("credential-placeholder");
      expect(recorder).not.toContain("protocol-user");
      expect(recorder).not.toContain("fixture-user");
      expect(recorder).toContain(
        '"callbackUrl":"http://<redacted>@example.com/hook?api_key=<redacted>"',
      );
      for (const secret of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
        expect(recorder).not.toContain(secret);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("bounds inbound admission before parsing request bodies", async () => {
    let observeFirst!: () => void;
    let releaseFirst!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const server = await startZaloServer({
      adminToken: "admin",
      maxPendingInboundEvents: 1,
      async onEvent(event) {
        if (event.path === "/crabline/zalo/inbound") {
          observeFirst();
          await firstReleased;
        }
      },
    });
    servers.push(server);

    const first = fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "first" }),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    await firstObserved;

    const overloaded = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: "{",
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": "admin",
      },
      method: "POST",
    });
    expect(overloaded.status).toBe(429);
    await expect(overloaded.json()).resolves.toMatchObject({
      description: "Pending inbound queue is full (1 updates)",
    });

    releaseFirst();
    expect((await first).status).toBe(200);
  });

  it("rejects oversized or header-unsafe webhook secrets", async () => {
    const server = await startZaloServer({ botToken: "test-token-placeholder" });
    servers.push(server);

    for (const secretToken of ["a".repeat(257), "safe\r\nunsafe"]) {
      const response = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({
            secret_token: secretToken,
            url: "https://93.184.216.34/zalo",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(response.status).toBe(400);
    }
  });

  it("records producer-owned acceptance for Zalo sends", async () => {
    const observed: Array<{ accepted?: boolean; path?: string }> = [];
    const server = await startZaloServer({
      botToken: "test-token-placeholder",
      onEvent(event) {
        observed.push(event);
      },
    });
    servers.push(server);

    const accepted = await fetch(
      `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`,
      {
        body: JSON.stringify({ chat_id: "chat-1", text: "accepted" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const rejected = await fetch(
      `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`,
      {
        body: JSON.stringify({ chat_id: "chat-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(observed).toEqual([
      expect.objectContaining({ accepted: true, path: "/bot<redacted>/sendMessage" }),
      expect.objectContaining({ accepted: false, path: "/bot<redacted>/sendMessage" }),
    ]);
  });

  it("preserves committed sends but surfaces rejected-send evidence failures", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    let failAcceptedEvent = true;
    const server = await startZaloServer({
      botToken: "test-token-placeholder",
      onEvent(event) {
        if (event.path !== "/bot<redacted>/sendMessage") {
          return;
        }
        const accepted = (event as { accepted?: boolean }).accepted;
        if (accepted && failAcceptedEvent) {
          failAcceptedEvent = false;
          throw new Error("accepted Zalo evidence failed");
        }
        if (accepted === false) {
          throw new Error("rejected Zalo evidence failed");
        }
      },
      recorderPath: path.join(directory, "zalo-send-evidence.jsonl"),
    });
    servers.push(server);

    const first = await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`, {
      body: JSON.stringify({ chat_id: "chat-1", text: "committed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { result: { message_id: string } };

    const second = await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`, {
      body: JSON.stringify({ chat_id: "chat-1", text: "next" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const secondBody = (await second.json()) as { result: { message_id: string } };
    expect(secondBody.result.message_id).not.toBe(firstBody.result.message_id);

    const rejected = await fetch(
      `${server.manifest.baseUrl}/bottest-token-placeholder/sendMessage`,
      {
        body: JSON.stringify({ chat_id: "chat-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(rejected.status).toBe(500);
    await expect(rejected.json()).resolves.toEqual({
      error: "internal server error",
      ok: false,
    });
  });

  it("keeps queued updates when webhook delivery is enabled", async () => {
    const webhook = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ok");
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }
    const server = await startZaloServer({ botToken: "sample" });
    servers.push(server);
    try {
      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "queued" }),
        headers: adminHeaders(server),
        method: "POST",
      });
      expect(inbound.status).toBe(200);

      const configured = await fetch(`${server.manifest.baseUrl}/botsample/setWebhook`, {
        body: JSON.stringify({
          secret_token: "secret-token",
          url: `http://127.0.0.1:${address.port}/zalo`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(configured.status).toBe(200);
      expect(
        (
          await fetch(`${server.manifest.baseUrl}/botsample/deleteWebhook`, {
            method: "POST",
          })
        ).status,
      ).toBe(200);

      const updates = await fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`, {
        method: "POST",
      });
      await expect(updates.json()).resolves.toMatchObject({
        ok: true,
        result: { message: { text: "queued" } },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not dequeue queued updates for disconnected long polls", async () => {
    let observePoll: (() => void) | undefined;
    let releasePoll: (() => void) | undefined;
    const pollObserved = new Promise<void>((resolve) => {
      observePoll = resolve;
    });
    const pollBlocked = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const server = await startZaloServer({
      botToken: "sample",
      onEvent: async (event) => {
        if (event.path === "/bot<redacted>/getUpdates") {
          observePoll?.();
          await pollBlocked;
        }
      },
    });
    servers.push(server);
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "queued first" }),
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(inbound.status).toBe(200);

    const controller = new AbortController();
    const pending = fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=30`, {
      signal: controller.signal,
    });
    await pollObserved;
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/u);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releasePoll?.();

    const updates = await fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`, {
      method: "POST",
    });
    await expect(updates.json()).resolves.toMatchObject({
      ok: true,
      result: { message: { text: "queued first" } },
    });
  });

  it("restores reverse-order poll failures ahead of a waiting poll", async () => {
    const server = await startZaloServer({ botToken: "sample" });
    servers.push(server);
    for (const text of ["first", "second"]) {
      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text }),
        headers: adminHeaders(server),
        method: "POST",
      });
      expect(inbound.status).toBe(200);
    }

    const responsePrototype = ServerResponse.prototype as unknown as {
      end: (...args: unknown[]) => ServerResponse;
    };
    const originalEnd = responsePrototype.end;
    let failedResponses = 0;
    let reportLaterFailure!: () => void;
    const laterFailureReported = new Promise<void>((resolve) => {
      reportLaterFailure = resolve;
    });
    responsePrototype.end = function (this: ServerResponse, ...args: unknown[]) {
      if (this.req?.url?.includes("/getUpdates") && failedResponses < 2) {
        const responseIndex = failedResponses++;
        const delayMs = responseIndex === 0 ? 100 : 10;
        setTimeout(() => {
          if (responseIndex === 1) {
            reportLaterFailure();
          }
          this.destroy(new Error("simulated response failure"));
        }, delayMs);
        return this;
      }
      return Reflect.apply(originalEnd, this, args) as ServerResponse;
    };

    try {
      const failedPolls = Promise.allSettled([
        requestHttp({
          method: "GET",
          url: `${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`,
        }),
        requestHttp({
          method: "GET",
          url: `${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`,
        }),
      ]);
      const waitingPoll = requestHttp({
        method: "GET",
        url: `${server.manifest.baseUrl}/botsample/getUpdates?timeout=1`,
      });
      await laterFailureReported;
      const thirdInbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "third" }),
        headers: adminHeaders(server),
        method: "POST",
      });
      expect(thirdInbound.status).toBe(200);
      const waitingResponse = await waitingPoll;
      expect(JSON.parse(waitingResponse.body)).toMatchObject({
        ok: true,
        result: { message: { text: "first" } },
      });
      await failedPolls;
    } finally {
      responsePrototype.end = originalEnd;
    }

    for (const text of ["second", "third"]) {
      const update = await fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`);
      await expect(update.json()).resolves.toMatchObject({
        ok: true,
        result: { message: { text } },
      });
    }
  });

  it("rejects webhook activation while a poll delivery is reserved", async () => {
    const webhook = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ok");
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }
    const server = await startZaloServer({ botToken: "sample" });
    servers.push(server);
    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "reserved" }),
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(inbound.status).toBe(200);

    const responsePrototype = ServerResponse.prototype as unknown as {
      end: (...args: unknown[]) => ServerResponse;
    };
    const originalEnd = responsePrototype.end;
    let releaseResponse!: () => void;
    let reportResponse!: () => void;
    const responseReported = new Promise<void>((resolve) => {
      reportResponse = resolve;
    });
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    responsePrototype.end = function (this: ServerResponse, ...args: unknown[]) {
      if (this.req?.url?.includes("/getUpdates")) {
        reportResponse();
        void responseReleased.then(() => this.destroy(new Error("simulated response failure")));
        return this;
      }
      return Reflect.apply(originalEnd, this, args) as ServerResponse;
    };

    const poll = requestHttp({
      method: "GET",
      url: `${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`,
    });
    try {
      await responseReported;
      const blocked = await fetch(`${server.manifest.baseUrl}/botsample/setWebhook`, {
        body: JSON.stringify({
          secret_token: "secret-token",
          url: `http://127.0.0.1:${address.port}/zalo`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(blocked.status).toBe(409);
      await expect(blocked.json()).resolves.toMatchObject({
        description: "Polling deliveries are still in progress",
      });
      releaseResponse();
      await Promise.allSettled([poll]);
    } finally {
      releaseResponse();
      responsePrototype.end = originalEnd;
    }

    try {
      const configured = await fetch(`${server.manifest.baseUrl}/botsample/setWebhook`, {
        body: JSON.stringify({
          secret_token: "secret-token",
          url: `http://127.0.0.1:${address.port}/zalo`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(configured.status).toBe(200);
      await fetch(`${server.manifest.baseUrl}/botsample/deleteWebhook`, { method: "POST" });
      const restored = await fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=0`);
      await expect(restored.json()).resolves.toMatchObject({
        result: { message: { text: "reserved" } },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("supersedes concurrent long polls and delivers to the current request", async () => {
    let observeFirstPoll: (() => void) | undefined;
    const firstPollReady = new Promise<void>((resolve) => {
      observeFirstPoll = resolve;
    });
    let polls = 0;
    const server = await startZaloServer({
      botToken: "sample",
      onEvent: (event) => {
        if (event.path === "/bot<redacted>/getUpdates" && ++polls === 1) {
          setImmediate(() => observeFirstPoll?.());
        }
      },
    });
    servers.push(server);

    const first = fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=30`);
    await firstPollReady;
    const second = fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=30`);

    const firstResponse = await first;
    expect(firstResponse.status).toBe(409);
    await expect(firstResponse.json()).resolves.toMatchObject({
      description: "Conflict: terminated by other getUpdates request",
      error_code: 409,
      ok: false,
    });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "current poll" }),
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    await expect((await second).json()).resolves.toMatchObject({
      ok: true,
      result: { message: { text: "current poll" } },
    });
  });

  it("does not let a disconnected replacement terminate the active poll", async () => {
    let observeFirstPoll: (() => void) | undefined;
    let observeSecondPoll: (() => void) | undefined;
    let releaseSecondPoll: (() => void) | undefined;
    const firstPollReady = new Promise<void>((resolve) => {
      observeFirstPoll = resolve;
    });
    const secondPollObserved = new Promise<void>((resolve) => {
      observeSecondPoll = resolve;
    });
    const secondPollBlocked = new Promise<void>((resolve) => {
      releaseSecondPoll = resolve;
    });
    let polls = 0;
    const server = await startZaloServer({
      botToken: "sample",
      onEvent: async (event) => {
        if (event.path !== "/bot<redacted>/getUpdates") {
          return;
        }
        polls++;
        if (polls === 1) {
          observeFirstPoll?.();
        } else if (polls === 2) {
          observeSecondPoll?.();
          await secondPollBlocked;
        }
      },
    });
    servers.push(server);

    const first = fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=30`);
    await firstPollReady;
    const controller = new AbortController();
    const second = fetch(`${server.manifest.baseUrl}/botsample/getUpdates?timeout=30`, {
      signal: controller.signal,
    });
    await secondPollObserved;
    controller.abort();
    await expect(second).rejects.toThrow(/aborted/u);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseSecondPoll?.();

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "active poll" }),
      headers: adminHeaders(server),
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    await expect((await first).json()).resolves.toMatchObject({
      ok: true,
      result: { message: { text: "active poll" } },
    });
  });

  it("enforces an absolute webhook delivery deadline while responses trickle", async () => {
    const webhook = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      const interval = setInterval(() => response.write("."), 5);
      response.once("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }

    const directory = await createTempDir();
    directories.push(directory);
    const server = await startZaloServer({
      botToken: "test-token-placeholder",
      recorderPath: path.join(directory, "zalo-webhook-timeout.jsonl"),
      webhookDeliveryTimeoutMs: 25,
    });
    servers.push(server);
    try {
      const setWebhook = await fetch(
        `${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`,
        {
          body: JSON.stringify({
            secret_token: "test-auth-token",
            url: `http://127.0.0.1:${address.port}/zalo`,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(setWebhook.ok).toBe(true);

      const startedAt = Date.now();
      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "hello" }),
        headers: adminHeaders(server),
        method: "POST",
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(inbound.status).toBe(502);
      await expect(inbound.json()).resolves.toMatchObject({
        description: "Webhook delivery timed out after 25ms",
        error_code: 502,
        ok: false,
      });
    } finally {
      webhook.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("tries each validated webhook address until one connects", async () => {
    const received: string[] = [];
    const webhook = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      received.push(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = 200;
      response.end();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }
    try {
      await expect(
        postZaloWebhook({
          addresses: [
            { address: "127.0.0.2", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ],
          body: '{"ok":true}',
          timeoutMs: 1_000,
          url: new URL(`http://webhook.test:${address.port}/zalo`),
          verificationValue: "secret",
        }),
      ).resolves.toBe(200);
      expect(received).toEqual(['{"ok":true}']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not try another webhook address after cancellation", async () => {
    let requests = 0;
    let observeRequest!: () => void;
    const requestObserved = new Promise<void>((resolve) => {
      observeRequest = resolve;
    });
    const webhook = createServer(() => {
      requests += 1;
      observeRequest();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }
    const activeRequests = new Set<ClientRequest>();
    let cancelled = false;
    try {
      const delivery = postZaloWebhook({
        activeRequests,
        addresses: [
          { address: "127.0.0.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        body: '{"ok":true}',
        shouldCancel: () => cancelled,
        timeoutMs: 1_000,
        url: new URL(`http://webhook.test:${address.port}/zalo`),
        verificationValue: "secret",
      });
      await requestObserved;
      cancelled = true;
      for (const request of activeRequests) {
        request.destroy(new Error("test cancellation"));
      }
      await expect(delivery).rejects.toThrow("test cancellation");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(requests).toBe(1);
    } finally {
      webhook.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("closes active webhook requests during server shutdown", async () => {
    let observeRequest!: () => void;
    const requestObserved = new Promise<void>((resolve) => {
      observeRequest = resolve;
    });
    const webhook = createServer((_request, _response) => {
      observeRequest();
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook test server address.");
    }
    const server = await startZaloServer({ botToken: "test-token-placeholder" });
    servers.push(server);
    try {
      await fetch(`${server.manifest.baseUrl}/bottest-token-placeholder/setWebhook`, {
        body: JSON.stringify({
          secret_token: "test-auth-token",
          url: `http://127.0.0.1:${address.port}/zalo`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const inbound = fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "hello" }),
        headers: adminHeaders(server),
        method: "POST",
      });
      await requestObserved;
      await server.close();
      servers.splice(servers.indexOf(server), 1);
      expect((await inbound).status).toBe(502);
    } finally {
      webhook.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        webhook.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("requires HTTPS except for loopback HTTP on loopback-bound servers", async () => {
    const server = await startZaloServer({ botToken: "test-auth-token" });
    servers.push(server);

    const rejected = await fetch(`${server.manifest.baseUrl}/bottest-auth-token/setWebhook`, {
      body: JSON.stringify({
        secret_token: "secret-token",
        url: "http://192.168.1.10/zalo",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      description: "url must use HTTPS",
      error_code: 400,
      ok: false,
    });

    const privateHttps = await fetch(`${server.manifest.baseUrl}/bottest-auth-token/setWebhook`, {
      body: JSON.stringify({
        secret_token: "secret-token",
        url: "https://10.0.0.1/zalo",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(privateHttps.status).toBe(400);
    await expect(privateHttps.json()).resolves.toMatchObject({
      description: "url must not target a private or link-local address",
    });
  });

  it("blocks private and link-local webhook targets when remotely bound", async () => {
    const server = await startZaloServer({
      botToken: "test-auth-token",
      host: "0.0.0.0",
    });
    servers.push(server);
    const apiRoot = server.manifest.baseUrl.replace("0.0.0.0", "127.0.0.1");

    for (const url of [
      "https://10.0.0.1/zalo",
      "https://127.0.0.1/zalo",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/zalo",
      "https://[::ffff:7f00:1]/zalo",
    ]) {
      const response = await fetch(`${apiRoot}/bottest-auth-token/setWebhook`, {
        body: JSON.stringify({ secret_token: "secret-token", url }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        description: "url must not target a private or link-local address",
        error_code: 400,
        ok: false,
      });
    }

    const http = await fetch(`${apiRoot}/bottest-auth-token/setWebhook`, {
      body: JSON.stringify({
        secret_token: "secret-token",
        url: "http://93.184.216.34/zalo",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(http.status).toBe(400);
    await expect(http.json()).resolves.toMatchObject({
      description: "url must use HTTPS",
      ok: false,
    });

    const publicHttps = await fetch(`${apiRoot}/bottest-auth-token/setWebhook`, {
      body: JSON.stringify({
        secret_token: "secret-token",
        url: "https://93.184.216.34/zalo",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(publicHttps.status).toBe(200);
  });

  it("rejects admin inbound when the polling update queue is full", async () => {
    const server = await startZaloServer({
      adminToken: "admin",
      maxPendingInboundEvents: 1,
    });
    servers.push(server);
    const sendInbound = (text: string) =>
      fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin",
        },
        method: "POST",
      });

    expect((await sendInbound("first")).status).toBe(200);
    const overloaded = await sendInbound("second");
    expect(overloaded.status).toBe(429);
    await expect(overloaded.json()).resolves.toEqual({
      description: "Pending inbound queue is full (1 updates)",
      error_code: 429,
      ok: false,
    });
  });

  it("rejects invalid bot tokens and unauthenticated admin ingress", async () => {
    const server = await startZaloServer({ botToken: "test-token-placeholder" });
    servers.push(server);

    const invalidToken = await fetch(`${server.manifest.baseUrl}/botwrong/getMe`);
    expect(invalidToken.status).toBe(401);
    await expect(invalidToken.json()).resolves.toMatchObject({ error_code: 401, ok: false });

    const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({ chatId: "chat-1", senderId: "user-1", text: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(inbound.status).toBe(401);
  });

  it("drains request bodies rejected by admin and bot authentication", async () => {
    const server = await startZaloServer({
      adminToken: "admin",
      botToken: "test-token-placeholder",
    });
    servers.push(server);

    for (const url of [
      server.manifest.endpoints.adminInboundUrl,
      `${server.manifest.baseUrl}/botwrong/sendMessage`,
    ]) {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const body = JSON.stringify({ chat_id: "chat-1", text: "rejected" });
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
          method: "GET",
          url: `${server.manifest.baseUrl}/bottest-token-placeholder/getMe`,
        });
        expect(accepted.status).toBe(200);
      } finally {
        agent.destroy();
      }
    }
  });
});
