import { IMessageProviderAdapter } from "../src/providers/builtin/imessage.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: IMessageProviderAdapter,
  endpointPath: "/imessage/webhook",
  platform: "imessage",
});
