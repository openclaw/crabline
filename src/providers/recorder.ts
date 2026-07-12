import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
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
const MAX_RECORD_IDENTITY_INDEXES = 128;
const MAX_RECENT_RECORD_KEYS = 4096;
const RECORDER_BATCH_VERSION = 1;
const RECORDER_LOCK_STALE_MS = 30_000;
const RECORDER_LOCK_UPDATE_MS = 10_000;

type IncrementalReadState = {
  caughtUp: boolean;
  continuity: Buffer;
  generation: number;
  identity:
    | {
        dev: number;
        ino: number;
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
  const key = JSON.stringify([event.provider, event.threadId, event.id]);
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  if (seen.size > MAX_RECENT_RECORD_KEYS) {
    seen.delete(seen.values().next().value!);
  }
  return true;
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
    return parsed.events as RecordedInboundEnvelope[];
  }
  return [parsed as RecordedInboundEnvelope];
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

async function appendJsonLine(filePath: string, line: string): Promise<void> {
  await serializeAppend(filePath, async (publicationPath, logicalPath) => {
    await appendCommittedLine(publicationPath, logicalPath, line, false);
  });
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

async function resolveRecorderPublicationPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return path.join(await realpath(path.dirname(filePath)), path.basename(filePath));
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
    JSON.parse(tail);
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
): Promise<void> {
  const handle = await open(publicationPath, "a+");
  const identity = await handle.stat({ bigint: true });
  try {
    const changed = await prepareRecorderTailForAppend(handle);
    if (changed && durable) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }

  if (
    !sameRecorderFileIdentity(
      { dev: identity.dev, ino: identity.ino },
      await readRecorderFileIdentity(await resolveRecorderPublicationPath(logicalPath)),
    )
  ) {
    throw new Error("Recorder rotated while preparing a committed line.");
  }
}

async function appendCommittedLine(
  publicationPath: string,
  logicalPath: string,
  line: string,
  durable: boolean,
): Promise<void> {
  const handle = await open(publicationPath, "a+");
  const identity = await handle.stat({ bigint: true });
  try {
    await prepareRecorderTailForAppend(handle);
    await handle.writeFile(line, "utf8");
    if (durable) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }

  if (
    !sameRecorderFileIdentity(
      { dev: identity.dev, ino: identity.ino },
      await readRecorderFileIdentity(await resolveRecorderPublicationPath(logicalPath)),
    )
  ) {
    throw new Error("Recorder rotated while appending a committed line.");
  }
}

function recorderLockReleaseError(
  filePath: string,
  operationError: unknown,
  releaseError: unknown,
): AggregateError {
  return new AggregateError(
    [operationError, releaseError],
    `Recorder append and lock release both failed for "${filePath}".`,
    { cause: operationError },
  );
}

async function withRecorderLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const release = await lock(filePath, {
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

async function serializeAppend<T>(
  filePath: string,
  operation: (publicationPath: string, logicalPath: string) => Promise<T>,
): Promise<T> {
  const logicalPath = path.resolve(filePath);
  const key = await resolveRecorderPublicationPath(logicalPath);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  let result: T;
  const current = previous
    .catch(() => {})
    .then(async () => {
      result = await withRecorderLock(key, async () => await operation(key, logicalPath));
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
    const identity = { dev: stats.dev, ino: stats.ino };
    const sameFile = state.identity?.dev === identity.dev && state.identity.ino === identity.ino;
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
  } finally {
    await handle.close();
  }
}

export async function appendRecordedInbound(
  filePath: string,
  event: RecordableInboundEnvelope,
): Promise<RecordedInboundEnvelope> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const recorded = {
    ...event,
    recordedAt: new Date().toISOString(),
  } satisfies RecordedInboundEnvelope;

  await appendJsonLine(filePath, `${JSON.stringify(recorded)}\n`);
  return recorded;
}

export async function appendRecordedInboundBatch(
  filePath: string,
  events: InboundEnvelope[],
): Promise<RecordedInboundEnvelope[]> {
  await mkdir(path.dirname(filePath), { recursive: true });
  return await serializeAppend(filePath, async (publicationPath, logicalPath) => {
    await prepareRecorderPathForAppend(publicationPath, logicalPath, true);
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
      await appendCommittedLine(publicationPath, logicalPath, `${JSON.stringify(batch)}\n`, true);
      await syncRecordIdentityIndex(publicationPath);
    }
    return recorded;
  });
}

function recordIdentity(event: Pick<InboundEnvelope, "id" | "provider" | "threadId">): string {
  return JSON.stringify([event.provider, event.threadId, event.id]);
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
    } catch {
      // Ignore a partial final append; completed lines remain strict.
    }
  }

  return events;
}

export async function waitForRecordedInbound(params: {
  cursor?: RecordedInboundCursor | undefined;
  filePath: string;
  matches: (event: RecordedInboundEnvelope) => boolean;
  pollMs?: number;
  signal?: AbortSignal | undefined;
  since?: string | undefined;
  timeoutMs: number;
}): Promise<RecordedInboundEnvelope | null> {
  const deadline = Date.now() + params.timeoutMs;
  const cursor = params.cursor ?? createRecordedInboundCursor();

  while (!params.signal?.aborted && Date.now() <= deadline) {
    const events =
      cursor.buffered.length > 0
        ? cursor.buffered.splice(0)
        : await readRecordedInboundAppend(params.filePath, cursor.readState);
    for (const [index, event] of events.entries()) {
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
  signal?: AbortSignal | undefined;
  since?: string | undefined;
}): AsyncIterable<RecordedInboundEnvelope> {
  const state = createIncrementalReadState();
  const seen = new Set<string>();

  while (!params.signal?.aborted) {
    const events = await readRecordedInboundAppend(params.filePath, state);
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
