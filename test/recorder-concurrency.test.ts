import path from "node:path";
import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import { recordServerEvent } from "../src/servers/recorder.js";

const fsMocks = vi.hoisted(() => ({
  providerSync: vi.fn<(filePath: string) => Promise<void>>(),
  providerWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
  serverWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === "a" && String(args[0]).includes("crabline-server-recorder")) {
        const filePath = String(args[0]);
        return {
          appendFile: async (data: string) => await fsMocks.serverWrite(filePath, data),
          chmod: async () => {},
          close: async () => {},
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }
      const handle = await actual.open(...args);
      if (args[1] === "a+" && String(args[0]).includes("crabline-provider-recorder")) {
        handle.sync = async () => {
          await fsMocks.providerSync(String(args[0]));
        };
        handle.writeFile = async (data) => {
          await fsMocks.providerWrite(String(args[0]), String(data));
        };
      }
      return handle;
    },
  };
});

type PendingWrite = {
  data: string;
  resolve: () => void;
};

let pendingWrites: PendingWrite[] = [];

beforeEach(() => {
  pendingWrites = [];
  fsMocks.providerSync.mockReset();
  fsMocks.providerSync.mockResolvedValue(undefined);
  fsMocks.providerWrite.mockReset();
  fsMocks.serverWrite.mockReset();
  fsMocks.serverWrite.mockImplementation(
    async (_filePath, data) =>
      await new Promise<void>((resolve) => {
        pendingWrites.push({ data, resolve });
      }),
  );
  fsMocks.providerWrite.mockImplementation(
    async (_filePath, data) =>
      await new Promise<void>((resolve) => {
        pendingWrites.push({ data, resolve });
      }),
  );
});

async function expectSerializedWrites(
  write: { mock: { calls: unknown[][] } },
  first: Promise<unknown>,
  second: Promise<unknown>,
) {
  await vi.waitFor(() => expect(write.mock.calls).toHaveLength(1));
  expect(pendingWrites).toHaveLength(1);

  pendingWrites[0]!.resolve();
  await vi.waitFor(() => expect(write.mock.calls).toHaveLength(2));
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
    await vi.waitFor(() => expect(fsMocks.serverWrite).toHaveBeenCalledTimes(1));
    const second = recordServerEvent({
      event: secondEvent,
      onEvent: undefined,
      recorderPath,
    });

    await expectSerializedWrites(fsMocks.serverWrite, first, second);
    expect(pendingWrites.map((write) => write.data)).toEqual([
      `${JSON.stringify(firstEvent)}\n`,
      `${JSON.stringify(secondEvent)}\n`,
    ]);
  });

  it("serializes provider inbound appends to the same JSONL file", async () => {
    const recorderPath = path.join(
      "/tmp",
      `crabline-provider-recorder-${process.pid}-${Date.now()}.jsonl`,
    );
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
    await vi.waitFor(() => expect(fsMocks.providerWrite).toHaveBeenCalledTimes(1));
    const second = appendRecordedInbound(recorderPath, secondEvent);

    try {
      await expectSerializedWrites(fsMocks.providerWrite, first, second);
      expect(pendingWrites.map((write) => JSON.parse(write.data) as { id: string })).toEqual([
        expect.objectContaining({ id: "first" }),
        expect.objectContaining({ id: "second" }),
      ]);
      expect(fsMocks.providerSync).toHaveBeenCalledTimes(2);
    } finally {
      await rm(recorderPath, { force: true });
    }
  });
});
