import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRequestEvent } from "../src/servers/http.js";
import {
  recordCommittedServerEvent,
  recordServerEvent,
  secureServerRecorderWindowsLockRoot,
  serverRecorderWindowsLockPath,
  ServerRecorderCommittedError,
} from "../src/servers/recorder.js";

const lockMocks = vi.hoisted(() => {
  const release = vi.fn<() => Promise<void>>();
  return {
    lock: vi.fn<
      (filePath: string, options: Record<string, unknown>) => Promise<() => Promise<void>>
    >(),
    release,
  };
});

const readWindowsDirectorySecurityDescriptor = vi.fn(async () => "owner-only");

const fsMocks = vi.hoisted(() => {
  const directory = {
    chmod: vi.fn<(mode: number) => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
    stat: vi.fn<
      () => Promise<{
        dev: bigint;
        ino: bigint;
        isDirectory(): boolean;
        mode: bigint;
        uid: bigint;
      }>
    >(),
    sync: vi.fn<() => Promise<void>>(),
  };
  const file = {
    appendFile: vi.fn<(data: string, options: { encoding: "utf8" }) => Promise<void>>(),
    chmod: vi.fn<(mode: number) => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
    read: vi.fn<
      (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>
    >(),
    stat: vi.fn<
      (options?: { bigint?: boolean }) => Promise<{
        dev?: bigint | number;
        ino?: bigint | number;
        isFile?: () => boolean;
        nlink?: bigint | number;
        size: bigint | number;
      }>
    >(),
    sync: vi.fn<() => Promise<void>>(),
    truncate: vi.fn<(length: number) => Promise<void>>(),
  };
  return {
    chmod: vi.fn<(filePath: string, mode: number) => Promise<void>>(),
    directory,
    file,
    lstat: vi.fn<
      (
        filePath: string,
        options?: { bigint?: boolean },
      ) => Promise<{
        dev: bigint;
        ino: bigint;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        mode: bigint;
        uid: bigint;
      }>
    >(),
    mkdir:
      vi.fn<
        (
          filePath: string,
          options: { mode: number; recursive?: true },
        ) => Promise<string | undefined>
      >(),
    open: vi.fn<
      (
        filePath: string,
        flags: number | string,
        mode?: number,
      ) => Promise<typeof directory | typeof file>
    >(),
    stat: vi.fn<
      (
        filePath: string,
        options?: { bigint?: boolean },
      ) => Promise<{
        dev?: bigint | number;
        ino?: bigint | number;
        isFile?: () => boolean;
        nlink?: bigint | number;
        size: bigint | number;
      }>
    >(),
  };
});

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    lock: lockMocks.lock,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: fsMocks.chmod,
    lstat: fsMocks.lstat,
    mkdir: fsMocks.mkdir,
    open: fsMocks.open,
    stat: fsMocks.stat,
  };
});

type RecorderProcess = {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
  stderr: () => string;
  stdout: () => string;
};

