import { WhatsAppProviderAdapter } from "../src/providers/builtin/whatsapp.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

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
