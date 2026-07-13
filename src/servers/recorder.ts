import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { ServerRequestEvent } from "./http.js";

export type ServerEventObserver = (event: ServerRequestEvent) => void | Promise<void>;

const pendingAppends = new Map<string, Promise<void>>();
const durableRecorderIdentities = new Map<string, string>();
const MAX_DURABLE_RECORDER_IDENTITIES = 128;
const MAX_RECOVERY_VALIDATION_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_SCAN_BYTES = MAX_RECOVERY_VALIDATION_BYTES + 1;
const RECORDER_LOCK_RETRY_MS = 100;
const RECORDER_LOCK_STALE_MS = 30_000;
const RECORDER_LOCK_UPDATE_MS = 10_000;
const TAIL_SCAN_CHUNK_BYTES = 64 * 1024;

function isManagedRecorderDirectory(directory: string): boolean {
  return (
    directory === path.resolve(".crabline", "servers") ||
    directory === path.resolve("artifacts", "crabline")
  );
}

async function readBufferAt(
  file: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await file.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

async function findIncompleteTailStart(
  file: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<number> {
  let position = fileSize;
  while (position > 0) {
    const scannedBytes = fileSize - position;
    const remainingScanBytes = MAX_RECOVERY_SCAN_BYTES - scannedBytes;
    if (remainingScanBytes <= 0) {
      throw recoveryValidationLimitError();
    }
    const chunkStart = Math.max(0, position - Math.min(TAIL_SCAN_CHUNK_BYTES, remainingScanBytes));
    const chunk = await readBufferAt(file, position - chunkStart, chunkStart);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      return chunkStart + lastNewline + 1;
    }
    if (chunk.length === 0) {
      break;
    }
    position = chunkStart;
  }
  return 0;
}

function recoveryValidationLimitError(): Error {
  return new Error(
    "Server recorder final record is too large to validate safely; refusing to modify it.",
  );
}

async function openRecorderFile(
  filePath: string,
): Promise<{ created: boolean; file: Awaited<ReturnType<typeof open>> }> {
  try {
    return {
      created: true,
      file: await open(filePath, "ax+", 0o600),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return {
      created: false,
      file: await open(filePath, "a+", 0o600),
    };
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function syncRecorderPathAncestry(
  filePath: string,
  firstCreatedDirectory?: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const resolvedFilePath = path.resolve(filePath);
  let currentPath = resolvedFilePath;
  const syncThroughPath =
    firstCreatedDirectory === undefined ? undefined : path.resolve(firstCreatedDirectory);
  for (;;) {
    const directoryPath = path.dirname(currentPath);
    const mandatory = syncThroughPath !== undefined || currentPath === resolvedFilePath;
    try {
      await syncDirectory(directoryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!mandatory && (code === "EACCES" || code === "EPERM")) {
        return;
      }
      throw error;
    }
    if (currentPath === syncThroughPath) {
      return;
    }
    if (path.dirname(directoryPath) === directoryPath) {
      return;
    }
    currentPath = directoryPath;
  }
}

function recorderIdentity(stats: {
  dev?: bigint | number;
  ino?: bigint | number;
}): string | undefined {
  if (stats.dev === undefined || stats.ino === undefined) {
    return undefined;
  }
  return `${stats.dev}:${stats.ino}`;
}

function rememberDurableRecorderIdentity(filePath: string, identity: string): void {
  durableRecorderIdentities.delete(filePath);
  durableRecorderIdentities.set(filePath, identity);
  if (durableRecorderIdentities.size > MAX_DURABLE_RECORDER_IDENTITIES) {
    const oldestPath = durableRecorderIdentities.keys().next().value;
    if (oldestPath !== undefined) {
      durableRecorderIdentities.delete(oldestPath);
    }
  }
}

function recorderLockReleaseError(
  filePath: string,
  operationError: unknown,
  releaseError: unknown,
): AggregateError {
  return new AggregateError(
    [operationError, releaseError],
    `Server recorder append and lock release both failed for "${filePath}".`,
    { cause: operationError },
  );
}

function isRecorderLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ELOCKED"
  );
}

async function acquireRecorderLock(filePath: string): Promise<() => Promise<void>> {
  while (true) {
    try {
      return await lock(filePath, {
        realpath: false,
        retries: 0,
        stale: RECORDER_LOCK_STALE_MS,
        update: RECORDER_LOCK_UPDATE_MS,
      });
    } catch (error) {
      if (!isRecorderLockContention(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RECORDER_LOCK_RETRY_MS));
    }
  }
}

async function withRecorderLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireRecorderLock(filePath);
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (operationFailed) {
      throw recorderLockReleaseError(filePath, operationError, releaseError);
    }
    throw releaseError;
  }
  if (operationFailed) {
    throw operationError;
  }
  return result as T;
}

