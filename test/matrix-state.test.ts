import path from "node:path";
import { createClient } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { startMatrixServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

describe("Matrix state queries", () => {
  it("returns the same state through sync and native SDK event queries", async () => {
    const directory = await createTempDir();
    const roomId = "!state:matrix.test";
    const server = await startMatrixServer({
      recorderPath: path.join(directory, "matrix.jsonl"),
      roomId,
    });
    try {
      const { manifest } = server;
      const client = createClient({
        accessToken: manifest.accessToken,
        baseUrl: manifest.baseUrl,
        userId: manifest.botUserId,
      });
      const response = await fetch(manifest.endpoints.syncUrl + "?timeout=0", {
        headers: { authorization: "Bearer " + manifest.accessToken },
      });
      const sync = (await response.json()) as {
        rooms: {
          join: Record<
            string,
            { state: { events: { content: unknown; state_key: string; type: string }[] } }
          >;
        };
      };
      const events = sync.rooms.join[roomId]!.state.events;
      expect(events.map((event) => event.type)).toContain("m.room.create");
      for (const event of events) {
        await expect(client.getStateEvent(roomId, event.type, event.state_key)).resolves.toEqual(
          event.content,
        );
      }
      await expect(client.getStateEvent(roomId, "m.room.unknown", "")).rejects.toMatchObject({
        errcode: "M_NOT_FOUND",
        httpStatus: 404,
      });
      await expect(
        client.getStateEvent(roomId, "m.room.member", "@missing:matrix.test"),
      ).rejects.toMatchObject({
        errcode: "M_NOT_FOUND",
        error: "Unknown room member",
        httpStatus: 404,
      });
    } finally {
      await server.close();
      await disposeTempDir(directory);
    }
  });
});
