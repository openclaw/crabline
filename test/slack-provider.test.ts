import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../src/config/schema.js";
import {
  handleSlackWebhookPayload,
  normalizeSlackEventsPayload,
  resolveSlackAdapterConfig,
  SlackProviderAdapter,
} from "../src/providers/builtin/slack.js";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const providers: SlackProviderAdapter[] = [];

describe("Slack URL verification", () => {
  it("echoes the challenge", async () => {
    const response = handleSlackWebhookPayload({
      challenge: "challenge-token",
      type: "url_verification",
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ challenge: "challenge-token" });
  });

  it("redacts verification tokens from normalized recorder payloads", () => {
    const normalized = normalizeSlackEventsPayload({
      event: {
        channel: "C1234567890",
        text: "authenticated callback",
        ts: "1700000001.000200",
        type: "message",
      },
      event_id: "Ev1234567890",
      token: "placeholder",
      type: "event_callback",
    });

    expect(normalized.id).toBe("Ev1234567890");
    expect(normalized.raw).toMatchObject({ type: "event_callback" });
    expect(normalized.raw).not.toHaveProperty("token");
  });
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createSlackConfig(port: number, signingSecret?: string): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "slack",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "slack",
    slack: {
      recorder: { path: path.join(directory, "slack.jsonl") },
      ...(signingSecret ? { signingSecret } : {}),
      webhook: {
        host: "127.0.0.1",
        path: "/slack/events",
        port,
      },
    },
    status: "active",
  };
}

function createContext(
  config: ProviderConfig,
  target: ProviderContext["fixture"]["target"] = {
    id: "C1234567890",
    metadata: {},
  },
): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "slack-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "slack",
      retries: 0,
      tags: [],
      target,
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "slack",
    userName: "crabline",
  };
}

function endpointFromDetails(details: string[]): string {
  const detail = details.find((entry) => entry.startsWith("events endpoint "));
  if (!detail) {
    throw new Error(`No Slack events endpoint detail found in ${details.join("\n")}`);
  }
  return detail.replace("events endpoint ", "");
}

