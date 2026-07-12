import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  normalizeWhatsAppWebhookPayload,
  WhatsAppProviderAdapter,
} from "../src/providers/builtin/whatsapp.js";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import {
  createLocalMockConfig,
  createProviderContext,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

function whatsappSignature(body: string, signingKey = "local-mock-secret"): string {
  return `sha256=${createHmac("sha256", signingKey).update(body).digest("hex")}`;
}

describe("WhatsApp webhook normalizer", () => {
  it("normalizes text messages with the provider message id", () => {
    const message = {
      from: "15551234567",
      id: "wamid.abc123",
      text: { body: "hello" },
    };
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [message],
              },
            },
          ],
        },
      ],
    };

    expect(normalizeWhatsAppWebhookPayload(payload)).toEqual([
      {
        author: "user",
        id: "wamid.abc123",
        raw: message,
        text: "hello",
        threadId: "15551234567",
      },
    ]);
  });

  it("keeps native raw data scoped to each message in a batch", () => {
    const first = {
      from: "15551234567",
      id: "wamid.first",
      text: { body: "first" },
      type: "text",
    };
    const second = {
      from: "15557654321",
      id: "wamid.second",
      text: { body: "second" },
      type: "text",
    };
    const payload = {
      entry: [{ changes: [{ value: { messages: [first, second] } }] }],
    };

    const normalized = normalizeWhatsAppWebhookPayload(payload);

    expect(normalized.map((message) => message.raw)).toEqual([first, second]);
    expect(normalized.every((message) => message.raw !== payload)).toBe(true);
  });

  it.each([
    ["not-an-object", "WhatsApp webhook payload must be an object"],
    [{ entry: [{ changes: [{ value: { messages: [{ from: "15551234567" }] } }] }] }, "requires"],
    [
      {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ from: "invalid-id", text: { body: "hello" } }],
                },
              },
            ],
          },
        ],
      },
      "native WhatsApp wa_id",
    ],
  ])("rejects malformed or invalid payloads: %s", (payload, message) => {
    expect(() => normalizeWhatsAppWebhookPayload(payload)).toThrow(message);
  });

  it("preserves generic fallback thread payloads", () => {
    const payload = {
      authorIsBot: false,
      id: "fallback-message",
      text: "fallback text",
      threadId: "15551234567",
    };

    expect(normalizeWhatsAppWebhookPayload(payload)).toEqual([
      {
        authorIsBot: false,
        id: "fallback-message",
        raw: payload,
        text: "fallback text",
        threadId: "15551234567",
      },
    ]);
  });

  it("rejects a malformed batch without recording valid siblings", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const nonce = "mp-whatsapp-batch-abc-1234abcd";

    try {
      const probe = await provider.probe(context);
      const endpoint = probe.details
        .find((detail) => detail.startsWith("webhook endpoint "))
        ?.replace("webhook endpoint ", "");
      expect(endpoint).toBeDefined();
      const body = JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { from: "invalid-id", text: { body: "malformed" }, type: "text" },
                    { from: "15550000000", image: { id: "image-1" }, type: "image" },
                    {
                      from: "15551234567",
                      id: "wamid.first",
                      text: { body: `first valid ${nonce}` },
                      type: "text",
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const response = await fetch(endpoint!, {
        body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": whatsappSignature(body),
        },
        method: "POST",
      });

      expect(response.status).toBe(400);
      await expect(readFile(config.whatsapp!.recorder.path!, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await provider.cleanup();
    }
  });

  it("verifies webhook subscriptions and POST signatures", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const signingKey = "configured-app-secret";
    const verificationValue = "configured-verify-token";
    config.whatsapp!.appSecret = signingKey;
    Reflect.set(config.whatsapp!, "verifyToken", verificationValue);
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });

    try {
      const endpoint = (await provider.probe(context)).details
        .find((detail) => detail.startsWith("webhook endpoint "))
        ?.replace("webhook endpoint ", "");
      expect(endpoint).toBeDefined();

      const verificationUrl = new URL(endpoint!);
      verificationUrl.searchParams.set("hub.mode", "subscribe");
      verificationUrl.searchParams.set("hub.verify_token", verificationValue);
      verificationUrl.searchParams.set("hub.challenge", "challenge-123");
      const verified = await fetch(verificationUrl);
      expect(verified.status).toBe(200);
      await expect(verified.text()).resolves.toBe("challenge-123");

      verificationUrl.searchParams.set("hub.verify_token", "not-a-real");
      const forbidden = await fetch(verificationUrl);
      expect(forbidden.status).toBe(403);

      const body = JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: "15551234567",
                      id: "wamid.signed",
                      text: { body: "signed webhook" },
                      type: "text",
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const unsigned = await fetch(endpoint!, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unsigned.status).toBe(401);
      await expect(readFile(config.whatsapp!.recorder.path!, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const signed = await fetch(endpoint!, {
        body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": whatsappSignature(body, signingKey),
        },
        method: "POST",
      });
      expect(signed.status).toBe(200);
    } finally {
      await provider.cleanup();
    }
  });

  it("rejects a secondary probe when the webhook listener is occupied", async () => {
    const primaryConfig = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const primary = new WhatsAppProviderAdapter("whatsapp-primary", primaryConfig, "crabline");
    const primaryContext = createProviderContext("whatsapp", primaryConfig, {
      id: "15551234567",
      metadata: {},
    });
    let secondary: WhatsAppProviderAdapter | undefined;

    try {
      const primaryProbe = await primary.probe(primaryContext);
      expect(primaryProbe.healthy).toBe(true);
      const endpoint = primaryProbe.details
        .find((detail) => detail.startsWith("webhook endpoint "))
        ?.replace("webhook endpoint ", "");
      expect(endpoint).toBeDefined();

      const secondaryConfig = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
      secondaryConfig.whatsapp!.webhook.port = Number(new URL(endpoint!).port);
      secondary = new WhatsAppProviderAdapter("whatsapp-secondary", secondaryConfig, "crabline");
      const secondaryContext = createProviderContext("whatsapp", secondaryConfig, {
        id: "15551234567",
        metadata: {},
      });

      await expect(secondary.probe(secondaryContext)).rejects.toThrow(/EADDRINUSE/u);
      await expect(primary.probe(primaryContext)).resolves.toMatchObject({ healthy: true });
    } finally {
      await secondary?.cleanup();
      await primary.cleanup();
    }
  });

  it("skips an earlier wrong extracted nonce in exact mode", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    context.fixture.inboundMatch = { author: "user", nonce: "exact", strategy: "contains" };
    const expectedNonce = "mp-whatsapp-exact-abc-1234abcd";
    const wrongNonce = "mp-whatsapp-wrong-abc-87654321";
    const recorderPath = config.whatsapp!.recorder.path!;
    const since = new Date(Date.now() - 1000).toISOString();

    try {
      await appendRecordedInbound(recorderPath, {
        author: "user",
        id: "wrong-nonce",
        provider: "whatsapp",
        sentAt: new Date().toISOString(),
        text: `forwarded ${wrongNonce}; expected ${expectedNonce}`,
        threadId: "15551234567",
      });
      await appendRecordedInbound(recorderPath, {
        author: "user",
        id: "valid-nonce",
        provider: "whatsapp",
        sentAt: new Date().toISOString(),
        text: `reply ${expectedNonce}`,
        threadId: "15551234567",
      });

      await expect(
        provider.waitForInbound({
          ...context,
          nonce: expectedNonce,
          since,
          threadId: "15551234567",
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        id: "valid-nonce",
        text: `reply ${expectedNonce}`,
      });
    } finally {
      await provider.cleanup();
    }
  });

  it("skips an earlier malformed nonce substring in contains mode", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    context.fixture.inboundMatch = { author: "user", nonce: "contains", strategy: "contains" };
    const nonce = "mp-whatsapp-contains-abc-1234abcd";
    const recorderPath = config.whatsapp!.recorder.path!;
    const since = new Date(Date.now() - 1000).toISOString();

    try {
      await appendRecordedInbound(recorderPath, {
        author: "user",
        id: "malformed-substring",
        provider: "whatsapp",
        sentAt: new Date().toISOString(),
        text: `reply ${nonce}0`,
        threadId: "15551234567",
      });
      await appendRecordedInbound(recorderPath, {
        author: "user",
        id: "valid-contains",
        provider: "whatsapp",
        sentAt: new Date().toISOString(),
        text: `reply ${nonce}`,
        threadId: "15551234567",
      });

      await expect(
        provider.waitForInbound({
          ...context,
          nonce,
          since,
          threadId: "15551234567",
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        id: "valid-contains",
        text: `reply ${nonce}`,
      });
    } finally {
      await provider.cleanup();
    }
  });
});

const contractNonces = {
  reply: "mp-whatsapp-reply-abc-11111111",
  user: "mp-whatsapp-user-abc-33333333",
  webhook: "mp-whatsapp-webhook-abc-22222222",
};

runLocalMockProviderContract({
  Adapter: WhatsAppProviderAdapter,
  endpointPath: "/whatsapp/webhook",
  expectedChannelId: "15551234567",
  nonces: contractNonces,
  platform: "whatsapp",
  target: { id: "15551234567", metadata: {} },
  webhookExpected: {
    author: "user",
    id: "wamid.abc123",
    text: `reply ${contractNonces.webhook}`,
  },
  webhookPayload: {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [{ id: "wamid.status-only" }],
            },
          },
        ],
      },
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.abc123",
                  text: { body: `reply ${contractNonces.webhook}` },
                },
              ],
            },
          },
        ],
      },
    ],
  },
  webhookThreadId: "15551234567",
});
