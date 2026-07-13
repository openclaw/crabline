import path from "node:path";
import { chmod, link, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendRecordedInbound,
  ProviderRecorderCommittedError,
} from "../src/providers/recorder.js";
import { recordServerEvent } from "../src/servers/recorder.js";

const fsMocks = vi.hoisted(() => ({
  lock: vi.fn<(filePath: string, options?: unknown) => Promise<() => Promise<void>>>(),
  lockRelease: vi.fn<() => Promise<void>>(),
  providerDirectory: "",
  providerDirectorySync: vi.fn<(directoryPath: string) => Promise<void>>(),
  providerLstatFailure: undefined as Error | undefined,
  providerLstatFailureAfterLocks: 0,
  providerRecorderPath: "",
  providerOpen: vi.fn<(filePath: string, flags: string, mode?: number | string) => void>(),
  providerSync: vi.fn<(filePath: string) => Promise<void>>(),
  providerWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
  serverDirectory: "",
  serverDirectorySync: vi.fn<(directoryPath: string) => Promise<void>>(),
  serverFileExists: false,
  serverFileStat:
    vi.fn<() => Promise<{ dev: number; ino: number; nlink?: number; size: number }>>(),
  serverOpen: vi.fn<(filePath: string, flags: string) => void>(),
  serverStat: vi.fn<(filePath: string) => Promise<{ dev: number; ino: number; size: number }>>(),
  serverSync: vi.fn<(filePath: string) => Promise<void>>(),
  serverWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
}));

