import { FeishuProviderAdapter } from "../src/providers/builtin/feishu.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: FeishuProviderAdapter,
  endpointPath: "/feishu/webhook",
  platform: "feishu",
});
