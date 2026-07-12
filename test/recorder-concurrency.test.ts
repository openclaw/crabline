import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import { recordServerEvent } from "../src/servers/recorder.js";

const fsMocks = vi.hoisted(() => ({
  appendFile: vi.fn<(filePath: string, data: string, encoding: string) => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, appendFile: fsMocks.appendFile };
});

type PendingWrite = {
  data: string;
  resolve: () => void;
};

let pendingWrites: PendingWrite[] = [];

beforeEach(() => {
  pendingWrites = [];
  fsMocks.appendFile.mockReset();
  fsMocks.appendFile.mockImplementation(
    async (_filePath, data) =>
      await new Promise<void>((resolve) => {
        pendingWrites.push({ data, resolve });
      }),
  );
});

async function expectSerializedWrites(first: Promise<unknown>, second: Promise<unknown>) {
  await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1));
  expect(pendingWrites).toHaveLength(1);

  pendingWrites[0]!.resolve();
  await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(2));
  expect(pendingWrites).toHaveLength(2);

  pendingWrites[1]!.resolve();
  await Promise.all([first, second]);
}

describe("recorder append serialization", () => {
  it("serializes server event appends to the same JSONL file", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder.jsonl");
    const firstEvent = {
      at: "2026-07-12T10:00:00.000Z",
      method: "GET",
      path: "/first",
      query: {},
      type: "api" as const,
    };
    const secondEvent = {
      ...firstEvent,
      path: "/second",
    };

    const first = recordServerEvent({
      event: firstEvent,
      onEvent: undefined,
      recorderPath,
    });
    await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1));
    const second = recordServerEvent({
      event: secondEvent,
      onEvent: undefined,
      recorderPath,
    });

    await expectSerializedWrites(first, second);
    expect(pendingWrites.map((write) => write.data)).toEqual([
      `${JSON.stringify(firstEvent)}\n`,
      `${JSON.stringify(secondEvent)}\n`,
    ]);
  });

  it("serializes provider inbound appends to the same JSONL file", async () => {
    const recorderPath = path.join("/tmp", "crabline-provider-recorder.jsonl");
    const firstEvent = {
      author: "assistant" as const,
      id: "first",
      provider: "slack",
      sentAt: "2026-07-12T10:00:00.000Z",
      text: "first",
      threadId: "slack:C123",
    };
    const secondEvent = {
      ...firstEvent,
      id: "second",
      text: "second",
    };

    const first = appendRecordedInbound(recorderPath, firstEvent);
    await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1));
    const second = appendRecordedInbound(recorderPath, secondEvent);

    await expectSerializedWrites(first, second);
    expect(pendingWrites.map((write) => JSON.parse(write.data) as { id: string })).toEqual([
      expect.objectContaining({ id: "first" }),
      expect.objectContaining({ id: "second" }),
    ]);
  });
});
