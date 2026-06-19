import { GoogleChatProviderAdapter } from "../src/providers/builtin/googlechat.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: GoogleChatProviderAdapter,
  endpointPath: "/googlechat/webhook",
  platform: "googlechat",
});
