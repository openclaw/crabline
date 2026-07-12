import { afterEach, describe, expect, it } from "vitest";
import {
  CRABLINE_SERVER_CHANNELS,
  startCrablineServer,
  type StartedCrablineServer,
  type StartCrablineServerParams,
} from "../src/servers/index.js";

const servers: StartedCrablineServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("provider server dispatcher", () => {
  it("routes every declared server channel", async () => {
    for (const channel of CRABLINE_SERVER_CHANNELS) {
      const server = await startCrablineServer({ channel } as StartCrablineServerParams);
      servers.push(server);
      expect(server.manifest.provider).toBe(channel);
    }
  });

  it("rejects unknown channels", async () => {
    await expect(
      startCrablineServer({ channel: "unknown" } as unknown as StartCrablineServerParams),
    ).rejects.toThrow("Unsupported server channel");
  });
});
