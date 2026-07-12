import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startSlackServer,
  type StartedSlackServer,
  type StartSlackServerParams,
} from "../src/index.js";
import { ADMIN_TOKEN_HEADER } from "../src/servers/http.js";
import { createTempDir, disposeTempDir, requestHttp } from "./test-helpers.js";

const servers: StartedSlackServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function startTestSlackServer(
  params: StartSlackServerParams = {},
): Promise<StartedSlackServer> {
  const directory = await createTempDir();
  directories.push(directory);
  const server = await startSlackServer({
    ...params,
    adminToken: params.adminToken ?? "admin-token",
    botToken: params.botToken ?? "xoxb-fake",
    recorderPath: path.join(directory, "slack.jsonl"),
  });
  servers.push(server);
  return server;
}

async function slackApi(
  server: StartedSlackServer,
  method: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await fetch(`${server.manifest.endpoints.apiRoot}${method}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer xoxb-fake",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function postMessage(
  server: StartedSlackServer,
  body: Record<string, unknown>,
): Promise<{ ts: string }> {
  const response = await slackApi(server, "chat.postMessage", body);
  const payload = (await response.json()) as { ts: string };
  expect(payload).toMatchObject({ ok: true });
  return payload;
}

async function postSignedSlackEvent(
  server: StartedSlackServer,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", server.manifest.signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return await fetch(server.manifest.endpoints.eventsUrl, {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
}

describe("slack local provider server", () => {
  it("serves Slack auth and conversation APIs", async () => {
    const server = await startTestSlackServer();

    await expect((await slackApi(server, "auth.test")).json()).resolves.toMatchObject({
      ok: true,
      team_id: "TCRABLINE",
      user_id: "UCRABBOT",
    });
    const lowerCaseBearer = await fetch(`${server.manifest.endpoints.apiRoot}auth.test`, {
      headers: { authorization: "bearer xoxb-fake" },
      method: "POST",
    });
    await expect(lowerCaseBearer.json()).resolves.toMatchObject({ ok: true });

    const unauthenticated = await fetch(`${server.manifest.endpoints.apiRoot}auth.test`, {
      method: "POST",
    });
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: "not_authed",
      ok: false,
    });

    const invalidJson = await fetch(`${server.manifest.endpoints.apiRoot}chat.postMessage`, {
      body: "{",
      headers: {
        authorization: "Bearer xoxb-fake",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({ error: "invalid_json", ok: false });

    await expect(
      (
        await slackApi(server, "conversations.open", {
          users: "U1234567890",
        })
      ).json(),
    ).resolves.toMatchObject({
      channel: {
        id: "D000000001",
        is_im: true,
        user: "U1234567890",
      },
      ok: true,
    });

    await expect(
      (
        await slackApi(server, "conversations.info", {
          channel: "C1234567890",
        })
      ).json(),
    ).resolves.toMatchObject({
      channel: {
        id: "C1234567890",
        is_channel: true,
      },
      ok: true,
    });
  });

  it("opens stable MPIMs and rejects conversations with more than eight users", async () => {
    const server = await startTestSlackServer();
    const users = ["U111", "U222", "U333"];

    const opened = await slackApi(server, "conversations.open", {
      users: users.join(","),
    });
    await expect(opened.json()).resolves.toEqual({
      channel: {
        id: "G000000001",
        is_group: false,
        is_mpim: true,
        members: ["UCRABBOT", ...users],
      },
      ok: true,
    });

    const reopened = await slackApi(server, "conversations.open", {
      users: [...users].reverse().join(","),
    });
    await expect(reopened.json()).resolves.toMatchObject({
      channel: {
        id: "G000000001",
        members: ["UCRABBOT", ...users],
      },
      ok: true,
    });

    await expect(
      (
        await slackApi(server, "conversations.info", {
          channel: "G000000001",
        })
      ).json(),
    ).resolves.toEqual({
      channel: {
        id: "G000000001",
        is_channel: false,
        is_group: false,
        is_im: false,
        is_mpim: true,
        members: ["UCRABBOT", ...users],
        name: "crabline",
      },
      ok: true,
    });

    const tooMany = await slackApi(server, "conversations.open", {
      users: Array.from({ length: 9 }, (_, index) => `U${index + 100}`).join(","),
    });
    await expect(tooMany.json()).resolves.toEqual({
      error: "too_many_users",
      ok: false,
    });

    const selfConversation = await slackApi(server, "conversations.open", {
      users: "UCRABBOT",
    });
    await expect(selfConversation.json()).resolves.toEqual({
      error: "invalid_user_combination",
      ok: false,
    });
  });

  it("bounds request bodies and does not record rejected API authentication", async () => {
    const observed: unknown[] = [];
    const server = await startTestSlackServer({
      onEvent: (event) => {
        observed.push(event);
      },
    });
    const authUrl = `${server.manifest.endpoints.apiRoot}auth.test`;

    const unauthenticated = await fetch(authUrl, {
      body: JSON.stringify({ probe: "untrusted slack body" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(unauthenticated.json()).resolves.toEqual({
      error: "not_authed",
      ok: false,
    });
    const invalidHeader = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        authorization: "Bearer wrong-token",
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: authUrl,
    });
    expect(invalidHeader.status).toBe(200);
    expect(JSON.parse(invalidHeader.body)).toEqual({
      error: "invalid_auth",
      ok: false,
    });

    for (const scalarBody of ["null", '"scalar"', "42", "true", "[]"]) {
      const invalid = await fetch(authUrl, {
        body: scalarBody,
        headers: {
          authorization: "Bearer xoxb-fake",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: "json_not_object", ok: false });
    }

    const earlyRejected = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        authorization: "Bearer xoxb-fake",
        "content-length": String(1024 * 1024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
      url: authUrl,
    });
    expect(earlyRejected.status).toBe(413);
    expect(JSON.parse(earlyRejected.body)).toEqual({
      error: "request_too_large",
      ok: false,
    });

    const streamed = await requestHttp({
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
      headers: {
        authorization: "Bearer xoxb-fake",
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      method: "POST",
      url: authUrl,
    });
    expect(streamed.status).toBe(413);
    expect(JSON.parse(streamed.body)).toEqual({
      error: "request_too_large",
      ok: false,
    });

    await expect((await slackApi(server, "auth.test")).json()).resolves.toMatchObject({ ok: true });
    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).not.toContain("untrusted slack body");
    expect(observed).toEqual([
      expect.objectContaining({
        path: "/api/auth.test",
        type: "api",
      }),
    ]);
  });

  it("posts messages and serves thread/history reads", async () => {
    const server = await startTestSlackServer();

    const parent = await postMessage(server, {
      attachments: [{ fallback: "fallback text", text: "attachment text" }],
      blocks: [{ text: { text: "block text", type: "mrkdwn" }, type: "section" }],
      channel: "C1234567890",
      text: "hello fake slack",
      unfurl_links: false,
    });

    const replyResponse = await slackApi(server, "chat.postMessage", {
      channel: "C1234567890",
      text: "thread reply",
      thread_ts: parent.ts,
    });
    const reply = (await replyResponse.json()) as { ts: string };
    expect(reply).toMatchObject({
      channel: "C1234567890",
      message: {
        text: "thread reply",
        thread_ts: parent.ts,
      },
      ok: true,
    });
    const broadcastReply = await postMessage(server, {
      channel: "C1234567890",
      reply_broadcast: true,
      text: "broadcast reply",
      thread_ts: parent.ts,
    });
    await expect(
      (
        await slackApi(server, "chat.postMessage", {
          channel: "C1234567890",
          text: "nested reply",
          thread_ts: reply.ts,
        })
      ).json(),
    ).resolves.toEqual({
      error: "thread_not_found",
      ok: false,
    });

    await expect(
      (
        await slackApi(server, "conversations.replies", {
          channel: "C1234567890",
          ts: parent.ts,
        })
      ).json(),
    ).resolves.toMatchObject({
      messages: [
        { text: "hello fake slack" },
        { text: "thread reply" },
        { text: "broadcast reply" },
      ],
      ok: true,
    });
    await expect(
      (
        await slackApi(server, "conversations.replies", {
          channel: "C1234567890",
          ts: reply.ts,
        })
      ).json(),
    ).resolves.toMatchObject({
      messages: [
        { text: "hello fake slack" },
        { text: "thread reply" },
        { text: "broadcast reply" },
      ],
      ok: true,
    });

    await expect(
      (
        await slackApi(server, "conversations.history", {
          channel: "C1234567890",
          limit: 1,
          oldest: parent.ts,
        })
      ).json(),
    ).resolves.toMatchObject({
      has_more: false,
      messages: [{ text: "broadcast reply", ts: broadcastReply.ts }],
      ok: true,
    });

    for (const limit of [0, -1]) {
      await expect(
        (
          await slackApi(server, "conversations.history", {
            channel: "C1234567890",
            limit,
          })
        ).json(),
      ).resolves.toEqual({
        error: "invalid_limit",
        ok: false,
      });
    }
  });

  it("preserves message whitespace and accepts blocks-only admin events", async () => {
    const server = await startTestSlackServer();

    const outbound = await slackApi(server, "chat.postMessage", {
      channel: "C1234567890",
      text: "  keep surrounding whitespace  ",
    });
    await expect(outbound.json()).resolves.toMatchObject({
      message: { text: "  keep surrounding whitespace  " },
      ok: true,
    });

    for (const body of [
      {
        blocks: [{ text: { text: "block only", type: "plain_text" }, type: "section" }],
        channel: "C1234567890",
        user: "U1234567890",
      },
      {
        channel: "C1234567890",
        text: "",
        user: "U1234567890",
      },
      {
        channel: "C1234567890",
        text: "  inbound whitespace  ",
        user: "U1234567890",
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
      expect(response.status).toBe(200);
    }

    const history = await slackApi(server, "conversations.history", {
      channel: "C1234567890",
    });
    await expect(history.json()).resolves.toMatchObject({
      messages: [
        { text: "  inbound whitespace  " },
        { text: "" },
        { blocks: expect.any(Array), text: "" },
        { text: "  keep surrounding whitespace  " },
      ],
      ok: true,
    });
  });

  it("rejects unsupported Web API and Events API methods", async () => {
    const server = await startTestSlackServer();

    const webApi = await fetch(`${server.manifest.endpoints.apiRoot}auth.test`, {
      headers: { authorization: "Bearer xoxb-fake" },
      method: "PUT",
    });
    expect(webApi.status).toBe(405);
    expect(webApi.headers.get("allow")).toBe("GET, POST");

    const events = await fetch(server.manifest.endpoints.eventsUrl);
    expect(events.status).toBe(405);
    expect(events.headers.get("allow")).toBe("POST");
  });

  it("rejects malformed blocks and attachments", async () => {
    const server = await startTestSlackServer();
    for (const [field, value, error] of [
      ["blocks", { type: "section" }, "invalid_blocks"],
      ["blocks", "not-json", "invalid_blocks"],
      ["attachments", { text: "attachment" }, "invalid_attachments"],
      ["attachments", '{"text":"attachment"}', "invalid_attachments"],
    ] as const) {
      const response = await slackApi(server, "chat.postMessage", {
        channel: "C1234567890",
        [field]: value,
        text: "must not persist",
      });
      await expect(response.json()).resolves.toEqual({ error, ok: false });
    }

    const history = await slackApi(server, "conversations.history", {
      channel: "C1234567890",
    });
    await expect(history.json()).resolves.toMatchObject({ messages: [], ok: true });
  });

  it("delivers authenticated admin inbound through signed Slack Events API requests", async () => {
    type DeliveredEvent = {
      body: string;
      history: Array<{ text?: string }>;
      signature: string | undefined;
      timestamp: string | undefined;
    };
    let slackServer: StartedSlackServer | undefined;
    let resolveDelivered: (event: DeliveredEvent) => void = () => undefined;
    const delivered = new Promise<DeliveredEvent>((resolve) => {
      resolveDelivered = resolve;
    });
    const eventsReceiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (!slackServer) {
        response.statusCode = 500;
        response.end("Slack server is not ready.");
        return;
      }
      const historyResponse = await slackApi(slackServer, "conversations.history", {
        channel: "C1234567890",
      });
      const history = (await historyResponse.json()) as {
        messages?: Array<{ text?: string }>;
      };
      resolveDelivered({
        body: Buffer.concat(chunks).toString("utf8"),
        history: history.messages ?? [],
        signature:
          typeof request.headers["x-slack-signature"] === "string"
            ? request.headers["x-slack-signature"]
            : undefined,
        timestamp:
          typeof request.headers["x-slack-request-timestamp"] === "string"
            ? request.headers["x-slack-request-timestamp"]
            : undefined,
      });
      response.statusCode = 200;
      response.end();
    });
    await new Promise<void>((resolve) => eventsReceiver.listen(0, "127.0.0.1", resolve));
    const address = eventsReceiver.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Slack Events API receiver address.");
    }
    slackServer = await startTestSlackServer({
      eventsRequestUrl: `http://127.0.0.1:${address.port}/slack/events`,
      signingSecret: "test-signing-secret",
    });
    const server = slackServer;
    const parent = await postMessage(server, {
      channel: "C1234567890",
      text: "hello fake slack",
    });

    const rejected = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channel: "C1234567890",
        text: "user nonce-1",
        threadTs: parent.ts,
        user: "U1234567890",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(rejected.status).toBe(401);

    try {
      const accepted = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          channel: "C1234567890",
          text: "user nonce-1",
          threadTs: parent.ts,
          user: "U1234567890",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin-token",
        },
        method: "POST",
      });
      await expect(accepted.json()).resolves.toMatchObject({
        event: {
          event: {
            channel: "C1234567890",
            text: "user nonce-1",
            thread_ts: parent.ts,
            user: "U1234567890",
          },
          type: "event_callback",
        },
        ok: true,
      });

      const callback = await delivered;
      const callbackBody = JSON.parse(callback.body) as Record<string, unknown>;
      expect(callbackBody).toMatchObject({
        event: {
          channel: "C1234567890",
          text: "user nonce-1",
          thread_ts: parent.ts,
          user: "U1234567890",
        },
        type: "event_callback",
      });
      expect(callback.timestamp).toMatch(/^\d+$/u);
      expect(callback.signature).toBe(
        `v0=${createHmac("sha256", "test-signing-secret")
          .update(`v0:${callback.timestamp}:${callback.body}`)
          .digest("hex")}`,
      );
      expect(callback.history).not.toContainEqual(
        expect.objectContaining({
          text: "user nonce-1",
        }),
      );

      await expect(
        (
          await slackApi(server, "conversations.replies", {
            channel: "C1234567890",
            ts: parent.ts,
          })
        ).json(),
      ).resolves.toMatchObject({
        messages: [{ text: "hello fake slack" }, { text: "user nonce-1" }],
        ok: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        eventsReceiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("retains inbound message state when Events API delivery is rejected", async () => {
    const eventsReceiver = createServer((_request, response) => {
      response.statusCode = 503;
      response.end();
    });
    await new Promise<void>((resolve) => eventsReceiver.listen(0, "127.0.0.1", resolve));
    const address = eventsReceiver.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Slack Events API receiver address.");
    }
    const server = await startTestSlackServer({
      eventsRequestUrl: `http://127.0.0.1:${address.port}/slack/events`,
      signingSecret: "test-signing-secret",
    });

    try {
      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          channel: "C1234567890",
          text: "retained after callback failure",
          user: "U1234567890",
        }),
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": "admin-token",
        },
        method: "POST",
      });
      expect(inbound.status).toBe(502);
      await expect(inbound.json()).resolves.toEqual({
        error: "event_delivery_failed",
        ok: false,
      });

      await expect(
        (
          await slackApi(server, "conversations.history", {
            channel: "C1234567890",
          })
        ).json(),
      ).resolves.toMatchObject({
        messages: [{ text: "retained after callback failure" }],
        ok: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        eventsReceiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("cancels unread Events API response bodies", async () => {
    let resolveClosed: () => void = () => undefined;
    const responseClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const eventsReceiver = createServer((_request, response) => {
      response.once("close", resolveClosed);
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("ignored response body");
    });
    await new Promise<void>((resolve) => eventsReceiver.listen(0, "127.0.0.1", resolve));
    const address = eventsReceiver.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve Slack Events API receiver address.");
    }
    const server = await startTestSlackServer({
      eventsRequestUrl: `http://127.0.0.1:${address.port}/slack/events`,
      signingSecret: "test-token-placeholder",
    });

    try {
      const inbound = await fetch(server.manifest.endpoints.adminInboundUrl, {
        body: JSON.stringify({
          channel: "C1234567890",
          text: "response body disposal",
          user: "U1234567890",
        }),
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: server.manifest.adminToken,
        },
        method: "POST",
      });
      expect(inbound.status).toBe(200);
      await responseClosed;
    } finally {
      await new Promise<void>((resolve, reject) =>
        eventsReceiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("redacts body/query tokens and skips rejected admin inbound recording", async () => {
    const server = await startTestSlackServer();

    await expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}auth.test?token=xoxb-fake`, {
          method: "GET",
        })
      ).json(),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      (
        await fetch(`${server.manifest.endpoints.apiRoot}auth.test`, {
          body: JSON.stringify({ token: "xoxb-fake" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).json(),
    ).resolves.toMatchObject({ ok: true });

    const rejected = await fetch(server.manifest.endpoints.adminInboundUrl, {
      body: JSON.stringify({
        channel: "C1234567890",
        text: "secret rejected inbound",
        user: "U1234567890",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(rejected.status).toBe(401);

    const recorder = await fs.readFile(server.manifest.recorderPath, "utf8");
    expect(recorder).not.toContain("xoxb-fake");
    expect(recorder).not.toContain("secret rejected inbound");
    const events = recorder
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { body: { token?: string }; query: { token?: string } });
    expect(events).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ token: "[redacted]" }),
        query: expect.objectContaining({ token: "[redacted]" }),
      }),
      expect.objectContaining({
        body: expect.objectContaining({ token: "[redacted]" }),
      }),
    ]);
  });

  it("returns Slack-shaped posting errors", async () => {
    const server = await startTestSlackServer({
      chatPostMessageRateLimit: { remaining: 2, retryAfterSeconds: 2 },
    });

    await expect(
      (
        await slackApi(server, "chat.postMessage", {
          channel: "C1234567890",
          text: "reply without parent",
          thread_ts: "1700000000.999999",
        })
      ).json(),
    ).resolves.toMatchObject({
      error: "thread_not_found",
      ok: false,
    });

    await expect(
      (
        await slackApi(server, "chat.postMessage", {
          channel: "C1234567890",
          text: "first request",
        })
      ).json(),
    ).resolves.toMatchObject({ ok: true });
    const rateLimited = await slackApi(server, "chat.postMessage", {
      channel: "C1234567890",
      text: "slow down",
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("2");
    await expect(rateLimited.json()).resolves.toMatchObject({
      error: "ratelimited",
      ok: false,
    });
  });

  it("validates out-of-band rate-limit controls", async () => {
    await expect(
      startSlackServer({
        chatPostMessageRateLimit: { remaining: -1, retryAfterSeconds: 1 },
      }),
    ).rejects.toThrow("remaining must be a non-negative safe integer");
    await expect(
      startSlackServer({
        chatPostMessageRateLimit: { remaining: 0, retryAfterSeconds: 0 },
      }),
    ).rejects.toThrow("retryAfterSeconds must be a positive safe integer");
  });

  it("does not expose rate-limit controls through chat.postMessage fields", async () => {
    const server = await startTestSlackServer();
    const response = await slackApi(server, "chat.postMessage", {
      channel: "C1234567890",
      retry_after: 30,
      simulate_rate_limit: true,
      text: "ordinary provider payload",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("authenticates Slack Events API compatibility without recording callbacks", async () => {
    const observed: unknown[] = [];
    const server = await startTestSlackServer({
      onEvent: (event) => {
        observed.push(event);
      },
    });

    const unsigned = await fetch(server.manifest.endpoints.eventsUrl, {
      body: JSON.stringify({ type: "event_callback" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unsigned.status).toBe(401);

    const verification = await postSignedSlackEvent(server, {
      challenge: "challenge-token",
      type: "url_verification",
    });
    await expect(verification.json()).resolves.toEqual({ challenge: "challenge-token" });

    for (const body of [
      {
        event: {
          blocks: [{ text: { text: "block only", type: "plain_text" }, type: "section" }],
          channel: "C1234567890",
          type: "message",
        },
        type: "event_callback",
      },
      {
        event: { channel: "C1234567890", text: "", type: "message" },
        type: "event_callback",
      },
      {
        api_app_id: "ACRABLINE",
        minute_rate_limited: 1_700_000_000,
        team_id: "TCRABLINE",
        type: "app_rate_limited",
      },
    ]) {
      const response = await postSignedSlackEvent(server, body);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    }
    expect(observed).toEqual([]);
  });
});
