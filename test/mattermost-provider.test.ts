import { MattermostProviderAdapter } from "../src/providers/builtin/mattermost.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: MattermostProviderAdapter,
  endpointPath: "/mattermost/webhook",
  platform: "mattermost",
});
