import path from "node:path";
import fs, { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  providerDeniedDirectory: "",
  providerDirectoryOpen: vi.fn<(directoryPath: string) => void>(),
  providerDirectorySync: vi.fn<(directoryPath: string) => Promise<void>>(),
  providerLstatFailure: undefined as Error | undefined,
  providerLstatFailureAfterLocks: 0,
  providerLstatFailureAfterWrites: 0,
  providerLogicalPath: "",
  providerRealpathFailure: undefined as Error | undefined,
  providerRealpathFailureAfterWrites: 0,
  providerRecorderPath: "",
  providerOpen: vi.fn<(filePath: string, flags: number | string, mode?: number | string) => void>(),
  providerSync: vi.fn<(filePath: string) => Promise<void>>(),
  providerWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
  serverDirectory: "",
  serverDirectorySync: vi.fn<(directoryPath: string) => Promise<void>>(),
  serverFileExists: false,
  serverFileStat:
    vi.fn<() => Promise<{ dev: number; ino: number; nlink?: number; size: number }>>(),
  serverLockRootClose: vi.fn<() => void>(),
  serverLockRootPath: "",
  serverSharedLockAfterMkdir: vi.fn<(filePath: string) => Promise<void>>(),
  serverOpen: vi.fn<(filePath: string, flags: number | string) => void>(),
  serverStat: vi.fn<(filePath: string) => Promise<{ dev: number; ino: number; size: number }>>(),
  serverSync: vi.fn<(filePath: string) => Promise<void>>(),
  serverWrite: vi.fn<(filePath: string, data: string) => Promise<void>>(),
}));

const serverRecorderExistingOpenFlags =
  fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
const providerRecorderCreateOpenFlags =
  fsConstants.O_RDWR |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NONBLOCK |
  fsConstants.O_NOFOLLOW;
const providerRecorderExistingOpenFlags =
  fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;