function startRecorderProcess(
  recorderPath: string,
  pathname: string,
  recorderLockDirectory?: string,
): RecorderProcess {
  const recorderModuleUrl = new URL("../src/servers/recorder.ts", import.meta.url).href;
  const script = `
    import { recordServerEvent } from ${JSON.stringify(recorderModuleUrl)};
    process.stdout.write("ready\\n");
    process.stdin.once("data", async () => {
      process.stdin.destroy();
      try {
        await recordServerEvent({
          event: {
            at: "2026-07-12T12:00:00.000Z",
            method: "POST",
            path: process.argv[2],
            query: {},
            type: "api",
          },
          onEvent: undefined,
          recorderPath: process.argv[1],
        });
        process.stdout.write("done\\n");
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, recorderPath, pathname],
    {
      env:
        recorderLockDirectory === undefined
          ? process.env
          : { ...process.env, CRABLINE_RECORDER_LOCK_DIR: recorderLockDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    child,
    exited: once(child, "exit").then(([code]) => code as number | null),
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

function serverEvent(pathname: string): ServerRequestEvent {
  return {
    at: "2026-07-12T12:00:00.000Z",
    method: "POST",
    path: pathname,
    query: {},
    type: "api",
  };
}

beforeEach(() => {
  readWindowsDirectorySecurityDescriptor.mockClear();
  lockMocks.release.mockReset();
  lockMocks.release.mockResolvedValue();
  lockMocks.lock.mockReset();
  lockMocks.lock.mockResolvedValue(lockMocks.release);
  fsMocks.chmod.mockReset();
  fsMocks.chmod.mockResolvedValue();
  fsMocks.directory.chmod.mockReset();
  fsMocks.directory.chmod.mockResolvedValue();
  fsMocks.directory.close.mockReset();
  fsMocks.directory.close.mockResolvedValue();
  fsMocks.directory.stat.mockReset();
  fsMocks.directory.stat.mockResolvedValue({
    dev: 10n,
    ino: 20n,
    isDirectory: () => true,
    mode: 0o700n,
    uid: BigInt(process.geteuid?.() ?? 0),
  });
  fsMocks.directory.sync.mockReset();
  fsMocks.directory.sync.mockResolvedValue();
  fsMocks.file.appendFile.mockReset();
  fsMocks.file.appendFile.mockResolvedValue();
  fsMocks.file.chmod.mockReset();
  fsMocks.file.chmod.mockResolvedValue();
  fsMocks.file.close.mockReset();
  fsMocks.file.close.mockResolvedValue();
  fsMocks.file.read.mockReset();
  fsMocks.file.read.mockResolvedValue({ buffer: Buffer.alloc(0), bytesRead: 0 });
  fsMocks.file.stat.mockReset();
  fsMocks.file.stat.mockResolvedValue({ dev: 1, ino: 1, nlink: 1, size: 0 });
  fsMocks.file.sync.mockReset();
  fsMocks.file.sync.mockResolvedValue();
  fsMocks.file.truncate.mockReset();
  fsMocks.file.truncate.mockResolvedValue();
  fsMocks.lstat.mockReset();
  fsMocks.lstat.mockResolvedValue({
    dev: 10n,
    ino: 20n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o700n,
    uid: BigInt(process.geteuid?.() ?? 0),
  });
  fsMocks.mkdir.mockReset();
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.open.mockReset();
  fsMocks.open.mockImplementation(async (_filePath, flags) => {
    if (flags === "ax+") {
      throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
    }
    return typeof flags === "number" || flags === "r" ? fsMocks.directory : fsMocks.file;
  });
  fsMocks.stat.mockReset();
  fsMocks.stat.mockResolvedValue({ dev: 1, ino: 1, nlink: 1, size: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("server recorder", () => {
  it("creates the Windows process-lock root with an owner-only ACL", async () => {
    const lockRoot = path.join("/tmp", "crabline-server-recorder-locks");
    const createWindowsDirectory = vi.fn(async () => undefined);

    await expect(
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
    ).resolves.toBe(lockRoot);
    await expect(
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
    ).resolves.toBe(lockRoot);

    expect(createWindowsDirectory).toHaveBeenCalledTimes(1);
    expect(createWindowsDirectory).toHaveBeenCalledWith(lockRoot);
    expect(fsMocks.lstat).toHaveBeenCalledTimes(6);
    expect(fsMocks.lstat).toHaveBeenCalledWith(lockRoot, { bigint: true });
  });

  it("recreates a cached Windows process-lock root after deletion", async () => {
    const lockRoot = path.join("/tmp", "crabline-server-recorder-recreated-locks");
    const missing = Object.assign(new Error("lock root removed"), { code: "ENOENT" });
    const createWindowsDirectory = vi.fn(async () => undefined);

    await secureServerRecorderWindowsLockRoot(lockRoot, {
      createWindowsDirectory,
      readWindowsDirectorySecurityDescriptor,
    });
    fsMocks.lstat.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);
    await expect(
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
    ).resolves.toBe(lockRoot);

    expect(createWindowsDirectory).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent Windows process-lock root replacement recovery", async () => {
    const lockRoot = path.join("/tmp", "crabline-server-recorder-concurrent-locks");
    const createWindowsDirectory = vi.fn(async () => undefined);

    await secureServerRecorderWindowsLockRoot(lockRoot, {
      createWindowsDirectory,
      readWindowsDirectorySecurityDescriptor,
    });
    fsMocks.lstat.mockResolvedValue({
      dev: 10n,
      ino: 21n,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o700n,
      uid: BigInt(process.geteuid?.() ?? 0),
    });
    await Promise.all([
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
    ]);

    expect(createWindowsDirectory).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated Windows process-lock root replacement recovery", async () => {
    const lockRoot = path.join("/tmp", "crabline-server-recorder-unstable-locks");
    const createWindowsDirectory = vi.fn(async () => undefined);
    fsMocks.lstat
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 20n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 20n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 21n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 21n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 22n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 22n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 23n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: 23n,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      });

    await expect(
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
    ).rejects.toThrow("Server recorder Windows lock root could not be stabilized.");
    expect(createWindowsDirectory).toHaveBeenCalledTimes(2);
  });

  it("re-secures a Windows process-lock root when wide file IDs differ", async () => {
    const lockRoot = path.join("/tmp", "crabline-server-recorder-wide-id-locks");
    const createWindowsDirectory = vi.fn(async () => undefined);
    const originalInode = 2n ** 53n;
    const replacementInode = originalInode + 1n;
    fsMocks.lstat
      .mockResolvedValueOnce({
        dev: 10n,
        ino: originalInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: originalInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: replacementInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: replacementInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: replacementInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: replacementInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: replacementInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      })
      .mockResolvedValueOnce({
        dev: 10n,
        ino: replacementInode,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o700n,
        uid: BigInt(process.geteuid?.() ?? 0),
      });

    await expect(
      secureServerRecorderWindowsLockRoot(lockRoot, {
        createWindowsDirectory,
        readWindowsDirectorySecurityDescriptor,
      }),
    ).resolves.toBe(lockRoot);

    expect(createWindowsDirectory).toHaveBeenCalledTimes(2);
    expect(fsMocks.lstat.mock.calls.every(([, options]) => options?.bigint === true)).toBe(true);
  });

  it("maps Windows path case aliases to the same process lock", () => {
    const lockRoot = String.raw`C:\Users\tester\AppData\Local\Crabline\locks`;

    expect(serverRecorderWindowsLockPath(lockRoot, String.raw`C:\Logs\Events.jsonl`)).toBe(
      serverRecorderWindowsLockPath(lockRoot, String.raw`c:\logs\events.JSONL`),
    );
  });

  it("makes a recursively created recorder path durable before observing its first append", async () => {
    const firstParent = path.join("/tmp", "private");
    const finalParent = path.join(firstParent, "nested");
    const recorderPath = path.join(finalParent, "events.jsonl");
    const canonicalFirstParent = path.join(await realpath("/tmp"), "private");
    const canonicalFinalParent = path.join(canonicalFirstParent, "nested");
    const canonicalRecorderPath = path.join(canonicalFinalParent, "events.jsonl");
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    fsMocks.mkdir.mockImplementation(async (filePath) => {
      return filePath === canonicalFinalParent ? canonicalFirstParent : undefined;
    });
    fsMocks.open.mockImplementation(async (_filePath, flags) =>
      typeof flags === "number" || flags === "r" ? fsMocks.directory : fsMocks.file,
    );
    await recordServerEvent({
      event: serverEvent("/private"),
      onEvent: observer,
      recorderPath,
    });

    expect(fsMocks.mkdir).toHaveBeenCalledWith(canonicalFinalParent, {
      mode: 0o700,
      recursive: true,
    });
    expect(fsMocks.chmod).toHaveBeenCalledWith(canonicalFinalParent, 0o700);
    expect(fsMocks.open.mock.calls.filter(([, flags]) => typeof flags === "string")).toEqual([
      [canonicalRecorderPath, "ax+", 0o600],
      [canonicalFinalParent, "r"],
      [canonicalFirstParent, "r"],
      [path.dirname(canonicalFirstParent), "r"],
    ]);
    expect(fsMocks.file.chmod).toHaveBeenCalledWith(0o600);
    expect(fsMocks.file.appendFile).toHaveBeenCalledWith(expect.any(String), {
      encoding: "utf8",
    });
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
    expect(fsMocks.directory.sync).toHaveBeenCalledTimes(3);
    expect(fsMocks.file.sync.mock.invocationCallOrder[0]).toBeLessThan(
      fsMocks.directory.sync.mock.invocationCallOrder[0]!,
    );
    expect(fsMocks.directory.sync.mock.invocationCallOrder.at(-1)).toBeLessThan(
      observer.mock.invocationCallOrder[0]!,
    );
    expect(lockMocks.lock).toHaveBeenCalledWith(
      canonicalRecorderPath,
      expect.objectContaining({
        fs: expect.any(Object),
        realpath: false,
        retries: 0,
        stale: 30_000,
        update: 10_000,
      }),
    );
    expect(
      lockMocks.lock.mock.calls.some(
        ([lockPath, options]) =>
          path.basename(lockPath) === "recorder-1-1" &&
          (options as { realpath?: boolean }).realpath === false,
      ),
    ).toBe(true);
    expect(lockMocks.release).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.chmod.mock.invocationCallOrder[0]).toBeLessThan(
      fsMocks.file.appendFile.mock.invocationCallOrder[0]!,
    );
    expect(fsMocks.file.close).toHaveBeenCalledOnce();
    expect(fsMocks.directory.close.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("resyncs recorder ancestry after an interrupted first-append attempt", async () => {
    const firstParent = path.join("/tmp", "retry-private");
    const finalParent = path.join(firstParent, "nested");
    const recorderPath = path.join(finalParent, "events.jsonl");
    const canonicalRoot = await realpath("/tmp");
    const canonicalFirstParent = path.join(canonicalRoot, "retry-private");
    const ancestrySyncFailure = new Error("simulated recorder ancestry sync interruption");
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    let recorderExists = false;
    fsMocks.mkdir.mockResolvedValueOnce(canonicalFirstParent).mockResolvedValueOnce(undefined);
    fsMocks.file.stat.mockResolvedValue({ dev: 42, ino: 84, nlink: 1, size: 0 });
    fsMocks.stat.mockResolvedValue({ dev: 42, ino: 84, nlink: 1, size: 0 });
    fsMocks.directory.sync.mockRejectedValueOnce(ancestrySyncFailure).mockResolvedValue(undefined);
    fsMocks.open.mockImplementation(async (openedPath, flags) => {
      if (typeof flags === "number") {
        return fsMocks.directory;
      }
      if (flags === "r") {
        if (openedPath === canonicalRoot) {
          throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
        }
        return fsMocks.directory;
      }
      if (flags === "ax+") {
        if (recorderExists) {
          throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
        }
        recorderExists = true;
      }
      return fsMocks.file;
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/interrupted"),
        onEvent: observer,
        recorderPath,
      }),
    ).rejects.toMatchObject({
      cause: ancestrySyncFailure,
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });
    expect(observer).not.toHaveBeenCalled();

    const retryEvent = serverEvent("/retry");
    await recordServerEvent({
      event: retryEvent,
      onEvent: observer,
      recorderPath,
    });

    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.sync).toHaveBeenCalledTimes(2);
    expect(fsMocks.directory.sync).toHaveBeenCalledTimes(2);
    expect(fsMocks.open).not.toHaveBeenCalledWith(path.parse(recorderPath).root, "r");
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(retryEvent);
    expect(fsMocks.directory.sync.mock.invocationCallOrder.at(-1)).toBeLessThan(
      observer.mock.invocationCallOrder[0]!,
    );
  });

  it("fails an immediate parent sync without caching durability or notifying observers", async () => {
    const finalParent = path.join("/tmp", "recorder-immediate-denied");
    const recorderPath = path.join(finalParent, "events.jsonl");
    const canonicalRoot = await realpath("/tmp");
    const canonicalFinalParent = path.join(canonicalRoot, "recorder-immediate-denied");
    const syncFailure = Object.assign(new Error("recorder parent denied"), { code: "EACCES" });
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    let immediateAttempts = 0;
    fsMocks.file.stat.mockResolvedValue({ dev: 61, ino: 62, nlink: 1, size: 0 });
    fsMocks.stat.mockResolvedValue({ dev: 61, ino: 62, nlink: 1, size: 0 });
    fsMocks.open.mockImplementation(async (openedPath, flags) => {
      if (typeof flags === "number") {
        return fsMocks.directory;
      }
      if (flags === "ax+") {
        throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
      }
      if (flags === "r") {
        if (openedPath === canonicalFinalParent && immediateAttempts++ === 0) {
          throw syncFailure;
        }
        if (openedPath === canonicalRoot) {
          throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
        }
        return fsMocks.directory;
      }
      return fsMocks.file;
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/denied"),
        onEvent: observer,
        recorderPath,
      }),
    ).rejects.toMatchObject({
      cause: syncFailure,
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });
    expect(observer).not.toHaveBeenCalled();

    const retryEvent = serverEvent("/retry-after-denial");
    await recordServerEvent({
      event: retryEvent,
      onEvent: observer,
      recorderPath,
    });

    expect(immediateAttempts).toBe(2);
    expect(fsMocks.file.sync).toHaveBeenCalledTimes(2);
    expect(fsMocks.directory.sync).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(retryEvent);
  });

  it("fails newly created recorder ancestry sync and retries the uncached inode", async () => {
    const firstParent = path.join("/tmp", "recorder-created-denied");
    const finalParent = path.join(firstParent, "nested");
    const recorderPath = path.join(finalParent, "events.jsonl");
    const canonicalRoot = await realpath("/tmp");
    const canonicalFirstParent = path.join(canonicalRoot, "recorder-created-denied");
    const syncFailure = Object.assign(new Error("created recorder ancestry denied"), {
      code: "EPERM",
    });
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    let recorderExists = false;
    let denyCreatedBoundary = true;
    fsMocks.mkdir.mockResolvedValueOnce(canonicalFirstParent).mockResolvedValueOnce(undefined);
    fsMocks.file.stat.mockResolvedValue({ dev: 71, ino: 72, nlink: 1, size: 0 });
    fsMocks.stat.mockResolvedValue({ dev: 71, ino: 72, nlink: 1, size: 0 });
    fsMocks.open.mockImplementation(async (openedPath, flags) => {
      if (typeof flags === "number") {
        return fsMocks.directory;
      }
      if (flags === "ax+") {
        if (recorderExists) {
          throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
        }
        recorderExists = true;
        return fsMocks.file;
      }
      if (flags === "r") {
        if (openedPath === canonicalRoot) {
          if (denyCreatedBoundary) {
            denyCreatedBoundary = false;
            throw syncFailure;
          }
          throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
        }
        return fsMocks.directory;
      }
      return fsMocks.file;
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/created-denied"),
        onEvent: observer,
        recorderPath,
      }),
    ).rejects.toMatchObject({
      cause: syncFailure,
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });
    expect(observer).not.toHaveBeenCalled();

    const retryEvent = serverEvent("/retry-created-denial");
    await recordServerEvent({
      event: retryEvent,
      onEvent: observer,
      recorderPath,
    });

    expect(fsMocks.file.sync).toHaveBeenCalledTimes(2);
    expect(fsMocks.directory.sync).toHaveBeenCalledTimes(3);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(retryEvent);
  });

  it("keeps retrying while another recorder owner remains live", async () => {
    const contention = Object.assign(new Error("Lock file is already being held"), {
      code: "ELOCKED",
    });
    lockMocks.lock.mockRejectedValueOnce(contention).mockResolvedValueOnce(lockMocks.release);

    await recordServerEvent({
      event: serverEvent("/after-contention"),
      onEvent: undefined,
      recorderPath: path.join("/tmp", "crabline-server-recorder-contention.jsonl"),
    });

    expect(lockMocks.lock).toHaveBeenCalledTimes(3);
    expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    expect(lockMocks.release).toHaveBeenCalledTimes(2);
  });

  it("repairs managed directories without chmodding existing recorder files or parents", async () => {
    const callerOwnedPath = path.join("/tmp", "events.jsonl");
    await recordServerEvent({
      event: serverEvent("/caller-owned"),
      onEvent: undefined,
      recorderPath: callerOwnedPath,
    });
    expect(fsMocks.chmod).not.toHaveBeenCalledWith(
      path.dirname(callerOwnedPath),
      expect.any(Number),
    );
    expect(fsMocks.file.chmod).not.toHaveBeenCalled();

    const managedPath = path.resolve(".crabline", "servers", "events.jsonl");
    await recordServerEvent({
      event: serverEvent("/managed"),
      onEvent: undefined,
      recorderPath: managedPath,
    });
    expect(fsMocks.chmod).toHaveBeenCalledWith(path.dirname(managedPath), 0o700);
  });

  it("admits directory creation and append into one serialized queue", async () => {
    let releaseFirstMkdir: (() => void) | undefined;
    fsMocks.mkdir
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseFirstMkdir = () => resolve(undefined);
        }),
      )
      .mockResolvedValueOnce(undefined);
    const recorderPath = path.join("/tmp", "crabline-server-recorder-admission.jsonl");
    const recorderDirectory = await realpath(path.dirname(recorderPath));
    const recorderMkdirCalls = () =>
      fsMocks.mkdir.mock.calls.filter(([directory]) => directory === recorderDirectory);

    const first = recordServerEvent({
      event: serverEvent("/first"),
      onEvent: undefined,
      recorderPath,
    });
    const second = recordServerEvent({
      event: serverEvent("/second"),
      onEvent: undefined,
      recorderPath,
    });

    await vi.waitFor(() => expect(recorderMkdirCalls()).toHaveLength(1));
    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();

    releaseFirstMkdir?.();
    await Promise.all([first, second]);

    expect(recorderMkdirCalls()).toHaveLength(2);
    expect(fsMocks.file.appendFile.mock.calls.map(([line]) => JSON.parse(line).path)).toEqual([
      "/first",
      "/second",
    ]);
    expect(recorderMkdirCalls()[1]).toBeDefined();
    expect(
      fsMocks.mkdir.mock.invocationCallOrder[
        fsMocks.mkdir.mock.calls.indexOf(recorderMkdirCalls()[1]!)
      ],
    ).toBeGreaterThan(fsMocks.file.appendFile.mock.invocationCallOrder[0]!);
  });

  it("snapshots events before waiting for recorder admission", async () => {
    const event = serverEvent("/original");
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    const recording = recordServerEvent({
      event,
      onEvent: observer,
      recorderPath: path.join("/tmp", "crabline-server-recorder-snapshot.jsonl"),
    });
    event.path = "/mutated";

    await recording;

    expect(JSON.parse(fsMocks.file.appendFile.mock.calls[0]![0]).path).toBe("/original");
    expect(observer).toHaveBeenCalledWith(serverEvent("/original"));
  });

  it("recovers serialization after an append failure", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-recovery.jsonl");
    const appendFailure = new Error("disk unavailable");
    fsMocks.file.appendFile.mockRejectedValueOnce(appendFailure).mockResolvedValueOnce();

    await expect(
      recordServerEvent({
        event: serverEvent("/first"),
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toMatchObject({
      cause: appendFailure,
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });
    await expect(
      recordServerEvent({
        event: serverEvent("/second"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
  });

  it("syncs every accepted append without requiring an observer", async () => {
    await recordServerEvent({
      event: serverEvent("/durable"),
      onEvent: undefined,
      recorderPath: path.join("/tmp", "crabline-server-recorder-durable.jsonl"),
    });

    expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
  });

  it("resyncs the recorder parent for every durable append", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-parent-sync.jsonl");
    const canonicalPath = path.join(await realpath("/tmp"), path.basename(recorderPath));
    const canonicalParent = path.dirname(canonicalPath);
    fsMocks.open.mockImplementation(async (openedPath, flags) => {
      if (flags === "ax+") {
        throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
      }
      if (flags === "r" && openedPath !== canonicalParent) {
        throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
      }
      return typeof flags === "number" || flags === "r" ? fsMocks.directory : fsMocks.file;
    });

    await recordServerEvent({
      event: serverEvent("/first-parent-sync"),
      onEvent: undefined,
      recorderPath,
    });
    await recordServerEvent({
      event: serverEvent("/second-parent-sync"),
      onEvent: undefined,
      recorderPath,
    });

    expect(fsMocks.open.mock.calls.filter(([, flags]) => flags === "r")).toEqual([
      [canonicalParent, "r"],
      [canonicalParent, "r"],
    ]);
    expect(fsMocks.directory.sync).toHaveBeenCalledTimes(2);
  });

  it("waits beyond the stale threshold before reclaiming an orphaned lock", async () => {
    vi.useFakeTimers();
    const staleAt = performance.now() + 30_000;
    lockMocks.lock.mockImplementation(async () => {
      if (performance.now() <= staleAt) {
        throw Object.assign(new Error("Recorder is locked"), { code: "ELOCKED" });
      }
      return lockMocks.release;
    });

    const recording = recordServerEvent({
      event: serverEvent("/after-stale-lock"),
      onEvent: undefined,
      recorderPath: path.join("/tmp", "crabline-server-recorder-stale-lock.jsonl"),
    });
    await vi.waitFor(() => expect(lockMocks.lock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_100);

    await expect(recording).resolves.toBeUndefined();
    expect(lockMocks.lock.mock.calls.length).toBeGreaterThan(300);
  });

  it("stops retrying lock contention at the elapsed deadline", async () => {
    vi.useFakeTimers();
    const locked = Object.assign(new Error("Recorder is locked"), { code: "ELOCKED" });
    lockMocks.lock.mockRejectedValue(locked);

    const recording = recordServerEvent({
      event: serverEvent("/lock-deadline"),
      onEvent: undefined,
      recorderPath: path.join("/tmp", "crabline-server-recorder-lock-deadline.jsonl"),
    });
    let rejection: unknown;
    const handled = recording.catch((error: unknown) => {
      rejection = error;
    });
    await vi.waitFor(() => expect(lockMocks.lock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(35_000);

    await handled;
    expect(rejection).toBe(locked);
    expect(lockMocks.lock.mock.calls.length).toBeGreaterThan(300);
  });

  it("reopens the recorder when rotation happens before append", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-rotated-before.jsonl");
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
    fsMocks.stat.mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });

    await recordServerEvent({
      event: serverEvent("/after-rotation"),
      onEvent: undefined,
      recorderPath,
    });

    expect(fsMocks.file.close).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
  });

  it("fails when recorder identity cannot be verified", async () => {
    fsMocks.file.stat.mockResolvedValue({ size: 0 });

    await expect(
      recordServerEvent({
        event: serverEvent("/identity-unavailable"),
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-no-identity.jsonl"),
      }),
    ).rejects.toThrow("Server recorder file identity is unavailable.");

    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
    expect(fsMocks.file.close).toHaveBeenCalledOnce();
  });

  it("fails when recorder link count cannot be verified", async () => {
    fsMocks.file.stat.mockResolvedValue({ dev: 1, ino: 1, size: 0 });

    await expect(
      recordServerEvent({
        event: serverEvent("/link-count-unavailable"),
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-no-link-count.jsonl"),
      }),
    ).rejects.toThrow("Server recorder file link count is unavailable.");

    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
    expect(fsMocks.file.close).toHaveBeenCalledOnce();
  });

  it("rejects a non-regular recorder handle before append or observer notification", async () => {
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    fsMocks.file.stat.mockResolvedValue({
      dev: 1,
      ino: 1,
      isFile: () => false,
      nlink: 1,
      size: 0,
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/non-regular"),
        onEvent: observer,
        recorderPath: path.join("/tmp", "crabline-server-recorder-special.jsonl"),
      }),
    ).rejects.toThrow("Server recorder path is not a regular file.");

    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
    expect(fsMocks.file.sync).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("rejects a recorder whose link count changes while acquiring its identity lock", async () => {
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 1, nlink: 2, size: 0 });

    await expect(
      recordServerEvent({
        event: serverEvent("/hardlink-transition"),
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-hardlink-transition.jsonl"),
      }),
    ).rejects.toThrow(
      "Server recorder hardlinks require CRABLINE_RECORDER_LOCK_DIR to name one shared writable lock directory for every writer.",
    );

    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
    expect(lockMocks.lock).toHaveBeenCalledTimes(2);
    expect(lockMocks.release).toHaveBeenCalledTimes(2);
  });

  it("reports a committed append without truncating a rotated inode", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-rotated-after.jsonl");
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
    fsMocks.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });

    await expect(
      recordServerEvent({
        event: serverEvent("/after-rotation"),
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toMatchObject({ committed: true, name: "ServerRecorderCommittedError" });

    expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
    expect(fsMocks.file.close).toHaveBeenCalledOnce();
  });

  it("does not roll back a committed append when rotation happens during ancestry sync", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-rotated-during-sync.jsonl");
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
    fsMocks.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });

    await expect(
      recordServerEvent({
        event: serverEvent("/after-sync-rotation"),
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toMatchObject({ committed: true, name: "ServerRecorderCommittedError" });

    expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
    expect(fsMocks.directory.sync).toHaveBeenCalledOnce();
    expect(fsMocks.file.close).toHaveBeenCalledOnce();
  });

  it("preserves committed rotation status when close also fails", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-rotation-retry.jsonl");
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
    fsMocks.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: 0 })
      .mockResolvedValue({ dev: 1, ino: 2, nlink: 1, size: 0 });
    fsMocks.file.close.mockRejectedValueOnce(new Error("simulated close failure"));

    await expect(
      recordServerEvent({
        event: serverEvent("/rotation-close-failed"),
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toMatchObject({ committed: true, name: "ServerRecorderCommittedError" });

    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
  });

  it("classifies post-append sync failure as indeterminate without truncating", async () => {
    const syncFailure = new Error("simulated fsync failure");
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    fsMocks.file.sync.mockRejectedValueOnce(syncFailure).mockResolvedValue(undefined);

    await expect(
      recordServerEvent({
        event: serverEvent("/sync-failed"),
        onEvent: observer,
        recorderPath: path.join("/tmp", "crabline-server-recorder-sync-failed.jsonl"),
      }),
    ).rejects.toMatchObject({
      cause: syncFailure,
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });

    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
  });

  it("exposes an indeterminate result when an append fails", async () => {
    const appendFailure = new Error("simulated append failure");
    fsMocks.file.appendFile.mockRejectedValueOnce(appendFailure);

    const recording = recordServerEvent({
      event: serverEvent("/append-failed"),
      onEvent: undefined,
      recorderPath: path.join("/tmp", "crabline-server-recorder-append-failed.jsonl"),
    });

    await expect(recording).rejects.toMatchObject({
      cause: appendFailure,
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });
    await expect(recording).rejects.toBeInstanceOf(ServerRecorderCommittedError);
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
  });

  it("preserves indeterminate status when sync and close both fail", async () => {
    fsMocks.file.sync.mockRejectedValueOnce(new Error("simulated fsync failure"));
    fsMocks.file.close.mockRejectedValueOnce(new Error("simulated close failure"));

    await expect(
      recordServerEvent({
        event: serverEvent("/sync-and-close-failed"),
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-close-failed.jsonl"),
      }),
    ).rejects.toMatchObject({
      committed: true,
      indeterminate: true,
      name: "ServerRecorderCommittedError",
    });
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
  });

  it("exposes committed status when close fails after a durable append", async () => {
    const closeFailure = new Error("simulated close failure");
    fsMocks.file.close.mockRejectedValueOnce(closeFailure);

    await expect(
      recordServerEvent({
        event: serverEvent("/close-failed-after-commit"),
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-committed-close-failed.jsonl"),
      }),
    ).rejects.toMatchObject({
      cause: closeFailure,
      committed: true,
      name: "ServerRecorderCommittedError",
    });
  });

  it("exposes committed status when lock release fails after a durable append", async () => {
    const releaseFailure = new Error("simulated lock release failure");
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    lockMocks.release.mockRejectedValueOnce(releaseFailure).mockResolvedValue(undefined);
    const recorderPath = path.join(
      "/tmp",
      "crabline-server-recorder-committed-release-failed.jsonl",
    );

    await expect(
      recordServerEvent({
        event: serverEvent("/release-failed-after-commit"),
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

    await expect(
      recordServerEvent({
        event: serverEvent("/after-release-failure"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();
    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
  });

  it("fills short tail reads before repairing a torn final append", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-torn.jsonl");
    const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
    const torn = '{"type":"api","path":"/torn"';
    const contents = Buffer.from(completed + torn);
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: contents.length })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: contents.length });
    fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
      const source = contents.subarray(position, position + Math.min(length, 3));
      source.copy(buffer, offset);
      return { buffer, bytesRead: source.length };
    });

    await recordServerEvent({
      event: serverEvent("/after-recovery"),
      onEvent: () => undefined,
      recorderPath,
    });

    expect(fsMocks.file.truncate).toHaveBeenCalledWith(Buffer.byteLength(completed));
    expect(fsMocks.file.read.mock.calls.length).toBeGreaterThan(3);
    expect(fsMocks.file.appendFile).toHaveBeenLastCalledWith(
      `${JSON.stringify(serverEvent("/after-recovery"))}\n`,
      { encoding: "utf8" },
    );
    expect(fsMocks.file.sync).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === "win32")(
    "retries Windows torn-tail repair when the publication path disappears",
    async () => {
      const recorderPath = path.join("/tmp", "crabline-server-recorder-repair-race.jsonl");
      const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
      const contents = Buffer.from(`${completed}{"type":"api","path":"/torn"`);
      let repairAttempts = 0;
      fsMocks.file.stat.mockResolvedValue({
        dev: 1,
        ino: 1,
        nlink: 1,
        size: contents.length,
      });
      fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
        const source = contents.subarray(position, position + length);
        source.copy(buffer, offset);
        return { buffer, bytesRead: source.length };
      });
      fsMocks.open.mockImplementation(async (_filePath, flags) => {
        if (flags === "ax+") {
          throw Object.assign(new Error("Recorder already exists"), { code: "EEXIST" });
        }
        if (flags === "r+" && repairAttempts++ === 0) {
          throw Object.assign(new Error("Recorder rotated"), { code: "ENOENT" });
        }
        return typeof flags === "number" || flags === "r" ? fsMocks.directory : fsMocks.file;
      });

      await expect(
        recordServerEvent({
          event: serverEvent("/after-repair-race"),
          onEvent: undefined,
          recorderPath,
        }),
      ).resolves.toBeUndefined();

      expect(repairAttempts).toBe(2);
      expect(fsMocks.file.truncate).toHaveBeenCalledWith(Buffer.byteLength(completed));
      expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a replacement Windows repair handle with a colliding numeric file ID",
    async () => {
      const recorderPath = path.join("/tmp", "crabline-server-recorder-wide-file-id.jsonl");
      const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
      const contents = Buffer.from(`${completed}{"type":"api","path":"/torn"`);
      const originalInode = 2n ** 53n;
      const replacementInode = originalInode + 1n;
      let handleStatCalls = 0;
      fsMocks.file.stat.mockImplementation(async (options) => {
        const inode = handleStatCalls++ % 3 === 2 ? replacementInode : originalInode;
        return options?.bigint
          ? { dev: 1n, ino: inode, nlink: 1n, size: BigInt(contents.length) }
          : { dev: 1, ino: Number(inode), nlink: 1, size: contents.length };
      });
      fsMocks.stat.mockImplementation(async (_filePath, options) =>
        options?.bigint
          ? { dev: 1n, ino: originalInode, nlink: 1n, size: BigInt(contents.length) }
          : { dev: 1, ino: Number(originalInode), nlink: 1, size: contents.length },
      );
      fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
        const source = contents.subarray(position, position + length);
        source.copy(buffer, offset);
        return { buffer, bytesRead: source.length };
      });

      await expect(
        recordServerEvent({
          event: serverEvent("/after-wide-file-id-race"),
          onEvent: undefined,
          recorderPath,
        }),
      ).rejects.toThrow("Server recorder rotation retries exhausted");

      expect(fsMocks.file.truncate).not.toHaveBeenCalled();
      expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
    },
  );

  it("appends server records larger than four MiB", async () => {
    const event = {
      ...serverEvent("/oversized"),
      query: { payload: "x".repeat(4 * 1024 * 1024) },
    };

    await expect(
      recordServerEvent({
        event,
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-oversized.jsonl"),
      }),
    ).resolves.toBeUndefined();

    const recordedLine = fsMocks.file.appendFile.mock.calls[0]?.[0];
    expect(recordedLine).toBeDefined();
    expect(Buffer.byteLength(recordedLine!)).toBeGreaterThan(4 * 1024 * 1024);
    expect(JSON.parse(recordedLine!).query.payload).toHaveLength(4 * 1024 * 1024);
  });

  it("preserves a valid oversized legacy tail and restores its missing newline", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-valid-oversized-tail.jsonl");
    const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
    const legacyEvent = JSON.stringify({
      ...serverEvent("/legacy-oversized"),
      query: { payload: "x".repeat(4 * 1024 * 1024) },
    });
    const contents = Buffer.from(completed + legacyEvent);
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: contents.length })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: contents.length });
    fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
      const source = contents.subarray(position, position + length);
      source.copy(buffer, offset);
      return { buffer, bytesRead: source.length };
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/after-valid-oversized-tail"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.appendFile.mock.calls).toEqual([
      ["\n", { encoding: "utf8" }],
      [`${JSON.stringify(serverEvent("/after-valid-oversized-tail"))}\n`, { encoding: "utf8" }],
    ]);
  });

  it("repairs an exact 64 MiB valid tail after scanning its preceding delimiter", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-valid-boundary-tail.jsonl");
    const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
    const completedBuffer = Buffer.from(completed);
    const validationBudget = 64 * 1024 * 1024;
    const tailStart = completedBuffer.length;
    const fileSize = tailStart + validationBudget;
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: fileSize })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: fileSize });
    fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
      const bytesRead = Math.max(0, Math.min(length, fileSize - position));
      if (bytesRead === 0) {
        return { buffer, bytesRead };
      }
      buffer.fill(0x78, offset, offset + bytesRead);
      const completedStart = Math.max(0, position);
      const completedEnd = Math.min(position + bytesRead, tailStart);
      if (completedStart < completedEnd) {
        completedBuffer
          .subarray(completedStart, completedEnd)
          .copy(buffer, offset + completedStart - position);
      }
      if (position <= tailStart && tailStart < position + bytesRead) {
        buffer[offset + tailStart - position] = 0x22;
      }
      const tailEnd = fileSize - 1;
      if (position <= tailEnd && tailEnd < position + bytesRead) {
        buffer[offset + tailEnd - position] = 0x22;
      }
      return { buffer, bytesRead };
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/after-valid-boundary-tail"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.file.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 1, tailStart - 1);
    expect(fsMocks.file.read).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      validationBudget,
      tailStart,
    );
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.appendFile.mock.calls).toEqual([
      ["\n", { encoding: "utf8" }],
      [`${JSON.stringify(serverEvent("/after-valid-boundary-tail"))}\n`, { encoding: "utf8" }],
    ]);
  });

  it("truncates an invalid oversized torn tail without wedging later appends", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-oversized-tail.jsonl");
    const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
    const contents = Buffer.from(`${completed}{"payload":"${"x".repeat(4 * 1024 * 1024)}"`);
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: contents.length })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: contents.length });
    fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
      const source = contents.subarray(position, position + length);
      source.copy(buffer, offset);
      return { buffer, bytesRead: source.length };
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/after-oversized-tail"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.file.truncate).toHaveBeenCalledWith(Buffer.byteLength(completed));
    expect(fsMocks.file.appendFile).toHaveBeenLastCalledWith(
      `${JSON.stringify(serverEvent("/after-oversized-tail"))}\n`,
      { encoding: "utf8" },
    );
  });

  it("stops scanning a sparse no-newline tail at the validation budget without modifying it", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-unvalidated-tail.jsonl");
    const fileSize = 8 * 1024 * 1024 * 1024;
    const validationBudget = 64 * 1024 * 1024;
    fsMocks.file.stat
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: fileSize })
      .mockResolvedValueOnce({ dev: 1, ino: 1, nlink: 1, size: fileSize });
    fsMocks.file.read.mockImplementation(async (buffer, offset, length, position) => {
      if (length === 1 && position === fileSize - 1) {
        buffer[offset] = 0x7d;
        return { buffer, bytesRead: 1 };
      }
      buffer.fill(0, offset, offset + length);
      return { buffer, bytesRead: length };
    });

    await expect(
      recordServerEvent({
        event: serverEvent("/after-unvalidated-tail"),
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toThrow(
      "Server recorder final record is too large to validate safely; refusing to modify it.",
    );

    const scanCalls = fsMocks.file.read.mock.calls.filter(([, , length]) => length !== 1);
    expect(scanCalls).toHaveLength(1024);
    expect(scanCalls.reduce((total, [, , length]) => total + length, 0)).toBe(validationBudget);
    expect(Math.min(...scanCalls.map(([, , , position]) => position))).toBe(
      fileSize - validationBudget,
    );
    expect(fsMocks.file.read).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      1,
      fileSize - validationBudget - 1,
    );
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
  });

  it("serializes torn-tail recovery and append across recorder processes", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const actualLockfile =
      await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
    const directory = await actualFs.mkdtemp(
      path.join(os.tmpdir(), "crabline-server-recorder-process-"),
    );
    const recorderPath = path.join(directory, "events.jsonl");
    const completed = `${JSON.stringify(serverEvent("/completed"))}\n`;
    const initialContents = `${completed}{"type":"api","path":"/torn"`;
    let releaseGate: (() => Promise<void>) | undefined;
    const processes: RecorderProcess[] = [];
    try {
      await actualFs.writeFile(recorderPath, initialContents, { mode: 0o600 });
      releaseGate = await actualLockfile.lock(recorderPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
      });
      const first = startRecorderProcess(recorderPath, "/process-a");
      const second = startRecorderProcess(recorderPath, "/process-b");
      processes.push(first, second);

      await vi.waitFor(
        () => {
          expect(first.stdout()).toContain("ready\n");
          expect(second.stdout()).toContain("ready\n");
        },
        { timeout: 5_000 },
      );
      first.child.stdin.end("go\n");
      second.child.stdin.end("go\n");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(first.stdout()).not.toContain("done\n");
      expect(second.stdout()).not.toContain("done\n");
      await expect(actualFs.readFile(recorderPath, "utf8")).resolves.toBe(initialContents);

      await releaseGate();
      releaseGate = undefined;
      await vi.waitFor(
        () => {
          expect(first.stderr()).toBe("");
          expect(second.stderr()).toBe("");
          expect(first.stdout()).toContain("done\n");
          expect(second.stdout()).toContain("done\n");
        },
        { timeout: 15_000 },
      );
      await expect(Promise.all(processes.map((process) => process.exited))).resolves.toEqual([
        0, 0,
      ]);

      const recordedPaths = (await actualFs.readFile(recorderPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => (JSON.parse(line) as ServerRequestEvent).path)
        .sort();
      expect(recordedPaths).toEqual(["/completed", "/process-a", "/process-b"]);
    } finally {
      await releaseGate?.();
      for (const process of processes) {
        if (process.child.exitCode === null) {
          process.child.kill();
        }
      }
      await Promise.all(processes.map((process) => process.exited));
      await actualFs.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("serializes hardlink aliases across recorder processes", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const actualLockfile =
      await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
    const directory = await actualFs.mkdtemp(
      path.join(os.tmpdir(), "crabline-server-recorder-hardlink-"),
    );
    const recorderPath = path.join(directory, "events.jsonl");
    const aliasPath = path.join(directory, "events-alias.jsonl");
    const initialContents = `${JSON.stringify(serverEvent("/completed"))}\n{"path":"/torn"`;
    let releaseGate: (() => Promise<void>) | undefined;
    const processes: RecorderProcess[] = [];
    try {
      await actualFs.writeFile(recorderPath, initialContents, { mode: 0o600 });
      const identity = await actualFs.stat(recorderPath, { bigint: true });
      const lockRoot = path.join(directory, "shared-locks");
      await actualFs.mkdir(lockRoot, { mode: 0o700, recursive: true });
      await actualFs.chmod(lockRoot, 0o700);
      const canonicalLockRoot = await actualFs.realpath(lockRoot);
      releaseGate = await actualLockfile.lock(
        path.join(canonicalLockRoot, `recorder-${identity.ino}`),
        {
          realpath: false,
          stale: 30_000,
          update: 10_000,
        },
      );
      const first = startRecorderProcess(recorderPath, "/process-a", canonicalLockRoot);
      processes.push(first);

      await vi.waitFor(
        () => {
          expect(first.stdout()).toContain("ready\n");
        },
        { timeout: 5_000 },
      );
      first.child.stdin.end("go\n");
      const processLockPath =
        process.platform === "win32"
          ? serverRecorderWindowsLockPath(
              path.join(
                process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
                "Crabline",
                "locks",
                "server-recorder",
              ),
              recorderPath,
            )
          : recorderPath;
      await vi.waitFor(
        async () => {
          await expect(actualFs.stat(`${processLockPath}.lock`)).resolves.toBeDefined();
        },
        { timeout: 10_000 },
      );
      await actualFs.link(recorderPath, aliasPath);
      const second = startRecorderProcess(aliasPath, "/process-b", canonicalLockRoot);
      processes.push(second);
      await vi.waitFor(
        () => {
          expect(second.stdout()).toContain("ready\n");
        },
        { timeout: 5_000 },
      );
      second.child.stdin.end("go\n");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(first.stdout()).not.toContain("done\n");
      expect(second.stdout()).not.toContain("done\n");
      await expect(actualFs.readFile(recorderPath, "utf8")).resolves.toBe(initialContents);

      await releaseGate();
      releaseGate = undefined;
      await vi.waitFor(
        () => {
          expect(first.stderr()).toBe("");
          expect(second.stderr()).toBe("");
          expect(first.stdout()).toContain("done\n");
          expect(second.stdout()).toContain("done\n");
        },
        { timeout: 15_000 },
      );
      await expect(Promise.all(processes.map((process) => process.exited))).resolves.toEqual([
        0, 0,
      ]);

      const recordedPaths = (await actualFs.readFile(recorderPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => (JSON.parse(line) as ServerRequestEvent).path)
        .sort();
      expect(recordedPaths).toEqual(["/completed", "/process-a", "/process-b"]);
    } finally {
      await releaseGate?.();
      for (const process of processes) {
        if (process.child.exitCode === null) {
          process.child.kill();
        }
      }
      await Promise.all(processes.map((process) => process.exited));
      await actualFs.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("waits beyond five seconds for a live recorder owner", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const actualLockfile =
      await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
    const directory = await actualFs.mkdtemp(
      path.join(os.tmpdir(), "crabline-server-recorder-long-lock-"),
    );
    const recorderPath = path.join(directory, "events.jsonl");
    const initialContents = `${JSON.stringify(serverEvent("/completed"))}\n`;
    let releaseGate: (() => Promise<void>) | undefined;
    let recorderProcess: RecorderProcess | undefined;
    try {
      await actualFs.writeFile(recorderPath, initialContents, { mode: 0o600 });
      releaseGate = await actualLockfile.lock(recorderPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
      });
      recorderProcess = startRecorderProcess(recorderPath, "/after-long-lock");

      await vi.waitFor(
        () => {
          expect(recorderProcess?.stdout()).toContain("ready\n");
        },
        { timeout: 5_000 },
      );
      recorderProcess.child.stdin.end("go\n");
      await new Promise((resolve) => setTimeout(resolve, 5_500));

      expect(recorderProcess.stdout()).not.toContain("done\n");
      expect(recorderProcess.child.exitCode).toBeNull();
      await expect(actualFs.readFile(recorderPath, "utf8")).resolves.toBe(initialContents);

      await releaseGate();
      releaseGate = undefined;
      await vi.waitFor(
        () => {
          expect(recorderProcess?.stdout()).toContain("done\n");
        },
        { timeout: 5_000 },
      );
      await expect(recorderProcess.exited).resolves.toBe(0);

      const recordedPaths = (await actualFs.readFile(recorderPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => (JSON.parse(line) as ServerRequestEvent).path);
      expect(recordedPaths).toEqual(["/completed", "/after-long-lock"]);
    } finally {
      await releaseGate?.();
      if (recorderProcess?.child.exitCode === null) {
        recorderProcess.child.kill();
      }
      if (recorderProcess) {
        await recorderProcess.exited;
      }
      await actualFs.rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("invokes observers only after the event is durable", async () => {
    let releaseSync: (() => void) | undefined;
    const syncBlocked = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    fsMocks.file.sync.mockReturnValueOnce(syncBlocked);
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    const event = serverEvent("/ordered");

    const recording = recordServerEvent({
      event,
      onEvent: observer,
      recorderPath: path.join("/tmp", "crabline-server-recorder-order.jsonl"),
    });
    await vi.waitFor(() => expect(fsMocks.file.sync).toHaveBeenCalledTimes(1));
    expect(observer).not.toHaveBeenCalled();

    releaseSync?.();
    await recording;
    expect(observer).toHaveBeenCalledWith(event);
  });

  it("starts observers in durable append order without waiting for completion", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-observer-order.jsonl");
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = recordServerEvent({
      event: serverEvent("/first"),
      onEvent: async () => {
        order.push("first:start");
        await firstBlocked;
        order.push("first:end");
      },
      recorderPath,
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));

    const second = recordServerEvent({
      event: serverEvent("/second"),
      onEvent: () => {
        order.push("second");
      },
      recorderPath,
    });
    await vi.waitFor(() => expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(order).toEqual(["first:start", "second"]));

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "second", "first:end"]);
  });

  it("does not deadlock when an observer waits for a later externally registered event", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-external-wait.jsonl");
    let allowFirstToWait!: () => void;
    const secondRegistered = new Promise<void>((resolve) => {
      allowFirstToWait = resolve;
    });
    let second!: Promise<void>;
    const first = recordServerEvent({
      event: serverEvent("/first"),
      onEvent: async () => {
        await secondRegistered;
        await second;
      },
      recorderPath,
    });
    await vi.waitFor(() => expect(fsMocks.file.appendFile).toHaveBeenCalledOnce());

    second = recordServerEvent({
      event: serverEvent("/second"),
      onEvent: () => undefined,
      recorderPath,
    });
    allowFirstToWait();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
  });

  it("allows observers to append reentrantly to the same recorder", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-reentrant.jsonl");

    await recordServerEvent({
      event: serverEvent("/outer"),
      onEvent: async () => {
        await recordServerEvent({
          event: serverEvent("/nested"),
          onEvent: undefined,
          recorderPath,
        });
      },
      recorderPath,
    });

    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.sync).toHaveBeenCalledTimes(2);
  });

  it("allows nested observer registration on the same recorder", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-nested-observer.jsonl");
    const nestedObserver = vi.fn<(event: ServerRequestEvent) => void>();

    await recordServerEvent({
      event: serverEvent("/outer"),
      onEvent: async () => {
        await recordServerEvent({
          event: serverEvent("/nested"),
          onEvent: nestedObserver,
          recorderPath,
        });
      },
      recorderPath,
    });

    expect(nestedObserver).toHaveBeenCalledWith(serverEvent("/nested"));
    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
  });

  it("allows nested observers for independent recorder paths", async () => {
    const nestedObserver = vi.fn<(event: ServerRequestEvent) => void>();

    await recordServerEvent({
      event: serverEvent("/outer"),
      onEvent: async () => {
        await recordServerEvent({
          event: serverEvent("/nested"),
          onEvent: nestedObserver,
          recorderPath: path.join("/tmp", "crabline-server-recorder-independent-nested.jsonl"),
        });
      },
      recorderPath: path.join("/tmp", "crabline-server-recorder-independent-outer.jsonl"),
    });

    expect(nestedObserver).toHaveBeenCalledWith(serverEvent("/nested"));
    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
  });

  it("starts nested observers after prior invocation without waiting for completion", async () => {
    const firstPath = path.join("/tmp", "crabline-server-recorder-active-independent.jsonl");
    const secondPath = path.join("/tmp", "crabline-server-recorder-waiting-independent.jsonl");
    const nestedObserver = vi.fn<(event: ServerRequestEvent) => void>();
    let reportFirstActive!: () => void;
    let releaseFirst!: () => void;
    const firstActive = new Promise<void>((resolve) => {
      reportFirstActive = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = recordServerEvent({
      event: serverEvent("/first"),
      onEvent: async () => {
        reportFirstActive();
        await firstBlocked;
      },
      recorderPath: firstPath,
    });
    await firstActive;

    const second = recordServerEvent({
      event: serverEvent("/second"),
      onEvent: async () => {
        await recordServerEvent({
          event: serverEvent("/nested-on-first"),
          onEvent: nestedObserver,
          recorderPath: firstPath,
        });
      },
      recorderPath: secondPath,
    });
    await vi.waitFor(() => expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(nestedObserver).toHaveBeenCalledWith(serverEvent("/nested-on-first")),
    );

    releaseFirst();
    await Promise.all([first, second]);
  });

  it("allows active observers to append across recorder paths without deadlocking", async () => {
    const firstPath = path.join("/tmp", "crabline-server-recorder-cycle-first.jsonl");
    const secondPath = path.join("/tmp", "crabline-server-recorder-cycle-second.jsonl");
    let activeObservers = 0;
    let releaseObservers: (() => void) | undefined;
    const observersReady = new Promise<void>((resolve) => {
      releaseObservers = resolve;
    });
    const waitForBothObservers = async () => {
      activeObservers += 1;
      if (activeObservers === 2) {
        releaseObservers?.();
      }
      await observersReady;
    };

    const first = recordServerEvent({
      event: serverEvent("/first"),
      onEvent: async () => {
        await waitForBothObservers();
        await recordServerEvent({
          event: serverEvent("/first-to-second"),
          onEvent: () => undefined,
          recorderPath: secondPath,
        });
      },
      recorderPath: firstPath,
    });
    const second = recordServerEvent({
      event: serverEvent("/second"),
      onEvent: async () => {
        await waitForBothObservers();
        await recordServerEvent({
          event: serverEvent("/second-to-first"),
          onEvent: () => undefined,
          recorderPath: firstPath,
        });
      },
      recorderPath: secondPath,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(4);
  });

  it("keeps later appends available after an observer failure", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-observer.jsonl");
    const observerFailure = new Error("observer failed");

    await expect(
      recordServerEvent({
        event: serverEvent("/first"),
        onEvent: async () => {
          throw observerFailure;
        },
        recorderPath,
      }),
    ).rejects.toMatchObject({
      cause: observerFailure,
      committed: true,
      name: "ServerRecorderCommittedError",
    });
    await expect(
      recordServerEvent({
        event: serverEvent("/second"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
    expect(fsMocks.file.sync).toHaveBeenCalledTimes(2);
  });

  it("propagates an undefined observer rejection without retrying", async () => {
    const error = await recordServerEvent({
      event: serverEvent("/undefined-rejection"),
      onEvent: async () => await Promise.reject(),
      recorderPath: path.join("/tmp", "crabline-server-recorder-undefined-rejection.jsonl"),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toMatchObject({
      cause: undefined,
      committed: true,
      name: "ServerRecorderCommittedError",
    });
    expect(fsMocks.file.appendFile).toHaveBeenCalledOnce();
    expect(fsMocks.file.truncate).not.toHaveBeenCalled();
  });

  it("does not surface telemetry failure after a committed mutation", async () => {
    const observerFailure = new Error("observer failed");

    await expect(
      recordCommittedServerEvent({
        event: serverEvent("/committed"),
        onEvent: async () => {
          throw observerFailure;
        },
        recorderPath: path.join("/tmp", "crabline-server-recorder-committed.jsonl"),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not surface serialization failure after a committed mutation", async () => {
    const event = serverEvent("/committed-cycle");
    (event.query as Record<string, unknown>).cycle = event;

    await expect(
      recordCommittedServerEvent({
        event,
        onEvent: undefined,
        recorderPath: path.join("/tmp", "crabline-server-recorder-committed-cycle.jsonl"),
      }),
    ).resolves.toBeUndefined();
    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();
  });
});
