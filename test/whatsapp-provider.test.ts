import { WhatsAppProviderAdapter } from "../src/providers/builtin/whatsapp.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: WhatsAppProviderAdapter,
  endpointPath: "/whatsapp/webhook",
  platform: "whatsapp",
});
