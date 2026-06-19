import { MsTeamsProviderAdapter } from "../src/providers/builtin/msteams.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: MsTeamsProviderAdapter,
  endpointPath: "/msteams/webhook",
  platform: "msteams",
});
