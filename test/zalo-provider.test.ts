import { ZaloProviderAdapter } from "../src/providers/builtin/zalo.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: ZaloProviderAdapter,
  endpointPath: "/zalo/webhook",
  platform: "zalo",
});
