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
import { createTempDir, disposeTempDir } from "./test-helpers.js";

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

describe("slack local provider server", () => {
  it("serves Slack auth and conversation APIs", async () => {
    const server = await startTestSlackServer();

    await expect((await slackApi(server, "auth.test")).json()).resolves.toMatchObject({
      ok: true,
      team_id: "TCRABLINE",
      user_id: "UCRABBOT",
    });

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

  it("posts messages and serves thread/history reads", async () => {
    const server = await startTestSlackServer();

    const parent = await postMessage(server, {
      attachments: [{ fallback: "fallback text", text: "attachment text" }],
      blocks: [{ text: { text: "block text", type: "mrkdwn" }, type: "section" }],
      channel: "C1234567890",
      text: "hello fake slack",
      unfurl_links: false,
    });

    await expect(
      (
        await slackApi(server, "chat.postMessage", {
          channel: "C1234567890",
          text: "thread reply",
          thread_ts: parent.ts,
        })
      ).json(),
    ).resolves.toMatchObject({
      channel: "C1234567890",
      message: {
        text: "thread reply",
        thread_ts: parent.ts,
      },
      ok: true,
    });

    await expect(
      (
        await slackApi(server, "conversations.replies", {
          channel: "C1234567890",
          ts: parent.ts,
        })
      ).json(),
    ).resolves.toMatchObject({
      messages: [{ text: "hello fake slack" }, { text: "thread reply" }],
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
      messages: [{ text: "thread reply" }],
      ok: true,
    });
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
      expect(callback.history).toContainEqual(
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
    const server = await startTestSlackServer();

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

    const rateLimited = await slackApi(server, "chat.postMessage", {
      channel: "C1234567890",
      retry_after: 2,
      simulate_rate_limit: true,
      text: "slow down",
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("2");
    await expect(rateLimited.json()).resolves.toMatchObject({
      error: "ratelimited",
      ok: false,
    });
  });

  it("handles Slack Events API URL verification", async () => {
    const server = await startTestSlackServer();

    const response = await fetch(server.manifest.endpoints.eventsUrl, {
      body: JSON.stringify({
        challenge: "challenge-token",
        type: "url_verification",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(response.json()).resolves.toEqual({ challenge: "challenge-token" });
  });
});
