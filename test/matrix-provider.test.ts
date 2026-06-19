import { MatrixProviderAdapter } from "../src/providers/builtin/matrix.js";
import { runLocalMockProviderContract } from "./local-mock-provider-helpers.js";

runLocalMockProviderContract({
  Adapter: MatrixProviderAdapter,
  endpointPath: "/matrix/webhook",
  platform: "matrix",
});
