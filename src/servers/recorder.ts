import { chmod, lstat, mkdir, open, readlink, realpath, stat as statPath } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { ServerRequestEvent } from "./http.js";

export type ServerEventObserver = (event: ServerRequestEvent) => void | Promise<void>;

export class ServerRecorderCommittedError extends AggregateError {
  readonly committed = true;
  readonly indeterminate: boolean;

  constructor(
    filePath: string,
    operationError: unknown,
    relatedErrors: unknown[] = [],
    indeterminate = false,
  ) {
    super(
      [operationError, ...relatedErrors],
      indeterminate
        ? `Server recorder append may have been published for "${filePath}", but completion is indeterminate.`
        : `Server recorder append committed for "${filePath}", but subsequent work failed.`,
      { cause: operationError },
    );
    this.name = "ServerRecorderCommittedError";
    this.indeterminate = indeterminate;
  }
}

class ServerRecorderRotationError extends Error {}

const pendingAppends = new Map<string, Promise<void>>();
const pendingAdmissions = new Map<string, Promise<void>>();
const pendingObservers = new Map<string, Promise<void>>();
const durableRecorderIdentities = new Map<string, string>();
const MAX_DURABLE_RECORDER_IDENTITIES = 128;
const MAX_RECOVERY_VALIDATION_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_SCAN_BYTES = MAX_RECOVERY_VALIDATION_BYTES + 1;
const RECORDER_LOCK_RETRY_MS = 100;
const RECORDER_LOCK_STALE_MS = 30_000;
const RECORDER_LOCK_UPDATE_MS = 10_000;
const RECORDER_LOCK_WAIT_MARGIN_MS = 5_000;
const RECORDER_PATH_ATTEMPTS = 3;
const RECORDER_ROTATION_ATTEMPTS = 3;
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

async function recorderPathHasIdentity(
  filePath: string,
  expectedIdentity: string,
): Promise<boolean> {
  try {
    return recorderIdentity(await statPath(filePath)) === expectedIdentity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireRecorderIdentity(stats: { dev?: bigint | number; ino?: bigint | number }): string {
  const identity = recorderIdentity(stats);
  if (identity === undefined) {
    throw new Error("Server recorder file identity is unavailable.");
  }
  return identity;
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
): AggregateError | ServerRecorderCommittedError {
  if (operationError instanceof ServerRecorderCommittedError) {
    return new ServerRecorderCommittedError(
      filePath,
      operationError,
      [releaseError],
      operationError.indeterminate,
    );
  }
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
  const deadline = performance.now() + RECORDER_LOCK_STALE_MS + RECORDER_LOCK_WAIT_MARGIN_MS;
  for (;;) {
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
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(RECORDER_LOCK_RETRY_MS, remainingMs)),
      );
    }
  }
}

async function withRecorderLock(
  filePath: string,
  operation: () => Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  const release = await acquireRecorderLock(filePath);
  let operationFailed = false;
  let operationError: unknown;
  let result: boolean | undefined;
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
    if (result === true) {
      throw new ServerRecorderCommittedError(filePath, releaseError);
    }
    throw releaseError;
  }
  if (operationFailed) {
    throw operationError;
  }
  return result;
}