const osMocks = vi.hoisted(() => ({
  userInfo: vi.fn<typeof import("node:os").userInfo>(),
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    lock: fsMocks.lock,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  osMocks.userInfo.mockImplementation(actual.userInfo);
  return {
    ...actual,
    userInfo: osMocks.userInfo,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (
        String(args[0]) === fsMocks.providerRecorderPath &&
        fsMocks.providerLstatFailure &&
        fsMocks.lock.mock.calls.length >= fsMocks.providerLstatFailureAfterLocks
      ) {
        throw fsMocks.providerLstatFailure;
      }
      return await actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const filePath = String(args[0]);
      if (args[1] === "r" && filePath === fsMocks.serverDirectory) {
        return {
          close: async () => {},
          sync: async () => await fsMocks.serverDirectorySync(filePath),
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }
      if (args[1] === "r" && filePath === fsMocks.providerDirectory) {
        return {
          close: async () => {},
          sync: async () => await fsMocks.providerDirectorySync(filePath),
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
          stat: async () => await fsMocks.serverFileStat(),
          sync: async () => await fsMocks.serverSync(filePath),
          truncate: async () => {},
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }
      if (
        (args[1] === "a+" || args[1] === "ax+") &&
        filePath.includes("crabline-provider-recorder")
      ) {
        fsMocks.providerOpen(filePath, args[1], args[2]);
      }
      const handle = await actual.open(...args);
      if (
        (args[1] === "a+" || args[1] === "ax+") &&
        filePath.includes("crabline-provider-recorder")
      ) {
        handle.sync = async () => {
          await fsMocks.providerSync(filePath);
        };
        handle.writeFile = async (data) => {
          await fsMocks.providerWrite(filePath, String(data));
        };
      }
      return handle;
    },
    stat: async (filePath: Parameters<typeof actual.stat>[0]) => {
      if (String(filePath).includes("crabline-server-recorder")) {
        return await fsMocks.serverStat(String(filePath));
      }
      return await actual.stat(filePath);
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
  fsMocks.providerDirectory = "";
  fsMocks.providerDirectorySync.mockReset();
  fsMocks.providerDirectorySync.mockResolvedValue(undefined);
  fsMocks.providerLstatFailure = undefined;
  fsMocks.providerLstatFailureAfterLocks = 0;
  fsMocks.providerRecorderPath = "";
  fsMocks.providerOpen.mockReset();
  fsMocks.providerSync.mockReset();
  fsMocks.providerSync.mockResolvedValue(undefined);
  fsMocks.providerWrite.mockReset();
  fsMocks.serverDirectory = "";
  fsMocks.serverDirectorySync.mockReset();
  fsMocks.serverDirectorySync.mockResolvedValue(undefined);
  fsMocks.serverFileExists = false;
  fsMocks.serverFileStat.mockReset();
  fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 1, nlink: 1, size: 0 });
  fsMocks.serverOpen.mockReset();
  fsMocks.serverStat.mockReset();
  fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 1, size: 0 });
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

afterEach(() => {
  vi.unstubAllEnvs();
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
    fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
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

  it.skipIf(process.platform === "win32")(
    "preserves committed status when an identity lock release fails",
    async () => {
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-hardlink-release-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 1, nlink: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", tmpdir());
      const pathRelease = vi.fn(async () => {});
      const releaseFailure = new Error("identity lock cleanup failed");
      const identityRelease = vi.fn(async () => {
        throw releaseFailure;
      });
      fsMocks.lock.mockResolvedValueOnce(pathRelease).mockResolvedValueOnce(identityRelease);
      const observer = vi.fn();

      await expect(
        recordServerEvent({
          event: {
            at: "2026-07-12T10:00:00.000Z",
            method: "POST",
            path: "/committed-hardlink-release",
            query: {},
            type: "api",
          },
          onEvent: observer,
          recorderPath,
        }),
      ).rejects.toMatchObject({
        cause: releaseFailure,
        committed: true,
        indeterminate: false,
        name: "ServerRecorderCommittedError",
      });
      expect(observer).not.toHaveBeenCalled();
      expect(pathRelease).toHaveBeenCalledOnce();
      expect(identityRelease).toHaveBeenCalledOnce();
      expect(
        fsMocks.lock.mock.calls.some(([lockPath]) =>
          path.basename(String(lockPath)).startsWith("recorder-"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when the shared identity lock is unavailable",
    async () => {
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-shared-lock-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 1, nlink: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", tmpdir());
      const sharedFailure = Object.assign(new Error("shared lock filesystem full"), {
        code: "ENOSPC",
      });
      const pathRelease = vi.fn(async () => {});
      fsMocks.lock.mockResolvedValueOnce(pathRelease).mockRejectedValueOnce(sharedFailure);

      await expect(
        recordServerEvent({
          event: {
            at: "2026-07-12T10:00:00.000Z",
            method: "POST",
            path: "/shared-lock-unavailable",
            query: {},
            type: "api",
          },
          onEvent: undefined,
          recorderPath,
        }),
      ).rejects.toBe(sharedFailure);
      expect(fsMocks.serverWrite).not.toHaveBeenCalled();
      expect(pathRelease).toHaveBeenCalledOnce();
    },
  );

  it("rejects hardlinked server recorders without a shared lock namespace", async () => {
    const recorderPath = path.join(
      "/tmp",
      `crabline-server-recorder-hardlink-unconfigured-${process.pid}-${Date.now()}.jsonl`,
    );
    fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
    fsMocks.serverWrite.mockResolvedValue(undefined);
    fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 1, nlink: 2, size: 0 });
    const pathRelease = vi.fn(async () => {});
    fsMocks.lock.mockResolvedValueOnce(pathRelease);

    await expect(
      recordServerEvent({
        event: {
          at: "2026-07-12T10:00:00.000Z",
          method: "POST",
          path: "/hardlink-unconfigured",
          query: {},
          type: "api",
        },
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toThrow(
      "Server recorder hardlinks require CRABLINE_RECORDER_LOCK_DIR to name one shared writable lock directory for every writer.",
    );
    expect(fsMocks.serverWrite).not.toHaveBeenCalled();
    expect(pathRelease).toHaveBeenCalledOnce();
  });

  it("requires the configured server recorder lock directory to be pre-created", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "crabline-server-lock-root-"));
    const lockRoot = path.join(directory, "missing");
    const recorderPath = path.join(
      "/tmp",
      `crabline-server-recorder-lock-root-${process.pid}-${Date.now()}.jsonl`,
    );
    fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
    fsMocks.serverWrite.mockResolvedValue(undefined);
    vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", lockRoot);
    const pathRelease = vi.fn(async () => {});
    fsMocks.lock.mockResolvedValueOnce(pathRelease);

    try {
      await expect(
        recordServerEvent({
          event: {
            at: "2026-07-12T10:00:00.000Z",
            method: "POST",
            path: "/missing-lock-root",
            query: {},
            type: "api",
          },
          onEvent: undefined,
          recorderPath,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fsMocks.serverWrite).not.toHaveBeenCalled();
      expect(pathRelease).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("serializes provider inbound appends to the same JSONL file", async () => {
    const recorderPath = path.join(
      "/tmp",
      `crabline-provider-recorder-${process.pid}-${Date.now()}.jsonl`,
    );
    fsMocks.providerDirectory = await realpath(path.dirname(recorderPath));
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
      expect(fsMocks.providerDirectorySync).toHaveBeenCalledTimes(
        process.platform === "win32" ? 0 : 1,
      );
      expect(fsMocks.providerOpen.mock.calls.map(([, flags, mode]) => [flags, mode])).toEqual([
        ["ax+", 0o600],
        ["a+", 0o600],
        ["ax+", 0o600],
        ["a+", 0o600],
      ]);
      const identityLockPath = fsMocks.lock.mock.calls
        .map(([lockPath]) => String(lockPath))
        .find((lockPath) => path.basename(lockPath).startsWith("recorder-"));
      expect(identityLockPath).toBeDefined();
    } finally {
      await rm(recorderPath, { force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "repairs a UID-scoped adjacent lock namespace without an OS account entry",
    async () => {
      const tempRoot = await mkdtemp(
        path.join(tmpdir(), "crabline-provider-recorder-unknown-user-"),
      );
      const recorderPath = path.join(tempRoot, "events.jsonl");
      fsMocks.providerDirectory = await realpath(tempRoot);
      fsMocks.providerWrite.mockResolvedValue(undefined);
      const currentUserId = process.geteuid?.();
      if (currentUserId === undefined) {
        throw new Error("Expected a current user id on Unix.");
      }
      const fallbackRoot = path.join(
        fsMocks.providerDirectory,
        `.crabline-provider-recorder-locks-${currentUserId}`,
      );
      await mkdir(fallbackRoot, { mode: 0o700 });
      await chmod(fallbackRoot, 0o500);
      osMocks.userInfo.mockImplementationOnce(() => {
        throw Object.assign(new Error("unknown uid"), { code: "ENOENT" });
      });

      try {
        await expect(
          appendRecordedInbound(recorderPath, {
            author: "assistant",
            id: "unknown-user-lock-root",
            provider: "slack",
            sentAt: "2026-07-12T10:00:00.000Z",
            text: "container uid",
            threadId: "slack:C123",
          }),
        ).resolves.toMatchObject({ id: "unknown-user-lock-root" });
        const identityLockPath = fsMocks.lock.mock.calls
          .map(([lockPath]) => String(lockPath))
          .find((lockPath) => path.basename(lockPath).startsWith("recorder-"));
        expect(identityLockPath).toBeDefined();
        expect(path.dirname(identityLockPath!)).toBe(fallbackRoot);
        expect((await stat(fallbackRoot)).mode & 0o777).toBe(0o700);
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back when shared identity lock creation exhausts its filesystem",
    async () => {
      const tempRoot = await mkdtemp(
        path.join(tmpdir(), "crabline-provider-recorder-lock-fallback-"),
      );
      const recorderPath = path.join(tempRoot, "events.jsonl");
      fsMocks.providerDirectory = await realpath(tempRoot);
      fsMocks.providerWrite.mockResolvedValue(undefined);
      const sharedFailure = Object.assign(new Error("shared lock filesystem full"), {
        code: "ENOSPC",
      });
      fsMocks.lock
        .mockResolvedValueOnce(fsMocks.lockRelease)
        .mockRejectedValueOnce(sharedFailure)
        .mockResolvedValueOnce(fsMocks.lockRelease);

      try {
        await expect(
          appendRecordedInbound(recorderPath, {
            author: "assistant",
            id: "identity-lock-fallback",
            provider: "slack",
            sentAt: "2026-07-12T10:00:00.000Z",
            text: "fallback",
            threadId: "slack:C123",
          }),
        ).resolves.toMatchObject({ id: "identity-lock-fallback" });
        expect(fsMocks.lock).toHaveBeenCalledTimes(3);
        expect(path.dirname(String(fsMocks.lock.mock.calls[1]?.[0]))).not.toBe(tempRoot);
        expect(path.dirname(String(fsMocks.lock.mock.calls[2]?.[0]))).toBe(
          path.join(
            fsMocks.providerDirectory,
            `.crabline-provider-recorder-locks-${process.geteuid?.()}`,
          ),
        );
        expect(fsMocks.lockRelease).toHaveBeenCalledTimes(2);
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
      }
    },
  );

  it("releases both recorder locks when identity verification fails", async () => {
    const recorderPath = path.join(
      "/tmp",
      `crabline-provider-recorder-verification-${process.pid}-${Date.now()}.jsonl`,
    );
    fsMocks.providerDirectory = await realpath(path.dirname(recorderPath));
    fsMocks.providerRecorderPath = path.join(
      fsMocks.providerDirectory,
      path.basename(recorderPath),
    );
    fsMocks.providerLstatFailure = Object.assign(new Error("simulated identity failure"), {
      code: "EIO",
    });
    fsMocks.providerLstatFailureAfterLocks = 2;

    try {
      await expect(
        appendRecordedInbound(recorderPath, {
          author: "assistant",
          id: "identity-verification-failure",
          provider: "slack",
          sentAt: "2026-07-12T10:00:00.000Z",
          text: "verification",
          threadId: "slack:C123",
        }),
      ).rejects.toBe(fsMocks.providerLstatFailure);
      expect(fsMocks.lockRelease).toHaveBeenCalledTimes(2);
    } finally {
      await rm(recorderPath, { force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses one private UID-scoped lock namespace for hardlinked provider recorders",
    async () => {
      const recorderPath = path.join(
        "/tmp",
        `crabline-provider-recorder-hardlink-${process.pid}-${Date.now()}.jsonl`,
      );
      const aliasPath = `${recorderPath}.alias`;
      fsMocks.providerDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.providerWrite.mockResolvedValue(undefined);
      await writeFile(recorderPath, "", { mode: 0o600 });
      await link(recorderPath, aliasPath);
      const event = {
        author: "assistant" as const,
        id: "hardlink-lock-root",
        provider: "slack",
        sentAt: "2026-07-12T10:00:00.000Z",
        text: "hardlinked",
        threadId: "slack:C123",
      };

      try {
        await expect(appendRecordedInbound(aliasPath, event)).resolves.toMatchObject({
          id: event.id,
        });
        const identityLockPath = fsMocks.lock.mock.calls
          .map(([lockPath]) => String(lockPath))
          .find((lockPath) => path.basename(lockPath).startsWith("recorder-"));
        expect(identityLockPath).toBeDefined();
        expect(path.dirname(identityLockPath!)).toBe(
          path.join(userInfo().homedir, ".cache", "crabline", "locks", "provider-recorder"),
        );
        expect((await stat(path.dirname(identityLockPath!))).mode & 0o777).toBe(0o700);
      } finally {
        await rm(aliasPath, { force: true });
        await rm(recorderPath, { force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries parent durability for a newly created provider recorder",
    async () => {
      const recorderPath = path.join(
        "/tmp",
        `crabline-provider-recorder-durability-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.providerDirectory = await realpath(path.dirname(recorderPath));
      const parentSyncFailure = new Error("simulated recorder parent sync failure");
      fsMocks.providerWrite.mockResolvedValue(undefined);
      fsMocks.providerDirectorySync
        .mockRejectedValueOnce(parentSyncFailure)
        .mockResolvedValue(undefined);
      const event = {
        author: "assistant" as const,
        id: "durable",
        provider: "slack",
        sentAt: "2026-07-12T10:00:00.000Z",
        text: "durable",
        threadId: "slack:C123",
      };

      try {
        const failedAppend = appendRecordedInbound(recorderPath, event);
        await expect(failedAppend).rejects.toMatchObject({
          cause: parentSyncFailure,
          committed: true,
          indeterminate: true,
          name: "ProviderRecorderCommittedError",
        });
        await expect(failedAppend).rejects.toBeInstanceOf(ProviderRecorderCommittedError);
        await expect(
          appendRecordedInbound(recorderPath, { ...event, id: "retry" }),
        ).resolves.toMatchObject({ id: "retry" });
        expect(fsMocks.providerDirectorySync).toHaveBeenCalledTimes(2);
      } finally {
        await rm(recorderPath, { force: true });
      }
    },
  );

  it("reports lock cleanup failure without rejecting a committed provider append", async () => {
    const recorderPath = path.join(
      "/tmp",
      `crabline-provider-recorder-release-${process.pid}-${Date.now()}.jsonl`,
    );
    fsMocks.providerDirectory = await realpath(path.dirname(recorderPath));
    fsMocks.providerWrite.mockResolvedValue(undefined);
    const releaseError = new Error("simulated lock cleanup failure");
    fsMocks.lockRelease.mockRejectedValue(releaseError);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const event = {
      author: "assistant" as const,
      id: "committed-release-failure",
      provider: "slack",
      sentAt: "2026-07-12T10:00:00.000Z",
      text: "committed",
      threadId: "slack:C123",
    };

    try {
      await expect(appendRecordedInbound(recorderPath, event)).resolves.toMatchObject({
        id: event.id,
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Provider recorder append committed but lock cleanup failed"),
        {
          code: "CRABLINE_RECORDER_LOCK_CLEANUP",
          type: "ProviderRecorderWarning",
        },
      );
    } finally {
      warning.mockRestore();
      await rm(recorderPath, { force: true });
    }
  });
});