const osMocks = vi.hoisted(() => ({
  userInfo: vi.fn<typeof import("node:os").userInfo>(),
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    lock: async (filePath: string, options?: unknown) => {
      const release = await fsMocks.lock(filePath, options);
      const configuredRoot = process.env.CRABLINE_RECORDER_LOCK_DIR?.trim();
      if (!configuredRoot || !filePath.startsWith(`${configuredRoot}${path.sep}recorder-`)) {
        return release;
      }
      const lockDirectory = `${filePath}.lock`;
      const lockFileSystem = (options as { fs: typeof import("node:fs") }).fs;
      await new Promise<void>((resolve, reject) => {
        lockFileSystem.mkdir(lockDirectory, (error) => (error ? reject(error) : resolve()));
      });
      await fsMocks.serverSharedLockAfterMkdir(filePath);
      return async () => {
        let removalError: unknown;
        await new Promise<void>((resolve) => {
          lockFileSystem.rmdir(lockDirectory, (error) => {
            if (error && error.code !== "ENOENT") {
              removalError = error;
            }
            resolve();
          });
        });
        try {
          await release();
        } catch (error) {
          if (removalError !== undefined) {
            const aggregateError = new AggregateError(
              [removalError, error],
              "Mock lock cleanup failed.",
            );
            aggregateError.cause = error;
            throw aggregateError;
          }
          throw error;
        }
        if (removalError !== undefined) {
          throw removalError;
        }
      };
    },
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
      if (process.platform === "win32" && String(args[0]).includes("crabline-server-recorder")) {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
        } as Awaited<ReturnType<typeof actual.lstat>>;
      }
      if (
        String(args[0]) === fsMocks.providerRecorderPath &&
        fsMocks.providerLstatFailure &&
        fsMocks.lock.mock.calls.length >= fsMocks.providerLstatFailureAfterLocks &&
        fsMocks.providerWrite.mock.calls.length >= fsMocks.providerLstatFailureAfterWrites
      ) {
        throw fsMocks.providerLstatFailure;
      }
      return await actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const filePath = String(args[0]);
      if (args[1] === "r") {
        fsMocks.providerDirectoryOpen(filePath);
      }
      if (args[1] === "r" && filePath === fsMocks.providerDeniedDirectory) {
        throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
      }
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
      if (filePath === fsMocks.serverLockRootPath) {
        const handle = await actual.open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          fsMocks.serverLockRootClose();
          await close();
        };
        return handle;
      }
      if (
        (args[1] === "a+" || args[1] === "ax+" || args[1] === serverRecorderExistingOpenFlags) &&
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
          write: async (buffer: Buffer, offset: number, length: number) => {
            await fsMocks.serverWrite(
              filePath,
              buffer.subarray(offset, offset + length).toString("utf8"),
            );
            return { buffer, bytesWritten: length };
          },
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }
      const providerRecorderOpen =
        filePath.includes("crabline-provider-recorder") &&
        (args[1] === "r+" ||
          args[1] === "wx+" ||
          args[1] === providerRecorderCreateOpenFlags ||
          args[1] === providerRecorderExistingOpenFlags);
      if (providerRecorderOpen) {
        fsMocks.providerOpen(filePath, args[1]!, args[2]);
      }
      const handle = await actual.open(...args);
      if (providerRecorderOpen) {
        handle.sync = async () => {
          await fsMocks.providerSync(filePath);
        };
        handle.writeFile = async (data) => {
          await fsMocks.providerWrite(filePath, String(data));
        };
      }
      return handle;
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (
        String(args[0]) === fsMocks.providerLogicalPath &&
        fsMocks.providerRealpathFailure &&
        fsMocks.providerWrite.mock.calls.length >= fsMocks.providerRealpathFailureAfterWrites
      ) {
        throw fsMocks.providerRealpathFailure;
      }
      return await actual.realpath(...args);
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
  fsMocks.providerDeniedDirectory = "";
  fsMocks.providerDirectoryOpen.mockReset();
  fsMocks.providerDirectorySync.mockReset();
  fsMocks.providerDirectorySync.mockResolvedValue(undefined);
  fsMocks.providerLstatFailure = undefined;
  fsMocks.providerLstatFailureAfterLocks = 0;
  fsMocks.providerLstatFailureAfterWrites = 0;
  fsMocks.providerLogicalPath = "";
  fsMocks.providerRealpathFailure = undefined;
  fsMocks.providerRealpathFailureAfterWrites = 0;
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
  fsMocks.serverLockRootClose.mockReset();
  fsMocks.serverLockRootPath = "";
  fsMocks.serverSharedLockAfterMkdir.mockReset();
  fsMocks.serverSharedLockAfterMkdir.mockResolvedValue();
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
    osMocks.userInfo.mockClear();
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
    expect(fsMocks.serverDirectorySync).toHaveBeenCalledTimes(2);
    expect(fsMocks.lock).toHaveBeenCalledTimes(4);
    const unixIdentityLockPaths = fsMocks.lock.mock.calls
      .map(([lockPath]) => String(lockPath))
      .filter((lockPath) => path.basename(lockPath) === "recorder-1-1");
    expect(unixIdentityLockPaths).toEqual(
      process.platform === "win32" ? [] : [unixIdentityLockPaths[0]!, unixIdentityLockPaths[0]!],
    );
    expect(fsMocks.serverOpen.mock.calls.map(([, flags]) => flags)).toEqual([
      "ax+",
      "ax+",
      process.platform === "win32" ? "r+" : serverRecorderExistingOpenFlags,
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "uses one home lock namespace without changing cache permissions",
    async () => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "crabline-lock-home-"));
      const cacheDirectory = path.join(homeDirectory, ".cache");
      await mkdir(cacheDirectory, { mode: 0o755 });
      await chmod(cacheDirectory, 0o755);
      const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
      osMocks.userInfo.mockImplementationOnce(() => ({
        ...actualOs.userInfo(),
        homedir: homeDirectory,
      }));
      const recorderPath = path.join("/tmp", "crabline-server-recorder-runtime.jsonl");
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);

      try {
        await recordServerEvent({
          event: {
            at: "2026-07-12T10:00:00.000Z",
            method: "POST",
            path: "/runtime-lock-root",
            query: {},
            type: "api",
          },
          onEvent: () => undefined,
          recorderPath,
        });

        const identityLockPath = fsMocks.lock.mock.calls
          .map(([lockPath]) => String(lockPath))
          .find((lockPath) => path.basename(lockPath) === "recorder-1-1");
        expect(path.dirname(identityLockPath!)).toBe(
          path.join(await realpath(cacheDirectory), "crabline", "locks", "server-recorder"),
        );
        expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o755);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "normalizes a newly created home cache under a restrictive umask",
    async () => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "crabline-lock-home-create-"));
      const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
      osMocks.userInfo.mockImplementationOnce(() => ({
        ...actualOs.userInfo(),
        homedir: homeDirectory,
      }));
      const recorderPath = path.join("/tmp", "crabline-server-recorder-cache-create.jsonl");
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      const previousUmask = process.umask(0o777);

      try {
        await recordServerEvent({
          event: {
            at: "2026-07-12T10:00:00.000Z",
            method: "POST",
            path: "/created-cache-lock-root",
            query: {},
            type: "api",
          },
          onEvent: () => undefined,
          recorderPath,
        });
        expect((await stat(path.join(homeDirectory, ".cache"))).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(previousUmask);
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a lock namespace beneath a peer-writable non-sticky ancestor",
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), "crabline-lock-ancestry-"));
      const unsafeParent = path.join(tempRoot, "unsafe");
      const homeDirectory = path.join(unsafeParent, "home");
      await mkdir(homeDirectory, { mode: 0o700, recursive: true });
      await chmod(unsafeParent, 0o777);
      const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
      osMocks.userInfo.mockImplementationOnce(() => ({
        ...actualOs.userInfo(),
        homedir: homeDirectory,
      }));
      fsMocks.serverDirectory = await realpath(path.dirname("/tmp/server-recorder.jsonl"));
      fsMocks.serverWrite.mockResolvedValue(undefined);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/unsafe-lock-root",
              query: {},
              type: "api",
            },
            onEvent: () => undefined,
            recorderPath: "/tmp/server-recorder.jsonl",
          }),
        ).rejects.toThrow("parent namespace is not trusted");
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
      }
    },
  );

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
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-release-lock-"));
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", await realpath(lockRoot));
      const pathRelease = vi.fn(async () => {});
      const localIdentityRelease = vi.fn(async () => {});
      const releaseFailure = new Error("identity lock cleanup failed");
      const sharedIdentityRelease = vi.fn(async () => {
        throw releaseFailure;
      });
      fsMocks.lock
        .mockResolvedValueOnce(pathRelease)
        .mockResolvedValueOnce(localIdentityRelease)
        .mockResolvedValueOnce(sharedIdentityRelease);
      const observer = vi.fn();

      try {
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
        expect(localIdentityRelease).toHaveBeenCalledOnce();
        expect(sharedIdentityRelease).toHaveBeenCalledOnce();
        expect(
          fsMocks.lock.mock.calls.some(([lockPath]) =>
            path.basename(String(lockPath)).startsWith("recorder-"),
          ),
        ).toBe(true);
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
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
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-unavailable-lock-"));
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", await realpath(lockRoot));
      const sharedFailure = Object.assign(new Error("shared lock filesystem full"), {
        code: "ENOSPC",
      });
      const pathRelease = vi.fn(async () => {});
      const localIdentityRelease = vi.fn(async () => {});
      fsMocks.lock
        .mockResolvedValueOnce(pathRelease)
        .mockResolvedValueOnce(localIdentityRelease)
        .mockRejectedValueOnce(sharedFailure);

      try {
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
        expect(localIdentityRelease).toHaveBeenCalledOnce();
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "locks single-link recorders in the configured shared namespace",
    async () => {
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-shared-lock-"));
      const canonicalLockRoot = await realpath(lockRoot);
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-single-link-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/single-link-shared-lock",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).resolves.toBeUndefined();

        expect(fsMocks.lock).toHaveBeenCalledTimes(3);
        expect(fsMocks.lock.mock.calls.map(([lockPath]) => String(lockPath))).toContain(
          path.join(canonicalLockRoot, "recorder-2"),
        );
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a configured shared lock root replaced during lock acquisition",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "crabline-server-root-race-"));
      const lockRoot = path.join(directory, "shared-locks");
      const displacedRoot = `${lockRoot}.displaced`;
      const replacementRoot = `${lockRoot}.replacement`;
      await mkdir(lockRoot, { mode: 0o700 });
      const canonicalLockRoot = await realpath(lockRoot);
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-root-race-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);
      const pathRelease = vi.fn(async () => {});
      const localIdentityRelease = vi.fn(async () => {});
      const sharedIdentityRelease = vi.fn(async () => {});
      fsMocks.lock
        .mockResolvedValueOnce(pathRelease)
        .mockResolvedValueOnce(localIdentityRelease)
        .mockImplementationOnce(async () => {
          await rm(displacedRoot, { force: true, recursive: true });
          await rm(replacementRoot, { force: true, recursive: true });
          await rename(lockRoot, displacedRoot);
          await mkdir(lockRoot, { mode: 0o700 });
          return sharedIdentityRelease;
        });
      fsMocks.serverSharedLockAfterMkdir.mockImplementationOnce(async () => {
        await rename(lockRoot, replacementRoot);
        await rename(displacedRoot, lockRoot);
      });

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/replaced-shared-lock-root",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).rejects.toMatchObject({
          cause: {
            message: "Server recorder shared lock artifact changed during acquisition.",
          },
        });

        expect(fsMocks.serverWrite).not.toHaveBeenCalled();
        expect(pathRelease).toHaveBeenCalledOnce();
        expect(localIdentityRelease).toHaveBeenCalledOnce();
        expect(sharedIdentityRelease).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a configured shared lock artifact replaced after creation",
    async () => {
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-artifact-race-"));
      const canonicalLockRoot = await realpath(lockRoot);
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-artifact-race-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);
      fsMocks.serverSharedLockAfterMkdir.mockImplementationOnce(async (lockTarget) => {
        const lockDirectory = `${lockTarget}.lock`;
        await rename(lockDirectory, `${lockDirectory}.displaced`);
        await mkdir(lockDirectory, { mode: 0o700 });
      });

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/replaced-shared-lock-artifact",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).rejects.toMatchObject({
          cause: {
            message: "Server recorder shared lock artifact changed during acquisition.",
          },
        });

        expect(fsMocks.serverWrite).not.toHaveBeenCalled();
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "closes a configured shared lock root when the local identity lock fails",
    async () => {
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-root-close-"));
      const canonicalLockRoot = await realpath(lockRoot);
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-root-close-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverLockRootPath = canonicalLockRoot;
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);
      const pathRelease = vi.fn(async () => {});
      const localFailure = Object.assign(new Error("local identity lock denied"), {
        code: "EACCES",
      });
      fsMocks.lock.mockResolvedValueOnce(pathRelease).mockRejectedValueOnce(localFailure);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/local-lock-failure",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).rejects.toBe(localFailure);

        expect(fsMocks.serverWrite).not.toHaveBeenCalled();
        expect(fsMocks.serverLockRootClose).toHaveBeenCalledOnce();
        expect(pathRelease).toHaveBeenCalledOnce();
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps configured and local identity locks distinct when their roots match",
    async () => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "crabline-server-lock-home-"));
      const lockRoot = path.join(homeDirectory, ".cache", "crabline", "locks", "server-recorder");
      await mkdir(lockRoot, { mode: 0o700, recursive: true });
      const canonicalLockRoot = await realpath(lockRoot);
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-aliased-lock-root-${process.pid}-${Date.now()}.jsonl`,
      );
      const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
      osMocks.userInfo.mockImplementationOnce(() => ({
        ...actualOs.userInfo(),
        homedir: homeDirectory,
      }));
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/aliased-lock-root",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).resolves.toBeUndefined();

        expect(fsMocks.lock.mock.calls.map(([lockPath]) => String(lockPath))).toEqual([
          path.join(fsMocks.serverDirectory, path.basename(recorderPath)),
          path.join(canonicalLockRoot, "recorder-1-2"),
          path.join(canonicalLockRoot, "recorder-2"),
        ]);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
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

  it.skipIf(process.platform === "win32")(
    "rejects configured server recorder lock roots in a replaceable namespace",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "crabline-server-lock-namespace-"));
      const unsafeParent = path.join(directory, "unsafe");
      const lockRoot = path.join(unsafeParent, "shared-locks");
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-unsafe-lock-root-${process.pid}-${Date.now()}.jsonl`,
      );
      await mkdir(lockRoot, { mode: 0o700, recursive: true });
      await chmod(unsafeParent, 0o777);
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", await realpath(lockRoot));
      const pathRelease = vi.fn(async () => {});
      fsMocks.lock.mockResolvedValueOnce(pathRelease);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/unsafe-shared-lock-root",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).rejects.toThrow("parent namespace is not trusted");

        expect(fsMocks.serverWrite).not.toHaveBeenCalled();
        expect(pathRelease).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects world-writable configured server recorder lock roots",
    async () => {
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-lock-mode-"));
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-peer-writable-lock-${process.pid}-${Date.now()}.jsonl`,
      );
      await chmod(lockRoot, 0o777);
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", await realpath(lockRoot));
      const pathRelease = vi.fn(async () => {});
      fsMocks.lock.mockResolvedValueOnce(pathRelease);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/peer-writable-shared-lock-root",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).rejects.toThrow("shared lock directory is writable by every local user");

        expect(fsMocks.serverWrite).not.toHaveBeenCalled();
        expect(pathRelease).toHaveBeenCalledOnce();
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts group-writable configured server recorder lock roots",
    async () => {
      const lockRoot = await mkdtemp(path.join(tmpdir(), "crabline-server-lock-group-"));
      const canonicalLockRoot = await realpath(lockRoot);
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-group-lock-${process.pid}-${Date.now()}.jsonl`,
      );
      await chmod(lockRoot, 0o770);
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      fsMocks.serverFileStat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
      fsMocks.serverStat.mockResolvedValue({ dev: 1, ino: 2, size: 0 });
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", canonicalLockRoot);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/group-shared-lock-root",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).resolves.toBeUndefined();

        expect(fsMocks.serverWrite).toHaveBeenCalledOnce();
      } finally {
        await rm(lockRoot, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects configured server recorder lock paths with symlink components",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "crabline-server-lock-symlink-"));
      const canonicalRoot = path.join(directory, "canonical");
      const symlinkRoot = path.join(directory, "current");
      const recorderPath = path.join(
        "/tmp",
        `crabline-server-recorder-lock-symlink-${process.pid}-${Date.now()}.jsonl`,
      );
      await mkdir(canonicalRoot, { mode: 0o700 });
      await symlink(canonicalRoot, symlinkRoot, "dir");
      fsMocks.serverDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.serverWrite.mockResolvedValue(undefined);
      vi.stubEnv("CRABLINE_RECORDER_LOCK_DIR", symlinkRoot);
      const pathRelease = vi.fn(async () => {});
      fsMocks.lock.mockResolvedValueOnce(pathRelease);

      try {
        await expect(
          recordServerEvent({
            event: {
              at: "2026-07-12T10:00:00.000Z",
              method: "POST",
              path: "/symlinked-lock-root",
              query: {},
              type: "api",
            },
            onEvent: undefined,
            recorderPath,
          }),
        ).rejects.toThrow(
          "CRABLINE_RECORDER_LOCK_DIR must name a canonical directory without symlink components.",
        );
        expect(fsMocks.serverWrite).not.toHaveBeenCalled();
        expect(pathRelease).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

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
        process.platform === "win32" ? 0 : 2,
      );
      expect(fsMocks.providerDirectoryOpen.mock.calls).toEqual(
        process.platform === "win32"
          ? []
          : [[fsMocks.providerDirectory], [fsMocks.providerDirectory]],
      );
      expect(fsMocks.providerOpen.mock.calls.map(([, flags, mode]) => [flags, mode])).toEqual([
        [process.platform === "win32" ? "wx+" : providerRecorderCreateOpenFlags, 0o600],
        [process.platform === "win32" ? "r+" : providerRecorderExistingOpenFlags, 0o600],
        [process.platform === "win32" ? "wx+" : providerRecorderCreateOpenFlags, 0o600],
        [process.platform === "win32" ? "r+" : providerRecorderExistingOpenFlags, 0o600],
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
    "does not follow a recorder path replaced by a symlink before append open",
    async () => {
      const tempRoot = await mkdtemp(
        path.join(tmpdir(), "crabline-provider-recorder-symlink-race-"),
      );
      const recorderPath = path.join(tempRoot, "events.jsonl");
      const displacedPath = path.join(tempRoot, "events.original.jsonl");
      const outsidePath = path.join(tempRoot, "outside.txt");
      fsMocks.providerDirectory = await realpath(tempRoot);
      await writeFile(recorderPath, "", { mode: 0o600 });
      await writeFile(outsidePath, "preserve", { mode: 0o600 });
      const publicationPath = await realpath(recorderPath);
      let replaced = false;
      fsMocks.providerOpen.mockImplementation((filePath, flags) => {
        if (
          !replaced &&
          filePath === publicationPath &&
          flags === providerRecorderExistingOpenFlags
        ) {
          replaced = true;
          fs.renameSync(publicationPath, displacedPath);
          fs.symlinkSync(outsidePath, publicationPath);
        }
      });

      try {
        await expect(
          appendRecordedInbound(recorderPath, {
            author: "assistant",
            id: "symlink-race",
            provider: "slack",
            sentAt: "2026-07-12T10:00:00.000Z",
            text: "must not escape",
            threadId: "slack:C123",
          }),
        ).rejects.toMatchObject({ code: "ELOOP" });
        expect(replaced).toBe(true);
        await expect(readFile(outsidePath, "utf8")).resolves.toBe("preserve");
        expect(fsMocks.providerWrite).not.toHaveBeenCalled();
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
      }
    },
  );

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

  it.each([
    {
      configureFailure(failure: Error) {
        fsMocks.providerRealpathFailure = failure;
        fsMocks.providerRealpathFailureAfterWrites = 1;
      },
      name: "publication path resolution",
    },
    {
      configureFailure(failure: Error) {
        fsMocks.providerLstatFailure = failure;
        fsMocks.providerLstatFailureAfterLocks = 2;
        fsMocks.providerLstatFailureAfterWrites = 1;
      },
      name: "identity confirmation",
    },
  ])(
    "classifies final $name failure as a committed provider append",
    async ({ configureFailure }) => {
      const recorderPath = path.join(
        "/tmp",
        `crabline-provider-recorder-committed-confirmation-${process.pid}-${Date.now()}.jsonl`,
      );
      fsMocks.providerDirectory = await realpath(path.dirname(recorderPath));
      fsMocks.providerLogicalPath = path.resolve(recorderPath);
      fsMocks.providerRecorderPath = path.join(
        fsMocks.providerDirectory,
        path.basename(recorderPath),
      );
      fsMocks.providerWrite.mockResolvedValue(undefined);
      const confirmationFailure = Object.assign(new Error("simulated final confirmation failure"), {
        code: "EIO",
      });
      configureFailure(confirmationFailure);

      try {
        const append = appendRecordedInbound(recorderPath, {
          author: "assistant",
          id: "committed-confirmation-failure",
          provider: "slack",
          sentAt: "2026-07-12T10:00:00.000Z",
          text: "committed",
          threadId: "slack:C123",
        });
        await expect(append).rejects.toMatchObject({
          cause: confirmationFailure,
          committed: true,
          indeterminate: true,
          name: "ProviderRecorderCommittedError",
        });
        await expect(append).rejects.toBeInstanceOf(ProviderRecorderCommittedError);
        expect(fsMocks.providerWrite).toHaveBeenCalledOnce();
        expect(fsMocks.lockRelease).toHaveBeenCalledTimes(2);
      } finally {
        await rm(recorderPath, { force: true });
      }
    },
  );

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

  it.skipIf(process.platform === "win32")(
    "canonicalizes a created-directory durability boundary through a symlink",
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), "crabline-provider-symlink-durability-"));
      const targetRoot = path.join(tempRoot, "target");
      const aliasRoot = path.join(tempRoot, "alias");
      await mkdir(targetRoot);
      await symlink(targetRoot, aliasRoot, "dir");
      const recorderPath = path.join(aliasRoot, "nested", "events.jsonl");
      const canonicalCreatedDirectory = path.join(await realpath(targetRoot), "nested");
      fsMocks.providerDirectory = canonicalCreatedDirectory;
      fsMocks.providerDeniedDirectory = await realpath(tempRoot);
      fsMocks.providerWrite.mockResolvedValue(undefined);
      const event = {
        author: "assistant" as const,
        id: "symlink-durability",
        provider: "slack",
        sentAt: "2026-07-12T10:00:00.000Z",
        text: "durable",
        threadId: "slack:C123",
      };

      try {
        await expect(appendRecordedInbound(recorderPath, event)).resolves.toMatchObject({
          id: event.id,
        });
        expect(fsMocks.providerDirectorySync).toHaveBeenCalledWith(canonicalCreatedDirectory);
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
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