async function closeRecorderAttempt(params: {
  committed: boolean;
  file: Awaited<ReturnType<typeof open>>;
  filePath: string;
  operationFailed: boolean;
  operationError: unknown;
}): Promise<void> {
  let closeFailed = false;
  let closeError: unknown;
  try {
    await params.file.close();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (closeFailed) {
    if (params.operationFailed) {
      if (params.operationError instanceof ServerRecorderCommittedError) {
        throw new ServerRecorderCommittedError(
          params.filePath,
          params.operationError,
          [closeError],
          params.operationError.indeterminate,
        );
      }
      throw new AggregateError(
        [params.operationError, closeError],
        "Server recorder operation and file close both failed.",
        { cause: closeError },
      );
    }
    if (params.committed) {
      throw new ServerRecorderCommittedError(params.filePath, closeError);
    }
    throw closeError;
  }
  if (params.operationFailed) {
    throw params.operationError;
  }
}

async function appendRecorderAttempt(params: {
  createdDirectory: string | undefined;
  logicalPath: string;
  line: string;
  publicationPath: string;
}): Promise<"committed" | "retry"> {
  const opened = await openRecorderFile(params.publicationPath);
  const { file } = opened;
  let committed = false;
  let operationFailed = false;
  let operationError: unknown;
  let result: "committed" | "retry" | undefined;
  try {
    await file.chmod(0o600);
    let stats = await file.stat();
    let identity = requireRecorderIdentity(stats);
    if (!(await recorderPathHasIdentity(params.publicationPath, identity))) {
      result = "retry";
    } else {
      const needsPathDurability =
        opened.created || durableRecorderIdentities.get(params.publicationPath) !== identity;
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
      stats = await file.stat();
      identity = requireRecorderIdentity(stats);
      if (!(await recorderPathHasIdentity(params.publicationPath, identity))) {
        result = "retry";
      } else {
        try {
          await file.appendFile(params.line, { encoding: "utf8" });
          await file.sync();
          if (
            !(await recorderPathHasIdentity(params.publicationPath, identity)) ||
            (await resolveRecorderPath(params.logicalPath)) !== params.publicationPath
          ) {
            throw new ServerRecorderCommittedError(
              params.logicalPath,
              new ServerRecorderRotationError("Server recorder rotated during append."),
            );
          } else {
            if (needsPathDurability) {
              const firstCreatedPath =
                params.createdDirectory ?? (opened.created ? params.publicationPath : undefined);
              await syncRecorderPathAncestry(params.publicationPath, firstCreatedPath);
            }
            if (
              !(await recorderPathHasIdentity(params.publicationPath, identity)) ||
              (await resolveRecorderPath(params.logicalPath)) !== params.publicationPath
            ) {
              throw new ServerRecorderCommittedError(
                params.logicalPath,
                new ServerRecorderRotationError(
                  "Server recorder rotated while syncing path ancestry.",
                ),
              );
            } else {
              rememberDurableRecorderIdentity(params.publicationPath, identity);
              committed = true;
              result = "committed";
            }
          }
        } catch (error) {
          if (error instanceof ServerRecorderCommittedError) {
            throw error;
          }
          throw new ServerRecorderCommittedError(params.logicalPath, error, [], true);
        }
      }
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  await closeRecorderAttempt({
    committed,
    file,
    filePath: params.logicalPath,
    operationError,
    operationFailed,
  });
  return result ?? "retry";
}

async function resolveRecorderPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      const target = await readlink(filePath);
      return await resolveRecorderPath(path.resolve(path.dirname(filePath), target));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return path.join(await resolveRecorderPath(path.dirname(filePath)), path.basename(filePath));
}

function enqueueObserver(params: {
  event: ServerRequestEvent;
  key: string;
  logicalPath: string;
  onEvent: ServerEventObserver | undefined;
}): Promise<void> {
  if (params.onEvent === undefined) {
    return Promise.resolve();
  }
  const previous = pendingObservers.get(params.key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      try {
        await params.onEvent?.(params.event);
      } catch (error) {
        throw new ServerRecorderCommittedError(params.logicalPath, error);
      }
    });
  pendingObservers.set(params.key, current);
  void current.then(
    () => {
      if (pendingObservers.get(params.key) === current) {
        pendingObservers.delete(params.key);
      }
    },
    () => {
      if (pendingObservers.get(params.key) === current) {
        pendingObservers.delete(params.key);
      }
    },
  );
  return current;
}

type RecorderAppendResult = {
  observation: Promise<void>;
};

async function appendResolvedJsonLine(params: {
  event: ServerRequestEvent;
  line: string;
  logicalPath: string;
  onEvent: ServerEventObserver | undefined;
}): Promise<RecorderAppendResult | undefined> {
  const { logicalPath } = params;
  const key = await resolveRecorderPath(logicalPath);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      const directory = path.dirname(key);
      const createdDirectory = await mkdir(directory, { mode: 0o700, recursive: true });
      if (createdDirectory !== undefined || isManagedRecorderDirectory(directory)) {
        await chmod(directory, 0o700);
      }
      // Keep the cross-process lock through append verification.
      const committed = await withRecorderLock(key, async () => {
        if ((await resolveRecorderPath(logicalPath)) !== key) {
          return undefined;
        }
        for (let attempt = 0; attempt < RECORDER_ROTATION_ATTEMPTS; attempt++) {
          if (
            (await appendRecorderAttempt({
              createdDirectory,
              logicalPath,
              line: params.line,
              publicationPath: key,
            })) === "committed"
          ) {
            return true;
          }
        }
        throw new ServerRecorderRotationError(
          `Server recorder rotation retries exhausted for "${logicalPath}".`,
        );
      });
      if (committed !== true) {
        return undefined;
      }
      return {
        observation: enqueueObserver({
          event: params.event,
          key,
          logicalPath,
          onEvent: params.onEvent,
        }),
      };
    });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  pendingAppends.set(key, tail);

  try {
    return await current;
  } finally {
    if (pendingAppends.get(key) === tail) {
      pendingAppends.delete(key);
    }
  }
}

async function appendJsonLine(params: {
  event: ServerRequestEvent;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
}): Promise<void> {
  const logicalPath = path.resolve(params.recorderPath);
  const previous = pendingAdmissions.get(logicalPath) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      for (let attempt = 0; attempt < RECORDER_PATH_ATTEMPTS; attempt++) {
        const result = await appendResolvedJsonLine({
          event: params.event,
          line: `${JSON.stringify(params.event)}\n`,
          logicalPath,
          onEvent: params.onEvent,
        });
        if (result !== undefined) {
          return result;
        }
      }
      throw new ServerRecorderRotationError(
        `Server recorder path retries exhausted for "${logicalPath}".`,
      );
    });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  pendingAdmissions.set(logicalPath, tail);

  let result: RecorderAppendResult;
  try {
    result = await current;
  } finally {
    if (pendingAdmissions.get(logicalPath) === tail) {
      pendingAdmissions.delete(logicalPath);
    }
  }
  await result.observation;
}

export async function recordServerEvent(params: {
  event: ServerRequestEvent;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
}): Promise<void> {
  await appendJsonLine(params);
}

export async function recordCommittedServerEvent(params: {
  event: ServerRequestEvent;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
}): Promise<void> {
  try {
    await appendJsonLine(params);
  } catch {
    // The provider mutation already committed, so telemetry failure cannot change its response.
  }
}
