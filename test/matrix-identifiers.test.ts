import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isHistoricalMatrixUserId, isMatrixEventId, isMatrixRoomId } from "../src/matrix-ids.js";
import { startOpenClawCrablineAdapter } from "../src/index.js";
import { getBuiltinTargetCodec } from "../src/providers/target-normalizers.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const malformedRoomId = "!room\uD800:matrix.test";
const malformedEventId = "$event\uD800:matrix.test";
const validRoomId = "!room🦀:matrix.test";

const validators = [
  ["!", isMatrixRoomId],
  ["$", isMatrixEventId],
  ["@", isHistoricalMatrixUserId],
] as const;

describe("Matrix Unicode identifiers", () => {
  it.each(["\uD800", "\uDBFF", "\uDC00", "\uDFFF", "\uD800x"])(
    "rejects an unpaired surrogate in scoped identifiers: %j",
    (suffix) => {
      for (const [sigil, validate] of validators) {
        expect(validate(sigil + "name" + suffix + ":matrix.test")).toBe(false);
      }
    },
  );

  it.each(["🦀", "\uD800\uDC00", "\uDBFF\uDFFF", "a🦀b"])(
    "preserves well-formed astral characters in scoped identifiers: %s",
    (suffix) => {
      for (const [sigil, validate] of validators) {
        expect(validate(sigil + "name" + suffix + ":matrix.test")).toBe(true);
      }
    },
  );

  it("rejects malformed fixture room and thread targets", () => {
    const codec = getBuiltinTargetCodec("matrix");
    expect(() => codec.normalize({ id: malformedRoomId, metadata: {} })).toThrow(/Matrix room_id/u);
    expect(() =>
      codec.normalize({ id: validRoomId, metadata: {}, threadId: malformedEventId }),
    ).toThrow(/Matrix event_id/u);
    expect(codec.normalize({ id: validRoomId, metadata: {} }).channelId).toBe(validRoomId);
  });

  it("rejects malformed bridge and provider ingress IDs while preserving valid rooms", async () => {
    const directory = await createTempDir();
    const adapter = await startOpenClawCrablineAdapter({
      channel: "matrix",
      recorderPath: path.join(directory, "matrix.jsonl"),
    });
    try {
      const manifest = adapter.manifest;
      if (manifest.provider !== "matrix") {
        throw new Error("Expected a Matrix provider.");
      }
      expect(() => adapter.createAgentDelivery({ target: malformedRoomId })).toThrow(
        /native room IDs/u,
      );
      expect(() =>
        adapter.createInbound({
          input: {
            conversation: { id: validRoomId, kind: "group" },
            senderId: "@alice:matrix.test",
            text: "invalid thread",
            threadId: malformedEventId,
          },
        }),
      ).toThrow(/native event IDs/u);

      const inject = (roomId: string) =>
        fetch(manifest.endpoints.adminInboundUrl, {
          body: JSON.stringify({ roomId, senderId: "@alice:matrix.test", text: "Unicode room" }),
          headers: {
            "content-type": "application/json",
            "X-Crabline-Admin-Token": manifest.adminToken,
          },
          method: "POST",
        });
      expect((await inject(malformedRoomId)).status).toBe(400);
      expect((await inject(validRoomId)).status).toBe(200);
      const response = await fetch(manifest.baseUrl + "/_matrix/client/v3/joined_rooms", {
        headers: { authorization: "Bearer " + manifest.accessToken },
      });
      const payload = (await response.json()) as { joined_rooms: string[] };
      expect(payload.joined_rooms).toContain(validRoomId);
      expect(payload.joined_rooms).not.toContain(malformedRoomId);
      expect(await fs.readFile(path.join(directory, "matrix.jsonl"), "utf8")).toContain(
        "Unicode room",
      );
    } finally {
      await adapter.close();
      await disposeTempDir(directory);
    }
  });
});