async function appendJsonLine(filePath: string, line: string, durable: boolean): Promise<void> {
  const key = path.resolve(filePath);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      const directory = path.dirname(filePath);
      const createdDirectory = await mkdir(directory, { mode: 0o700, recursive: true });
      if (createdDirectory !== undefined || isManagedRecorderDirectory(path.resolve(directory))) {
        await chmod(directory, 0o700);
      }
      await withRecorderLock(key, async () => {
        const opened = await openRecorderFile(filePath);
        const { file } = opened;
        try {
          await file.chmod(0o600);
          const stats = await file.stat();
          const identity = recorderIdentity(stats);
          const needsPathDurability =
            opened.created ||
            identity === undefined ||
            durableRecorderIdentities.get(key) !== identity;
          if (stats.size > 0) {
            const finalByte = await readBufferAt(file, 1, stats.size - 1);
            if (finalByte[0] !== 0x0a) {
              const tailStart = await findIncompleteTailStart(file, stats.size);
              const tailLength = stats.size - tailStart;
              if (tailLength > MAX_RECOVERY_VALIDATION_BYTES) {
                throw recoveryValidationLimitError();
              }
              const tail = await readBufferAt(file, tailLength, tailStart);
              if (tail.length !== tailLength) {
                throw new Error("Server recorder changed while repairing its final record.");
              }
              try {
                JSON.parse(tail.toString("utf8"));
                await file.appendFile("\n", { encoding: "utf8" });
              } catch (error) {
                if (!(error instanceof SyntaxError)) {
                  throw error;
                }
                await file.truncate(tailStart);
              }
            }
          }
          await file.appendFile(line, { encoding: "utf8" });
          if (durable || needsPathDurability) {
            await file.sync();
          }
          if (needsPathDurability) {
            const firstCreatedPath =
              createdDirectory ?? (opened.created ? path.resolve(filePath) : undefined);
            await syncRecorderPathAncestry(filePath, firstCreatedPath);
            if (identity === undefined) {
              durableRecorderIdentities.delete(key);
            } else {
              rememberDurableRecorderIdentity(key, identity);
            }
          }
        } finally {
          await file.close();
        }
      });
    });
  pendingAppends.set(key, current);

  try {
    await current;
  } finally {
    if (pendingAppends.get(key) === current) {
      pendingAppends.delete(key);
    }
  }
}

export async function recordServerEvent(params: {
  event: ServerRequestEvent;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
}): Promise<void> {
  // Observers only see events after the recorder append is durable.
  await appendJsonLine(
    params.recorderPath,
    `${JSON.stringify(params.event)}\n`,
    params.onEvent !== undefined,
  );
  await params.onEvent?.(params.event);
}

export async function recordCommittedServerEvent(params: {
  event: ServerRequestEvent;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
}): Promise<void> {
  try {
    await recordServerEvent(params);
  } catch {
    // The provider mutation already committed, so telemetry failure cannot change its response.
  }
}
