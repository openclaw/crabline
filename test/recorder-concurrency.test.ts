import path from "node:path";
import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import { recordServerEvent } from "../src/servers/recorder.js";

const fsMocks = vi.hoisted(() => ({
  lock: vi.fn<() => Promise<() => Promise<void>>>(),
  lockRelease: vi.fn<() => Promise<void>>(),
  providerSync: vi.fn<(filePath: string) => Promise<void>>(),
  providerWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
  serverDirectory: "",
  serverDirectorySync: vi.fn<(directoryPath: string) => Promise<void>>(),
  serverFileExists: false,
  serverOpen: vi.fn<(filePath: string, flags: string) => void>(),
  serverSync: vi.fn<(filePath: string) => Promise<void>>(),
  serverWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    lock: fsMocks.lock,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const filePath = String(args[0]);
      if (args[1] === "r" && filePath === fsMocks.serverDirectory) {
        return {
          close: async () => {},
          sync: async () => await fsMocks.serverDirectorySync(filePath),
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }
      if (
        (args[1] === "a+" || args[1] === "ax+") &&
        filePath.includes("crabline-server-recorder")
      ) {
        fsMocks.serverOpen(filePath, args[1]);
        if (args[1] === "ax+" && fsMocks.serverFileExists) {
          throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
        }
        fsMocks.serverFileExists = true;
        return {
          appendFile: async (data: string) => await fsMocks.serverWrite(filePath, data),
          chmod: async () => {},
          close: async () => {},
          read: async (buffer: Buffer) => ({ buffer, bytesRead: 0 }),
          stat: async () => ({ dev: 1, ino: 1, size: 0 }),
          sync: async () => await fsMocks.serverSync(filePath),
          truncate: async () => {},
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
let pendingWriteWaiters: Array<{ count: number; resolve: () => void }> = [];

function addPendingWrite(data: string, resolve: () => void): void {
  pendingWrites.push({ data, resolve });
  const readyWaiters = pendingWriteWaiters.filter((waiter) => pendingWrites.length >= waiter.count);
  pendingWriteWaiters = pendingWriteWaiters.filter((waiter) => pendingWrites.length < waiter.count);
  for (const waiter of readyWaiters) {
    waiter.resolve();
  }
}

async function waitForPendingWrites(count: number): Promise<void> {
  if (pendingWrites.length >= count) {
    return;
  }
  await new Promise<void>((resolve) => {
    pendingWriteWaiters.push({ count, resolve });
  });
}

beforeEach(() => {
  pendingWrites = [];
  pendingWriteWaiters = [];
  fsMocks.lockRelease.mockReset();
  fsMocks.lockRelease.mockResolvedValue();
  fsMocks.lock.mockReset();
  fsMocks.lock.mockResolvedValue(fsMocks.lockRelease);
  fsMocks.providerSync.mockReset();
  fsMocks.providerSync.mockResolvedValue(undefined);
  fsMocks.providerWrite.mockReset();
  fsMocks.serverDirectory = "";
  fsMocks.serverDirectorySync.mockReset();
  fsMocks.serverDirectorySync.mockResolvedValue(undefined);
  fsMocks.serverFileExists = false;
  fsMocks.serverOpen.mockReset();
  fsMocks.serverSync.mockReset();
  fsMocks.serverSync.mockResolvedValue(undefined);
  fsMocks.serverWrite.mockReset();
  fsMocks.serverWrite.mockImplementation(
    async (_filePath, data) =>
      await new Promise<void>((resolve) => {
        addPendingWrite(data, resolve);
      }),
  );
  fsMocks.providerWrite.mockImplementation(
    async (_filePath, data) =>
      await new Promise<void>((resolve) => {
        addPendingWrite(data, resolve);
      }),
  );
});

async function expectSerializedWrites(
  write: { mock: { calls: unknown[][] } },
  first: Promise<unknown>,
  second: Promise<unknown>,
) {
  await waitForPendingWrites(1);
  expect(write.mock.calls).toHaveLength(1);
  expect(pendingWrites).toHaveLength(1);

  pendingWrites[0]!.resolve();
  await waitForPendingWrites(2);
  expect(write.mock.calls).toHaveLength(2);
  expect(pendingWrites).toHaveLength(2);

  pendingWrites[1]!.resolve();
  await Promise.all([first, second]);
}

describe("recorder append serialization", () => {
  it("serializes server event appends to the same JSONL file", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder.jsonl");
    fsMocks.serverDirectory = path.dirname(recorderPath);
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
      onEvent: () => undefined,
      recorderPath,
    });
    await waitForPendingWrites(1);
    expect(fsMocks.serverWrite).toHaveBeenCalledTimes(1);
    const second = recordServerEvent({
      event: secondEvent,
      onEvent: () => undefined,
      recorderPath,
    });

    await expectSerializedWrites(fsMocks.serverWrite, first, second);
    expect(pendingWrites.map((write) => write.data)).toEqual([
      `${JSON.stringify(firstEvent)}\n`,
      `${JSON.stringify(secondEvent)}\n`,
    ]);
    expect(fsMocks.serverSync).toHaveBeenCalledTimes(2);
    expect(fsMocks.serverDirectorySync).toHaveBeenCalledOnce();
    expect(fsMocks.lock).toHaveBeenCalledTimes(2);
    expect(fsMocks.serverOpen.mock.calls.map(([, flags]) => flags)).toEqual(["ax+", "ax+", "a+"]);
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