function slackSignature(signingSecret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

describe("slack provider", () => {
  it("requires request signatures for externally reachable event endpoints", async () => {
    const config = await createSlackConfig(0);
    config.slack!.webhook.host = "0.0.0.0";
    expect(() => new SlackProviderAdapter("slack", config, "crabline")).toThrow(
      /externally reachable webhooks require slack\.signingSecret/u,
    );

    config.slack!.webhook.host = "127.0.0.1";
    config.slack!.webhook.publicUrl = "https://slack.example.test/events";
    expect(() => new SlackProviderAdapter("slack", config, "crabline")).toThrow(
      /externally reachable webhooks require slack\.signingSecret/u,
    );

    config.slack!.signingSecret = "test-token-placeholder";
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
  });

  it("rejects whitespace-only signing secrets from config and env", async () => {
    const config = await createSlackConfig(0);
    config.slack!.signingSecret = " \t ";
    expect(() => resolveSlackAdapterConfig(config, {})).toThrow(
      "Slack signingSecret must not be empty or whitespace-only.",
    );

    delete config.slack!.signingSecret;
    expect(() => resolveSlackAdapterConfig(config, { SLACK_SIGNING_SECRET: "\n" })).toThrow(
      "SLACK_SIGNING_SECRET must not be empty or whitespace-only.",
    );
  });

  it("keeps native Slack conversation and thread timestamp ids", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "C1234567890", metadata: {} })).toMatchObject({
      channelId: "C1234567890",
    });
    expect(provider.normalizeTarget({ id: "U1234567890", metadata: {} })).toMatchObject({
      channelId: "U1234567890",
    });
    expect(provider.normalizeTarget({ id: "W1234567890", metadata: {} })).toMatchObject({
      channelId: "W1234567890",
    });
    expect(
      provider.normalizeTarget({
        channelId: "C1234567890",
        id: "reply-target",
        metadata: {},
        threadId: "1700000000.000100",
      }),
    ).toMatchObject({
      channelId: "C1234567890",
      threadId: "1700000000.000100",
    });

    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: "1700000000.000100",
    });
    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "thread-scope",
        text: "thread-scoped send",
      }),
    ).resolves.toMatchObject({
      threadId: "C1234567890:thread:1700000000.000100",
    });
  });

  it("rejects generic and Crabline-prefixed Slack ids", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    expect(() => provider.normalizeTarget({ id: "target-1", metadata: {} })).toThrow(
      /native Slack conversation or user id/u,
    );
    expect(() => provider.normalizeTarget({ id: "slack:C1234567890", metadata: {} })).toThrow(
      /native Slack conversation or user id/u,
    );
    expect(() =>
      provider.normalizeTarget({
        channelId: "C1234567890",
        id: "reply-target",
        metadata: {},
        threadId: "thread-1",
      }),
    ).toThrow(/Slack timestamp/u);
  });

  it("probes and sends with Slack-shaped ids", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    const context = createContext(config);
    const probe = await provider.probe(context);
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("slack local mock ready");
    expect(probe.details.join("\n")).toContain("events endpoint http://127.0.0.1:");
    expect(probe.details.join("\n")).toContain("channel reachable C1234567890");

    const result = await provider.send({
      ...context,
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello nonce-1",
    });
    expect(result.accepted).toBe(true);
    expect(result.threadId).toBe("C1234567890");

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce-1",
        since: new Date(Date.now() - 1000).toISOString(),
        threadId: result.threadId,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      author: "assistant",
      text: "[slack mock] hello nonce-1",
      threadId: "C1234567890",
    });
  });

  it("accepts Slack Events API-style inbound messages", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: "1700000000.000100",
    });
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const threadKey = "C1234567890:thread:1700000000.000100";
    const waitPromise = provider.waitForInbound({
      ...context,
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "1700000000.000100",
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          channel: "C1234567890",
          text: "ACK nonce-2",
          thread_ts: "1700000000.000100",
          ts: "1700000001.000200",
          type: "message",
          user: "U1234567890",
        },
        team_id: "T1234567890",
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);

    await expect(waitPromise).resolves.toMatchObject({
      author: "user",
      id: "1700000001.000200",
      text: "ACK nonce-2",
      threadId: threadKey,
    });
  });

  it.each(["U1234567890", "W1234567890"])(
    "correlates native D-channel events to direct target %s",
    async (userId) => {
      const config = await createSlackConfig(0);
      const provider = new SlackProviderAdapter("slack", config, "crabline");
      providers.push(provider);
      const context = createContext(config, { id: userId, metadata: {} });
      context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
      const endpoint = endpointFromDetails((await provider.probe(context)).details);
      const nonce = `direct-${userId}`;
      const waiting = provider.waitForInbound({
        ...context,
        nonce,
        since: new Date(Date.now() - 1000).toISOString(),
        timeoutMs: 500,
      });

      for (const [channel, eventUser] of [
        ["D9999999999", "U9999999999"],
        ["D1234567890", userId],
      ]) {
        const response = await fetch(endpoint, {
          body: JSON.stringify({
            event: {
              channel,
              text: `ACK ${nonce}`,
              ts: channel === "D1234567890" ? "1700000002.000300" : "1700000001.000200",
              type: "message",
              user: eventUser,
            },
            type: "event_callback",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(response.status).toBe(200);
      }

      await expect(waiting).resolves.toMatchObject({
        author: "user",
        text: `ACK ${nonce}`,
        threadId: "D1234567890",
      });
    },
  );

  it.each(["U1234567890", "W1234567890"])(
    "correlates threaded D-channel events to direct target %s",
    async (userId) => {
      const config = await createSlackConfig(0);
      const threadTs = "1700000000.000100";
      const provider = new SlackProviderAdapter("slack", config, "crabline");
      providers.push(provider);
      const context = createContext(config, {
        id: userId,
        metadata: {},
        threadId: threadTs,
      });
      context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
      const endpoint = endpointFromDetails((await provider.probe(context)).details);
      const nonce = `threaded-direct-${userId}`;
      const waiting = provider.waitForInbound({
        ...context,
        nonce,
        since: new Date(Date.now() - 1000).toISOString(),
        timeoutMs: 500,
      });

      for (const [eventId, candidateThreadTs] of [
        ["EvWRONGTHREAD1", "1700000000.000101"],
        ["EvRIGHTTHREAD1", threadTs],
      ]) {
        const response = await fetch(endpoint, {
          body: JSON.stringify({
            event: {
              channel: "D1234567890",
              text: `ACK ${nonce}`,
              thread_ts: candidateThreadTs,
              ts: candidateThreadTs === threadTs ? "1700000002.000300" : "1700000001.000200",
              type: "message",
              user: userId,
            },
            event_id: eventId,
            type: "event_callback",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(response.status).toBe(200);
      }

      await expect(waiting).resolves.toMatchObject({
        author: "user",
        id: "EvRIGHTTHREAD1",
        text: `ACK ${nonce}`,
        threadId: `D1234567890:thread:${threadTs}`,
      });
    },
  );

  it("normalizes Slack message_changed callbacks from the replacement message", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: "1700000000.000100",
    });
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "edited-nonce",
      since: new Date(Date.now() - 1000).toISOString(),
      timeoutMs: 500,
    });
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          channel: "C1234567890",
          event_ts: "1700000002.000300",
          message: {
            text: "edited ACK edited-nonce",
            thread_ts: "1700000000.000100",
            ts: "1700000001.000200",
            type: "message",
            user: "U1234567890",
          },
          subtype: "message_changed",
          type: "message",
        },
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      author: "user",
      id: "1700000002.000300",
      text: "edited ACK edited-nonce",
      threadId: "C1234567890:thread:1700000000.000100",
    });
  });

  it("extracts native block and attachment fallback text", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config);
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "attachment-value",
      since: new Date(Date.now() - 1_000).toISOString(),
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          attachments: [{ fields: [{ value: "attachment-value" }] }],
          blocks: [
            {
              fields: [{ text: "block fallback", type: "mrkdwn" }],
              text: { text: " \n\t", type: "plain_text" },
              type: "section",
            },
          ],
          channel: "C1234567890",
          text: "",
          ts: "1700000001.000200",
          type: "message",
          user: "U1234567890",
        },
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      id: "1700000001.000200",
      text: "block fallback\nattachment-value",
    });
  });

  it("extracts table and task-card block-only text", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config);
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "table-cell",
      since: new Date(Date.now() - 1_000).toISOString(),
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          blocks: [
            {
              rows: [
                [
                  {
                    elements: [{ text: "table-cell", type: "text" }],
                    type: "rich_text",
                  },
                ],
              ],
              type: "table",
            },
            {
              details: {
                elements: [
                  {
                    elements: [{ text: "task details", type: "text" }],
                    type: "rich_text_section",
                  },
                ],
                type: "rich_text",
              },
              output: {
                elements: [
                  {
                    elements: [{ text: "task output", type: "text" }],
                    type: "rich_text_section",
                  },
                ],
                type: "rich_text",
              },
              tasks: [{ title: "nested task" }],
              title: "task title",
              type: "task_card",
            },
          ],
          channel: "C1234567890",
          ts: "1700000001.000201",
          type: "message",
          user: "U1234567890",
        },
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      id: "1700000001.000201",
      text: "table-cell\ntask title\ntask details\ntask output\nnested task",
    });
  });

  it("preserves inline rich-text adjacency and repeated block text", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config);
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "inline-https://example.test/nonce-tail",
      since: new Date(Date.now() - 1_000).toISOString(),
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          blocks: [
            {
              elements: [
                {
                  elements: [
                    { text: "inline-", type: "text" },
                    { type: "user", user_id: "U1234567890" },
                    { text: " in ", type: "text" },
                    { channel_id: "C1234567890", type: "channel" },
                    { name: "wave", type: "emoji" },
                    { range: "here", type: "broadcast" },
                    { type: "usergroup", usergroup_id: "S1234567890" },
                    {
                      fallback: "Jan 1",
                      format: "{date_short}",
                      timestamp: 1_700_000_000,
                      type: "date",
                    },
                    { text: "-", type: "text" },
                    { type: "link", url: "https://example.test/nonce" },
                    { style: { bold: true }, text: "-tail", type: "text" },
                  ],
                  type: "rich_text_section",
                },
                {
                  elements: [{ text: "repeat", type: "text" }],
                  type: "rich_text_section",
                },
                {
                  elements: [{ text: "repeat", type: "text" }],
                  type: "rich_text_section",
                },
              ],
              type: "rich_text",
            },
          ],
          channel: "C1234567890",
          ts: "1700000001.000202",
          type: "message",
          user: "U1234567890",
        },
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      id: "1700000001.000202",
      text: "inline-<@U1234567890> in <#C1234567890>:wave:<!here><!subteam^S1234567890>Jan 1-https://example.test/nonce-tail\nrepeat\nrepeat",
    });
  });

  it("extracts valid card composition fields", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config);
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "card-action",
      since: new Date(Date.now() - 1_000).toISOString(),
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          blocks: [
            {
              actions: [
                {
                  text: { text: "card-action", type: "plain_text" },
                  type: "button",
                },
              ],
              body: { text: "card-body", type: "mrkdwn" },
              hero_image: { alt_text: "hero image", url: "https://example.test/hero.png" },
              icon: { alt_text: "card icon", url: "https://example.test/icon.png" },
              subtitle: { text: "card subtitle", type: "plain_text" },
              subtext: { text: "card subtext", type: "plain_text" },
              type: "card",
            },
          ],
          channel: "C1234567890",
          ts: "1700000001.000203",
          type: "message",
          user: "U1234567890",
        },
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      id: "1700000001.000203",
      text: "card-body\ncard subtitle\ncard subtext\ncard-action\nhero image\ncard icon",
    });
  });

  it("records message-shaped app mentions", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config);
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "mention-nonce",
      since: new Date(Date.now() - 1_000).toISOString(),
      timeoutMs: 500,
    });

    const response = await fetch(endpoint, {
      body: JSON.stringify({
        event: {
          channel: "C1234567890",
          text: "<@UAPP> mention-nonce",
          ts: "1700000001.000204",
          type: "app_mention",
          user: "U1234567890",
        },
        type: "event_callback",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      id: "1700000001.000204",
      text: "<@UAPP> mention-nonce",
    });
  });

  it("verifies Slack request signatures before parsing", async () => {
    const signingSecret = "test-token-placeholder";
    const config = await createSlackConfig(0, signingSecret);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const endpoint = endpointFromDetails((await provider.probe(createContext(config))).details);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({
      event: {
        channel: "C1234567890",
        text: "authenticated",
        ts: "1700000001.000200",
        type: "message",
      },
      type: "event_callback",
    });
    const signature = slackSignature(signingSecret, timestamp, body);

    const malformed = await fetch(endpoint, {
      body: "{",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=invalid",
      },
      method: "POST",
    });
    expect(malformed.status).toBe(401);

    const rejected = await fetch(endpoint, {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=invalid",
      },
      method: "POST",
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(endpoint, {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      method: "POST",
    });
    expect(accepted.status).toBe(200);
  });

  it("deduplicates retries by outer event_id without suppressing distinct events", async () => {
    const signingSecret = "test-token-placeholder";
    const config = await createSlackConfig(0, signingSecret);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const endpoint = endpointFromDetails((await provider.probe(createContext(config))).details);
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const send = async (eventId: string, text: string, retryNumber?: string): Promise<Response> => {
      const body = JSON.stringify({
        event: {
          channel: "C1234567890",
          text,
          ts: "1700000001.000200",
          type: "message",
          user: "U1234567890",
        },
        event_id: eventId,
        type: "event_callback",
      });
      const timestamp = Math.floor(now / 1000).toString();
      return await fetch(endpoint, {
        body,
        headers: {
          "content-type": "application/json",
          ...(retryNumber
            ? {
                "x-slack-retry-num": retryNumber,
                "x-slack-retry-reason": "http_timeout",
              }
            : {}),
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature(signingSecret, timestamp, body),
        },
        method: "POST",
      });
    };

    try {
      expect((await send("EvRETRY001", "original delivery")).status).toBe(200);
      now += 24 * 60 * 60_000;
      expect((await send("EvRETRY001", "original delivery", "1")).status).toBe(200);
      expect((await send("EvDISTINCT001", "distinct event")).status).toBe(200);

      const records = (await readFile(config.slack!.recorder.path!, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; text: string });
      expect(records).toEqual([
        expect.objectContaining({ id: "EvRETRY001", text: "original delivery" }),
        expect.objectContaining({ id: "EvDISTINCT001", text: "distinct event" }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects new events instead of evicting retained replay identities", async () => {
    const signingSecret = "test-token-placeholder";
    const config = await createSlackConfig(0, signingSecret);
    const provider = new SlackProviderAdapter("slack", config, "crabline", {
      replayCacheLimit: 2,
    });
    providers.push(provider);
    const endpoint = endpointFromDetails((await provider.probe(createContext(config))).details);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const send = async (eventId: string): Promise<Response> => {
      const body = JSON.stringify({
        event: {
          channel: "C1234567890",
          text: eventId,
          ts: "1700000001.000200",
          type: "message",
          user: "U1234567890",
        },
        event_id: eventId,
        type: "event_callback",
      });
      return await fetch(endpoint, {
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature(signingSecret, timestamp, body),
        },
        method: "POST",
      });
    };

    expect((await send("EvCAPACITY01")).status).toBe(200);
    expect((await send("EvCAPACITY02")).status).toBe(200);
    const rejected = await send("EvCAPACITY03");
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect((await send("EvCAPACITY01")).status).toBe(200);

    const records = (await readFile(config.slack!.recorder.path!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string });
    expect(records.map((record) => record.id)).toEqual(["EvCAPACITY01", "EvCAPACITY02"]);
  });

  it("acknowledges unsupported, typeless, and textless callbacks without recording them", async () => {
    const signingSecret = "test-token-placeholder";
    const config = await createSlackConfig(0, signingSecret);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const endpoint = endpointFromDetails((await provider.probe(createContext(config))).details);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    for (const payload of [
      {
        event: {
          item: { channel: "C1234567890", ts: "1700000001.000200", type: "message" },
          reaction: "white_check_mark",
          type: "reaction_added",
          user: "U1234567890",
        },
        event_id: "Ev1234567890",
        type: "event_callback",
      },
      {
        event: {
          channel: "C1234567890",
          deleted_ts: "1700000001.000200",
          subtype: "message_deleted",
          ts: "1700000002.000300",
          type: "message",
        },
        type: "event_callback",
      },
      {
        api_app_id: "ACRABLINE",
        minute_rate_limited: 1_700_000_000,
        team_id: "TCRABLINE",
        type: "app_rate_limited",
      },
      {
        event: {
          channel: "C1234567890",
          message: {
            text: "typeless callback must not be recorded",
            ts: "1700000003.000400",
            type: "message",
            user: "U1234567890",
          },
          subtype: "message_changed",
        },
        type: "event_callback",
      },
    ]) {
      const body = JSON.stringify(payload);
      const response = await fetch(endpoint, {
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature(signingSecret, timestamp, body),
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    }

    for (const payload of [
      {
        event: { channel: "C1234567890", text: 42, type: "message" },
        type: "event_callback",
      },
      {
        event: {
          channel: "C1234567890",
          subtype: "message_changed",
          type: "message",
        },
        type: "event_callback",
      },
    ]) {
      const malformedBody = JSON.stringify(payload);
      const malformed = await fetch(endpoint, {
        body: malformedBody,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature(signingSecret, timestamp, malformedBody),
        },
        method: "POST",
      });
      expect(malformed.status).toBe(400);
    }
    await expect(readFile(config.slack!.recorder.path!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("scopes generic thread webhooks and rejects bare timestamps", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: "1700000000.000100",
    });
    const endpoint = endpointFromDetails((await provider.probe(context)).details);
    const threadKey = "C1234567890:thread:1700000000.000100";
    const waiting = provider.waitForInbound({
      ...context,
      nonce: "generic-thread",
      since: new Date(Date.now() - 1_000).toISOString(),
      threadId: threadKey,
      timeoutMs: 500,
    });
    const scoped = await fetch(endpoint, {
      body: JSON.stringify({
        channelId: "C1234567890",
        id: "generic-scoped",
        text: "ACK scoped",
        threadId: "1700000000.000100",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(scoped.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({
      id: "generic-scoped",
      threadId: threadKey,
    });

    const unscoped = await fetch(endpoint, {
      body: JSON.stringify({
        id: "generic-unscoped",
        text: "ACK unscoped",
        threadId: "1700000000.000100",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unscoped.status).toBe(400);
    await expect(unscoped.text()).resolves.toContain("requires a native channelId");
  });

  it("keeps watched Slack threads scoped to their channel", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);
    const threadTs = "1700000000.000100";
    const context = createContext(config, {
      channelId: "C1234567890",
      id: "reply-target",
      metadata: {},
      threadId: threadTs,
    });
    await provider.probe(context);
    const watch = provider.watch({
      ...context,
      since: new Date(Date.now() - 1_000).toISOString(),
    });
    const iterator = watch[Symbol.asyncIterator]();
    const next = iterator.next();
    const recorderPath = config.slack!.recorder.path!;

    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "wrong-channel",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "wrong channel",
      threadId: `C9999999999:thread:${threadTs}`,
    });
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "right-channel",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "right channel",
      threadId: `C1234567890:thread:${threadTs}`,
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { id: "right-channel" },
    });
    await iterator.return?.();
  });

  it("rejects mock webhook thread ids that are not Slack-shaped", async () => {
    const config = await createSlackConfig(0);
    const provider = new SlackProviderAdapter("slack", config, "crabline");
    providers.push(provider);

    const endpoint = endpointFromDetails((await provider.probe(createContext(config))).details);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        id: "bad-slack-inbound",
        text: "bad nonce",
        threadId: "slack:C1234567890",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "native Slack timestamp or Slack conversation id",
    );
  });
});
