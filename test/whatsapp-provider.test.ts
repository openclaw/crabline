import { describe, expect, it } from "vitest";
import {
  normalizeWhatsAppWebhookPayload,
  WhatsAppProviderAdapter,
} from "../src/providers/builtin/whatsapp.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

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

    expect(normalizeWhatsAppWebhookPayload(payload)).toEqual({
      author: "user",
      id: "wamid.abc123",
      raw: payload,
      text: "hello",
      threadId: "15551234567",
    });
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

    expect(normalizeWhatsAppWebhookPayload(payload)).toEqual({
      authorIsBot: false,
      id: "fallback-message",
      raw: payload,
      text: "fallback text",
      threadId: "15551234567",
    });
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
