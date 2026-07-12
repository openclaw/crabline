import { describe, expect, it } from "vitest";
import {
  normalizeWhatsAppWebhookPayload,
  WhatsAppProviderAdapter,
} from "../src/providers/builtin/whatsapp.js";
import {
  createLocalMockConfig,
  createProviderContext,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

describe("WhatsApp webhook normalizer", () => {
  it("normalizes text messages with the provider message id", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.abc123",
                    text: { body: "hello" },
                  },
                ],
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
        raw: payload,
        text: "hello",
        threadId: "15551234567",
      },
    ]);
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

  it("preserves all valid messages after malformed and unsupported batch items", async () => {
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
      const since = new Date(Date.now() - 1000).toISOString();

      const response = await fetch(endpoint!, {
        body: JSON.stringify({
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
                        id: "wamid.unrelated",
                        text: { body: "unrelated valid" },
                        type: "text",
                      },
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
            {
              changes: [
                {
                  value: {
                    messages: [
                      { from: "15550000001", text: {}, type: "text" },
                      {
                        from: "15557654321",
                        id: "wamid.second",
                        text: { body: `second valid ${nonce}` },
                        type: "text",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ids: ["wamid.unrelated", "wamid.first", "wamid.second"],
        ok: true,
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
        id: "wamid.first",
        text: `first valid ${nonce}`,
      });
      await expect(
        provider.waitForInbound({
          ...context,
          nonce,
          since,
          threadId: "15557654321",
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        id: "wamid.second",
        text: `second valid ${nonce}`,
      });
    } finally {
      await provider.cleanup();
    }
  });
});

runLocalMockProviderContract({
  Adapter: WhatsAppProviderAdapter,
  endpointPath: "/whatsapp/webhook",
  expectedChannelId: "15551234567",
  platform: "whatsapp",
  target: { id: "15551234567", metadata: {} },
  webhookExpected: { author: "user", id: "wamid.abc123", text: "reply nonce-2" },
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
                  text: { body: "reply nonce-2" },
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
