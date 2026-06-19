import { SlackProviderAdapter } from "../src/providers/builtin/slack.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: SlackProviderAdapter,
  endpointPath: "/slack/events",
  endpointText: "events endpoint",
  platform: "slack",
});
