import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import { createProcessOwnedLockFileSystem } from "../platform/process-owned-lock.js";
import { createOwnerOnlyWindowsDirectory } from "../platform/windows-acl.js";
import type { InboundEnvelope } from "./types.js";

export type RecordableInboundEnvelope = InboundEnvelope & {
  recordedDirection?: "inbound" | "outbound";
};

export type RecordedInboundEnvelope = RecordableInboundEnvelope & {
  recordedAt: string;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const pendingAppends = new Map<string, Promise<void>>();
const recordIdentityIndexes = new Map<string, RecordIdentityIndex>();
const securedWindowsLockRoots = new Map<string, Promise<{ dev: bigint; ino: bigint }>>();
const MAX_RECORD_IDENTITY_INDEXES = 128;
const MAX_RECENT_RECORD_KEYS = 4096;
const RECORDER_BATCH_VERSION = 1;
const RECORDER_LOCK_STALE_MS = 30_000;
const RECORDER_LOCK_UPDATE_MS = 10_000;
const RECORDER_ROTATION_ATTEMPTS = 3;

class RecorderRotatedError extends Error {}

export class ProviderRecorderCommittedError extends AggregateError {
  readonly committed = true;
  readonly indeterminate = true;

  constructor(filePath: string, cause: unknown, relatedErrors: unknown[] = []) {
    super(
      [cause, ...relatedErrors],
      `Provider recorder append was published for "${filePath}", but durability or identity confirmation failed.`,
      { cause },
    );
    this.name = "ProviderRecorderCommittedError";
  }
}

type IncrementalReadState = {
  caughtUp: boolean;
  continuity: Buffer;
  generation: number;
  identity:
    | {
        dev: bigint;
        ino: bigint;
      }
    | undefined;
  offset: number;
  pending: Buffer;
};

type RecordIdentityIndex = {
  readState: IncrementalReadState;
  seen: Set<string>;
};

type RecorderFileIdentity = {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
};

type RecordedInboundBatchLine = {
  events: RecordedInboundEnvelope[];
  recordType: "crabline.recorder.batch";
  recorderBatchVersion: typeof RECORDER_BATCH_VERSION;
};

export type RecordedInboundCursor = {
  buffered: RecordedInboundEnvelope[];
  readState: IncrementalReadState;
  seen: Set<string>;
};

const CONTINUITY_BYTES = 4096;
const MAX_INCREMENTAL_READ_BYTES = 256 * 1024;
const MAX_PENDING_RECORD_BYTES = 4 * 1024 * 1024;

function createIncrementalReadState(): IncrementalReadState {
  return {
    caughtUp: true,
    continuity: Buffer.alloc(0),
    generation: 0,
    identity: undefined,
    offset: 0,
    pending: Buffer.alloc(0),
  };
}

function snapshotIncrementalReadState(state: IncrementalReadState): IncrementalReadState {
  return {
    ...state,
    identity: state.identity ? { ...state.identity } : undefined,
  };
}

function restoreIncrementalReadState(
  state: IncrementalReadState,
  snapshot: IncrementalReadState,
): void {
  state.caughtUp = snapshot.caughtUp;
  state.continuity = snapshot.continuity;
  state.generation = snapshot.generation;
  state.identity = snapshot.identity;
  state.offset = snapshot.offset;
  state.pending = snapshot.pending;
}

export function createRecordedInboundCursor(): RecordedInboundCursor {
  return {
    buffered: [],
    readState: createIncrementalReadState(),
    seen: new Set(),
  };
}

export function cloneRecordedInboundCursor(cursor: RecordedInboundCursor): RecordedInboundCursor {
  return {
    buffered: [...cursor.buffered],
    readState: {
      caughtUp: cursor.readState.caughtUp,
      continuity: Buffer.from(cursor.readState.continuity),
      generation: cursor.readState.generation,
      identity: cursor.readState.identity ? { ...cursor.readState.identity } : undefined,
      offset: cursor.readState.offset,
      pending: Buffer.from(cursor.readState.pending),
    },
    seen: new Set(cursor.seen),
  };
}

function rememberRecentRecord(seen: Set<string>, event: InboundEnvelope): boolean {
  const key = JSON.stringify([
    event.provider,
    event.threadId,
    event.id,
    recordedDirectionOf(event),
  ]);
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  if (seen.size > MAX_RECENT_RECORD_KEYS) {
    seen.delete(seen.values().next().value!);
  }
  return true;
}

function recordedDirectionOf(
  event: Pick<RecordableInboundEnvelope, "raw" | "recordedDirection">,
): "inbound" | "outbound" {
  if (event.recordedDirection) {
    return event.recordedDirection;
  }
  return event.raw !== null &&
    typeof event.raw === "object" &&
    "direction" in event.raw &&
    event.raw.direction === "outbound"
    ? "outbound"
    : "inbound";
}

function requireNonEmptyString(value: unknown, field: keyof RecordedInboundEnvelope): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Recorded inbound envelope ${field} must be a non-empty string.`);
  }
  return value;
}

function requireString(value: unknown, field: keyof RecordedInboundEnvelope): string {
  if (typeof value !== "string") {
    throw new Error(`Recorded inbound envelope ${field} must be a string.`);
  }
  return value;
}

function parseRecordedEnvelope(value: unknown): RecordedInboundEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recorded inbound envelope must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.author !== "assistant" && record.author !== "system" && record.author !== "user") {
    throw new Error("Recorded inbound envelope author must be assistant, system, or user.");
  }
  if (
    record.recordedDirection !== undefined &&
    record.recordedDirection !== "inbound" &&
    record.recordedDirection !== "outbound"
  ) {
    throw new Error("Recorded inbound envelope recordedDirection must be inbound or outbound.");
  }
  return {
    author: record.author,
    id: requireNonEmptyString(record.id, "id"),
    provider: requireNonEmptyString(record.provider, "provider"),
    ...(record.raw !== undefined ? { raw: record.raw } : {}),
    recordedAt: requireNonEmptyString(record.recordedAt, "recordedAt"),
    ...(record.recordedDirection !== undefined
      ? { recordedDirection: record.recordedDirection }
      : {}),
    sentAt: requireNonEmptyString(record.sentAt, "sentAt"),
    text: requireString(record.text, "text"),
    threadId: requireNonEmptyString(record.threadId, "threadId"),
  };
}

function parseRecordedLine(line: string): RecordedInboundEnvelope[] {
  const parsed = JSON.parse(line) as unknown;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "recordType" in parsed &&
    parsed.recordType === "crabline.recorder.batch" &&
    "recorderBatchVersion" in parsed &&
    parsed.recorderBatchVersion === RECORDER_BATCH_VERSION &&
    "events" in parsed &&
    Array.isArray(parsed.events)
  ) {
    return parsed.events.map(parseRecordedEnvelope);
  }
  return [parseRecordedEnvelope(parsed)];
}

function resetIncrementalReadState(state: IncrementalReadState): void {
  if (
    state.identity !== undefined ||
    state.offset > 0 ||
    state.pending.length > 0 ||
    state.continuity.length > 0
  ) {
    state.generation += 1;
  }
  state.caughtUp = true;
  state.continuity = Buffer.alloc(0);
  state.offset = 0;
  state.pending = Buffer.alloc(0);
}

async function readBufferAt(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;

  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }

  return buffer.subarray(0, bytesRead);
}

function consumeRecordedChunk(
  state: IncrementalReadState,
  chunk: Buffer,
): RecordedInboundEnvelope[] {
  const continuity = Buffer.concat([state.continuity, chunk]);
  state.continuity = Buffer.from(continuity.subarray(-CONTINUITY_BYTES));

  const raw = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
  const lastNewline = raw.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    if (raw.length > MAX_PENDING_RECORD_BYTES) {
      throw new Error(
        `Recorder record exceeded ${MAX_PENDING_RECORD_BYTES} bytes without a newline.`,
      );
    }
    state.pending = Buffer.from(raw);
    return [];
  }

  state.pending = Buffer.from(raw.subarray(lastNewline + 1));
  if (state.pending.length > MAX_PENDING_RECORD_BYTES) {
    throw new Error(
      `Recorder record exceeded ${MAX_PENDING_RECORD_BYTES} bytes without a newline.`,
    );
  }

  const events: RecordedInboundEnvelope[] = [];
  for (const line of raw.subarray(0, lastNewline).toString("utf8").split("\n")) {
    if (line.trim()) {
      events.push(...parseRecordedLine(line));
    }
  }
  return events;
}

async function appendJsonLine(
  filePath: string,
  line: string,
  firstCreatedDirectory?: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await serializeAppend(
        filePath,
        async (publicationPath, logicalPath, _lockCreatedFile, lockedIdentity) => {
          await appendCommittedLine(
            publicationPath,
            logicalPath,
            line,
            true,
            lockedIdentity,
            firstCreatedDirectory,
          );
        },
      );
      return;
    } catch (error) {
      if (!(error instanceof RecorderRotatedError) || attempt + 1 >= RECORDER_ROTATION_ATTEMPTS) {
        throw error;
      }
    }
  }
}

async function readRecorderFileIdentity(
  filePath: string,
): Promise<RecorderFileIdentity | undefined> {
  try {
    const stats = await lstat(filePath, { bigint: true });
    if (!stats.isFile()) {
      throw new Error(`Recorder path is not a regular file: ${filePath}`);
    }
    return {
      dev: stats.dev,
      ino: stats.ino,
      nlink: stats.nlink,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sameRecorderFileIdentity(
  left: RecorderFileIdentity | undefined,
  right: RecorderFileIdentity | undefined,
): boolean {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameRecorderLockIdentity(
  left: RecorderFileIdentity | undefined,
  right: RecorderFileIdentity | undefined,
): boolean {
  return sameRecorderFileIdentity(left, right) && left?.nlink === right?.nlink;
}

async function resolveRecorderPublicationPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(filePath);
      return await resolveRecorderPublicationPath(path.resolve(path.dirname(filePath), target));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return path.join(await realpath(path.dirname(filePath)), path.basename(filePath));
}

async function openRecorderForAppend(
  filePath: string,
): Promise<{ created: boolean; handle: Awaited<ReturnType<typeof open>> }> {
  try {
    return {
      created: true,
      handle: await open(filePath, "ax+", 0o600),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return {
      created: false,
      handle: await open(filePath, "a+", 0o600),
    };
  }
}

async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await open(path.dirname(filePath), "r");
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
      await syncParentDirectory(currentPath);
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

async function prepareRecorderTailForAppend(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<boolean> {
  const stats = await handle.stat();
  if (stats.size === 0) {
    return false;
  }

  const finalByte = await readBufferAt(handle, 1, stats.size - 1);
  if (finalByte[0] === 0x0a) {
    return false;
  }

  const windowSize = Math.min(stats.size, MAX_PENDING_RECORD_BYTES + 1);
  const tailWindow = await readBufferAt(handle, windowSize, stats.size - windowSize);
  const lastNewline = tailWindow.lastIndexOf(0x0a);
  if (lastNewline < 0 && stats.size > MAX_PENDING_RECORD_BYTES) {
    throw new Error(
      `Recorder record exceeded ${MAX_PENDING_RECORD_BYTES} bytes without a newline.`,
    );
  }

  const tailStart = stats.size - windowSize + lastNewline + 1;
  const tail = tailWindow.subarray(lastNewline + 1).toString("utf8");
  try {
    parseRecordedLine(tail);
    await handle.writeFile("\n", "utf8");
    return true;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    await handle.truncate(tailStart);
    return true;
  }
}

async function prepareRecorderPathForAppend(
  publicationPath: string,
  logicalPath: string,
  durable: boolean,
  expectedIdentity?: RecorderFileIdentity,
): Promise<{ created: boolean; identity: RecorderFileIdentity }> {
  const opened = await openRecorderForAppend(publicationPath);
  const { handle } = opened;
  const identity = await handle.stat({ bigint: true });
  const recorderIdentity = { dev: identity.dev, ino: identity.ino, nlink: identity.nlink };
  try {
    if (
      expectedIdentity !== undefined &&
      !sameRecorderFileIdentity(expectedIdentity, recorderIdentity)
    ) {
      throw new RecorderRotatedError("Recorder rotated before preparing a committed line.");
    }
    const changed = await prepareRecorderTailForAppend(handle);
    if (changed && durable) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }

  if (
    !sameRecorderFileIdentity(
      recorderIdentity,
      await readRecorderFileIdentity(await resolveRecorderPublicationPath(logicalPath)),
    )
  ) {
    throw new RecorderRotatedError("Recorder rotated while preparing a committed line.");
  }
  return { created: opened.created, identity: recorderIdentity };
}

function providerRecorderCloseError(
  filePath: string,
  operationError: unknown,
  closeError: unknown,
): AggregateError {
  return new AggregateError(
    [operationError, closeError],
    `Provider recorder operation and file close both failed for "${filePath}".`,
    { cause: closeError },
  );
}

async function appendCommittedLine(
  publicationPath: string,
  logicalPath: string,
  line: string,
  durable: boolean,
  expectedIdentity?: RecorderFileIdentity,
  firstCreatedDirectory?: string,
): Promise<void> {
  const opened = await openRecorderForAppend(publicationPath);
  const { handle } = opened;
  const identity = await handle.stat({ bigint: true });
  const recorderIdentity = { dev: identity.dev, ino: identity.ino, nlink: identity.nlink };
  let published = false;
  let operationError: unknown;
  try {
    if (
      expectedIdentity !== undefined &&
      !sameRecorderFileIdentity(expectedIdentity, recorderIdentity)
    ) {
      throw new RecorderRotatedError("Recorder rotated before appending a committed line.");
    }
    await prepareRecorderTailForAppend(handle);
    published = true;
    await handle.writeFile(line, "utf8");
    if (durable) {
      await handle.sync();
    }
    if (durable) {
      const firstCreatedPath =
        firstCreatedDirectory ?? (opened.created ? publicationPath : undefined);
      await syncRecorderPathAncestry(publicationPath, firstCreatedPath);
    }
  } catch (error) {
    operationError = published ? new ProviderRecorderCommittedError(logicalPath, error) : error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (operationError !== undefined) {
      if (published) {
        throw new ProviderRecorderCommittedError(logicalPath, operationError, [closeError]);
      }
      throw providerRecorderCloseError(logicalPath, operationError, closeError);
    }
    throw published ? new ProviderRecorderCommittedError(logicalPath, closeError) : closeError;
  }
  if (operationError !== undefined) {
    throw operationError;
  }

  let publishedIdentity: RecorderFileIdentity | undefined;
  try {
    publishedIdentity = await readRecorderFileIdentity(
      await resolveRecorderPublicationPath(logicalPath),
    );
  } catch (error) {
    throw new ProviderRecorderCommittedError(logicalPath, error);
  }
  if (!sameRecorderFileIdentity(recorderIdentity, publishedIdentity)) {
    throw new RecorderRotatedError("Recorder rotated while appending a committed line.");
  }
}

function recorderLockReleaseError(
  filePath: string,
  operationError: unknown,
  releaseErrors: unknown[],
): AggregateError {
  return new AggregateError(
    [operationError, ...releaseErrors],
    `Recorder append and lock release both failed for "${filePath}".`,
    { cause: operationError },
  );
}

function recorderErrorDetail(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(recorderErrorDetail).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function reportRecorderLockReleaseFailure(filePath: string, releaseError: unknown): void {
  const detail = recorderErrorDetail(releaseError);
  try {
    process.emitWarning(
      `Provider recorder append committed but lock cleanup failed for "${filePath}": ${detail}`,
      {
        code: "CRABLINE_RECORDER_LOCK_CLEANUP",
        type: "ProviderRecorderWarning",
      },
    );
  } catch {
    // Cleanup reporting must not change the result of a committed append.
  }
}

export async function secureProviderRecorderLockRoot(
  root: string,
  currentUserId: number | undefined,
  options: {
    platform?: NodeJS.Platform;
    createWindowsDirectory?: (directoryPath: string) => Promise<void>;
  } = {},
): Promise<string> {
  if ((options.platform ?? process.platform) === "win32") {
    const cacheKey = path.win32.normalize(path.resolve(root)).toLowerCase();
    for (;;) {
      let secured = securedWindowsLockRoots.get(cacheKey);
      if (!secured) {
        secured = (async () => {
          await mkdir(path.dirname(root), { recursive: true });
          await (options.createWindowsDirectory ?? createOwnerOnlyWindowsDirectory)(root);
          const identity = await lstat(root, { bigint: true });
          if (!identity.isDirectory() || identity.isSymbolicLink()) {
            throw new Error("Provider recorder lock directory is not a private directory.");
          }
          return { dev: identity.dev, ino: identity.ino };
        })();
        securedWindowsLockRoots.set(cacheKey, secured);
        void secured.catch(() => {
          if (securedWindowsLockRoots.get(cacheKey) === secured) {
            securedWindowsLockRoots.delete(cacheKey);
          }
        });
      }
      const expected = await secured;
      let current: Awaited<ReturnType<typeof lstat>>;
      try {
        current = await lstat(root, { bigint: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw error;
        }
        if (securedWindowsLockRoots.get(cacheKey) === secured) {
          securedWindowsLockRoots.delete(cacheKey);
        }
        continue;
      }
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === expected.dev &&
        current.ino === expected.ino
      ) {
        return root;
      }
      if (securedWindowsLockRoots.get(cacheKey) === secured) {
        securedWindowsLockRoots.delete(cacheKey);
      }
    }
  }

  await mkdir(root, { mode: 0o700, recursive: true });
  if (currentUserId === undefined) {
    throw new Error("Provider recorder identity locking requires a current user id.");
  }

  const handle = await open(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const identity = await handle.stat({ bigint: true });
    const current = await lstat(root, { bigint: true });
    if (
      !identity.isDirectory() ||
      !current.isDirectory() ||
      identity.dev !== current.dev ||
      identity.ino !== current.ino ||
      identity.uid !== BigInt(currentUserId) ||
      current.uid !== BigInt(currentUserId)
    ) {
      throw new Error("Provider recorder lock directory is not privately owned.");
    }
    if ((identity.mode & 0o777n) !== 0o700n) {
      await handle.chmod(0o700);
      const secured = await handle.stat({ bigint: true });
      if ((secured.mode & 0o777n) !== 0o700n) {
        throw new Error("Provider recorder lock directory permissions are not private.");
      }
    }
  } finally {
    await handle.close();
  }
  return root;
}

function recorderLockRootUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "EDQUOT" ||
    code === "ENOSPC" ||
    code === "EPERM" ||
    code === "EROFS"
  );
}

function adjacentRecorderLockRoot(filePath: string, currentUserId: number | undefined): string {
  return path.join(
    path.dirname(filePath),
    currentUserId === undefined
      ? ".crabline-provider-recorder-locks"
      : `.crabline-provider-recorder-locks-${currentUserId}`,
  );
}

function recorderIdentityLockPath(root: string, identity: RecorderFileIdentity): string {
  return path.join(root, `recorder-${identity.dev}-${identity.ino}`);
}

async function recorderIdentityLockTargets(
  filePath: string,
  identity: RecorderFileIdentity,
): Promise<{
  fallbackRoot?: string;
  preferred: string;
  userId: number | undefined;
}> {
  const currentUserId = process.platform === "win32" ? undefined : process.geteuid?.();
  let sharedRoot: string | undefined;
  try {
    const account = userInfo();
    sharedRoot =
      process.platform === "win32"
        ? path.join(account.homedir, "AppData", "Local", "Crabline", "locks", "provider-recorder")
        : path.join(account.homedir, ".cache", "crabline", "locks", "provider-recorder");
  } catch {
    // Arbitrary container UIDs may not have an OS account entry.
  }
  if (sharedRoot) {
    try {
      return {
        ...(identity.nlink === 1n
          ? { fallbackRoot: adjacentRecorderLockRoot(filePath, currentUserId) }
          : {}),
        preferred: recorderIdentityLockPath(
          await secureProviderRecorderLockRoot(sharedRoot, currentUserId),
          identity,
        ),
        userId: currentUserId,
      };
    } catch (error) {
      if (!recorderLockRootUnavailable(error)) {
        throw error;
      }
    }
  }

  if (identity.nlink > 1n) {
    throw new Error(
      "Provider recorder hardlinks require a writable shared per-user lock directory.",
    );
  }
  const adjacentRoot = await secureProviderRecorderLockRoot(
    adjacentRecorderLockRoot(filePath, currentUserId),
    currentUserId,
  );
  return {
    preferred: recorderIdentityLockPath(adjacentRoot, identity),
    userId: currentUserId,
  };
}

async function acquireRecorderIdentityLock(
  filePath: string,
  identity: RecorderFileIdentity,
): Promise<() => Promise<void>> {
  const targets = await recorderIdentityLockTargets(filePath, identity);
  try {
    return await acquireRecorderLock(targets.preferred);
  } catch (error) {
    if (!targets.fallbackRoot || !recorderLockRootUnavailable(error)) {
      throw error;
    }
    const fallbackRoot = await secureProviderRecorderLockRoot(targets.fallbackRoot, targets.userId);
    return await acquireRecorderLock(recorderIdentityLockPath(fallbackRoot, identity));
  }
}

async function acquireRecorderLock(filePath: string): Promise<() => Promise<void>> {
  return await lock(filePath, {
    fs: createProcessOwnedLockFileSystem(),
    realpath: false,
    retries: {
      factor: 1,
      maxTimeout: 10,
      minTimeout: 10,
      retries: 500,
    },
    stale: RECORDER_LOCK_STALE_MS,
    update: RECORDER_LOCK_UPDATE_MS,
  });
}

async function ensureRecorderExistsForLock(filePath: string): Promise<boolean> {
  if (await readRecorderFileIdentity(filePath)) {
    return false;
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "ax", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  await handle.close();
  return true;
}

async function releaseRecorderLocks(releases: Array<() => Promise<void>>): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const release of releases.reverse()) {
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function withRecorderLock<T>(
  filePath: string,
  operation: (lockCreatedFile: boolean, lockedIdentity: RecorderFileIdentity) => Promise<T>,
): Promise<T> {
  const releases: Array<() => Promise<void>> = [];
  let lockCreatedFile = false;
  let lockedIdentity: RecorderFileIdentity | undefined;
  try {
    releases.push(await acquireRecorderLock(filePath));
    for (let attempt = 0; attempt < RECORDER_ROTATION_ATTEMPTS; attempt += 1) {
      lockCreatedFile = await ensureRecorderExistsForLock(filePath);
      const identity = await readRecorderFileIdentity(filePath);
      if (!identity) {
        continue;
      }
      const releaseIdentityLock = await acquireRecorderIdentityLock(filePath, identity);
      releases.push(releaseIdentityLock);
      const currentIdentity = await readRecorderFileIdentity(filePath);
      if (sameRecorderLockIdentity(identity, currentIdentity)) {
        lockedIdentity = identity;
        break;
      }
      const registeredIdentityRelease = releases.pop();
      const releaseErrors = await releaseRecorderLocks(
        registeredIdentityRelease ? [registeredIdentityRelease] : [],
      );
      if (releaseErrors.length > 0) {
        throw recorderLockReleaseError(
          filePath,
          new RecorderRotatedError("Recorder rotated while acquiring its identity lock."),
          releaseErrors,
        );
      }
      if (attempt + 1 >= RECORDER_ROTATION_ATTEMPTS) {
        throw new RecorderRotatedError("Recorder kept rotating while acquiring its identity lock.");
      }
    }
    if (!lockedIdentity) {
      throw new RecorderRotatedError("Recorder disappeared while acquiring its identity lock.");
    }
  } catch (error) {
    const releaseErrors = await releaseRecorderLocks(releases);
    if (releaseErrors.length > 0) {
      throw recorderLockReleaseError(filePath, error, releaseErrors);
    }
    throw error;
  }

  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation(lockCreatedFile, lockedIdentity);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const releaseErrors = await releaseRecorderLocks(releases);
  if (operationFailed) {
    if (releaseErrors.length > 0) {
      throw recorderLockReleaseError(filePath, operationError, releaseErrors);
    }
    throw operationError;
  }
  if (releaseErrors.length > 0) {
    reportRecorderLockReleaseFailure(
      filePath,
      releaseErrors.length === 1
        ? releaseErrors[0]
        : new AggregateError(releaseErrors, "Multiple recorder lock cleanup operations failed."),
    );
  }
  return result as T;
}

async function serializeAppend<T>(
  filePath: string,
  operation: (
    publicationPath: string,
    logicalPath: string,
    lockCreatedFile: boolean,
    lockedIdentity: RecorderFileIdentity,
  ) => Promise<T>,
): Promise<T> {
  const logicalPath = path.resolve(filePath);
  const key = await resolveRecorderPublicationPath(logicalPath);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  let result: T;
  const current = previous
    .catch(() => {})
    .then(async () => {
      result = await withRecorderLock(
        key,
        async (lockCreatedFile, lockedIdentity) =>
          await operation(key, logicalPath, lockCreatedFile, lockedIdentity),
      );
    });
  pendingAppends.set(key, current);

  try {
    await current;
    return result!;
  } finally {
    if (pendingAppends.get(key) === current) {
      pendingAppends.delete(key);
    }
  }
}

async function readRecordedInboundAppend(
  filePath: string,
  state: IncrementalReadState,
): Promise<RecordedInboundEnvelope[]> {
  const snapshot = snapshotIncrementalReadState(state);
  let handle;

  try {
    handle = await open(filePath, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      resetIncrementalReadState(state);
      state.identity = undefined;
      return [];
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    const identityStats = await handle.stat({ bigint: true });
    const identity = { dev: identityStats.dev, ino: identityStats.ino };
    const sameFile = state.identity?.dev === identity.dev && state.identity.ino === identity.ino;
    const rotated = state.identity !== undefined && !sameFile;
    let hasContinuity = stats.size >= state.offset;

    if (hasContinuity && state.offset > 0 && state.continuity.length === 0) {
      hasContinuity = sameFile;
    } else if (hasContinuity && state.continuity.length > 0) {
      const actual = await readBufferAt(
        handle,
        state.continuity.length,
        state.offset - state.continuity.length,
      );
      hasContinuity = actual.equals(state.continuity);
    }

    if (!hasContinuity) {
      resetIncrementalReadState(state);
    } else if (rotated) {
      state.generation += 1;
    }
    state.identity = identity;

    const events: RecordedInboundEnvelope[] = [];
    let position = state.offset;
    let remainingBatchBytes = MAX_INCREMENTAL_READ_BYTES;
    let reachedUnexpectedEof = false;
    while (position < stats.size && remainingBatchBytes > 0) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, stats.size - position, remainingBatchBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        reachedUnexpectedEof = true;
        break;
      }
      position += bytesRead;
      state.offset = position;
      remainingBatchBytes -= bytesRead;
      events.push(...consumeRecordedChunk(state, chunk.subarray(0, bytesRead)));
    }
    state.caughtUp = reachedUnexpectedEof || position >= stats.size;
    return events;
  } catch (error) {
    restoreIncrementalReadState(state, snapshot);
    throw error;
  } finally {
    await handle.close();
  }
}

export async function appendRecordedInbound(
  filePath: string,
  event: RecordableInboundEnvelope,
): Promise<RecordedInboundEnvelope> {
  const createdDirectory = await mkdir(path.dirname(filePath), { recursive: true });
  const firstCreatedDirectory =
    createdDirectory === undefined ? undefined : await realpath(createdDirectory);

  const recorded = {
    ...event,
    recordedAt: new Date().toISOString(),
  } satisfies RecordedInboundEnvelope;

  const line = `${JSON.stringify(recorded)}\n`;
  if (Buffer.byteLength(line) > MAX_PENDING_RECORD_BYTES) {
    throw new Error(
      `Recorder record exceeded ${MAX_PENDING_RECORD_BYTES} bytes without a newline.`,
    );
  }
  await appendJsonLine(filePath, line, firstCreatedDirectory);
  return recorded;
}

export async function appendRecordedInboundBatch(
  filePath: string,
  events: InboundEnvelope[],
): Promise<RecordedInboundEnvelope[]> {
  if (events.length === 0) {
    return [];
  }
  const createdDirectory = await mkdir(path.dirname(filePath), { recursive: true });
  const firstCreatedDirectory =
    createdDirectory === undefined ? undefined : await realpath(createdDirectory);
  for (let attempt = 0; ; attempt++) {
    try {
      return await serializeAppend(
        filePath,
        async (publicationPath, logicalPath, _lockCreatedFile, lockedIdentity) => {
          const generation = await prepareRecorderPathForAppend(
            publicationPath,
            logicalPath,
            true,
            lockedIdentity,
          );
          const seen = await syncRecordIdentityIndex(publicationPath);
          const pendingIdentities = new Set<string>();
          const recorded: RecordedInboundEnvelope[] = [];
          for (const event of events) {
            const identity = recordIdentity(event);
            if (seen.has(identity) || pendingIdentities.has(identity)) {
              continue;
            }
            pendingIdentities.add(identity);
            recorded.push({
              ...event,
              recordedAt: new Date().toISOString(),
            });
          }
          if (recorded.length > 0) {
            const batch = {
              events: recorded,
              recordType: "crabline.recorder.batch",
              recorderBatchVersion: RECORDER_BATCH_VERSION,
            } satisfies RecordedInboundBatchLine;
            const line = `${JSON.stringify(batch)}\n`;
            if (Buffer.byteLength(line) > MAX_PENDING_RECORD_BYTES) {
              throw new Error(
                `Recorder record exceeded ${MAX_PENDING_RECORD_BYTES} bytes without a newline.`,
              );
            }
            await appendCommittedLine(
              publicationPath,
              logicalPath,
              line,
              true,
              generation.identity,
              firstCreatedDirectory,
            );
            await syncRecordIdentityIndex(publicationPath);
          } else if (
            !sameRecorderFileIdentity(
              generation.identity,
              await readRecorderFileIdentity(await resolveRecorderPublicationPath(logicalPath)),
            )
          ) {
            throw new RecorderRotatedError("Recorder rotated before confirming a duplicate batch.");
          }
          return recorded;
        },
      );
    } catch (error) {
      if (!(error instanceof RecorderRotatedError) || attempt + 1 >= RECORDER_ROTATION_ATTEMPTS) {
        throw error;
      }
    }
  }
}

function recordIdentity(event: RecordableInboundEnvelope): string {
  return JSON.stringify([event.provider, event.threadId, event.id, recordedDirectionOf(event)]);
}

async function syncRecordIdentityIndex(filePath: string): Promise<Set<string>> {
  const key = path.resolve(filePath);
  let index = recordIdentityIndexes.get(key);
  if (!index) {
    index = { readState: createIncrementalReadState(), seen: new Set() };
    recordIdentityIndexes.set(key, index);
    if (recordIdentityIndexes.size > MAX_RECORD_IDENTITY_INDEXES) {
      recordIdentityIndexes.delete(recordIdentityIndexes.keys().next().value!);
    }
  } else {
    recordIdentityIndexes.delete(key);
    recordIdentityIndexes.set(key, index);
  }

  let generation = index.readState.generation;
  do {
    const appended = await readRecordedInboundAppend(filePath, index.readState);
    if (index.readState.generation !== generation) {
      index.seen.clear();
      generation = index.readState.generation;
      index.readState.caughtUp = false;
      index.readState.continuity = Buffer.alloc(0);
      index.readState.offset = 0;
      index.readState.pending = Buffer.alloc(0);
      continue;
    }
    for (const event of appended) {
      rememberRecentRecord(index.seen, event);
    }
  } while (!index.readState.caughtUp);
  return index.seen;
}

export async function readRecordedInbound(filePath: string): Promise<RecordedInboundEnvelope[]> {
  let raw = "";

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lastNewline = raw.lastIndexOf("\n");
  const completed = lastNewline >= 0 ? raw.slice(0, lastNewline) : "";
  const tail = raw.slice(lastNewline + 1);
  const events: RecordedInboundEnvelope[] = [];

  for (const line of completed.split("\n")) {
    if (line.trim()) {
      events.push(...parseRecordedLine(line));
    }
  }
  if (tail.trim()) {
    try {
      events.push(...parseRecordedLine(tail));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      // Ignore a syntactically partial final append; completed lines remain strict.
    }
  }

  return events;
}

export async function waitForRecordedInbound(params: {
  cursor?: RecordedInboundCursor | undefined;
  filePath: string;
  matches: (event: RecordedInboundEnvelope) => boolean;
  pollMs?: number;
  recordedDirection?: "inbound" | "outbound" | undefined;
  signal?: AbortSignal | undefined;
  since?: string | undefined;
  timeoutMs: number;
}): Promise<RecordedInboundEnvelope | null> {
  const deadline = Date.now() + params.timeoutMs;
  const cursor = params.cursor ?? createRecordedInboundCursor();

  while (!params.signal?.aborted && Date.now() <= deadline) {
    const generation = cursor.readState.generation;
    const events =
      cursor.buffered.length > 0
        ? cursor.buffered.splice(0)
        : await readRecordedInboundAppend(params.filePath, cursor.readState);
    if (cursor.readState.generation !== generation) {
      cursor.seen.clear();
    }
    for (const [index, event] of events.entries()) {
      if (params.recordedDirection && recordedDirectionOf(event) !== params.recordedDirection) {
        continue;
      }
      // Incremental read state owns progress; this bounded window only filters appended retries.
      if (!rememberRecentRecord(cursor.seen, event)) {
        continue;
      }
      if (params.since && new Date(event.sentAt).getTime() < new Date(params.since).getTime()) {
        continue;
      }

      if (params.matches(event)) {
        cursor.buffered.push(...events.slice(index + 1));
        return event;
      }
    }
    if (!cursor.readState.caughtUp) {
      if (Date.now() >= deadline) {
        return null;
      }
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await sleep(Math.min(params.pollMs ?? 200, remainingMs), params.signal);
  }

  return null;
}

export async function* watchRecordedInbound(params: {
  filePath: string;
  matches: (event: RecordedInboundEnvelope) => boolean;
  pollMs?: number;
  recordedDirection?: "inbound" | "outbound" | undefined;
  signal?: AbortSignal | undefined;
  since?: string | undefined;
}): AsyncIterable<RecordedInboundEnvelope> {
  const state = createIncrementalReadState();
  const seen = new Set<string>();

  while (!params.signal?.aborted) {
    const generation = state.generation;
    const events = await readRecordedInboundAppend(params.filePath, state);
    if (state.generation !== generation) {
      seen.clear();
    }
    if (params.signal?.aborted) {
      return;
    }
    for (const event of events) {
      if (params.signal?.aborted) {
        return;
      }
      if (!rememberRecentRecord(seen, event)) {
        continue;
      }
      if (params.recordedDirection && recordedDirectionOf(event) !== params.recordedDirection) {
        continue;
      }
      if (params.since && new Date(event.sentAt).getTime() < new Date(params.since).getTime()) {
        continue;
      }

      if (params.matches(event)) {
        yield event;
      }
    }
    if (!state.caughtUp) {
      continue;
    }

    await sleep(params.pollMs ?? 250, params.signal);
  }
}
