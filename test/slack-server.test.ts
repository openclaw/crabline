import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startSlackServer, type StartedSlackServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const servers: StartedSlackServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function startTestSlackServer(): Promise<StartedSlackServer> {
  const directory = await createTempDir();
  directories.push(directory);
  const server = await startSlackServer({
    adminToken: "admin-token",
    botToken: "xoxb-fake",
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

  it("accepts authenticated admin inbound messages", async () => {
    const server = await startTestSlackServer();
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
