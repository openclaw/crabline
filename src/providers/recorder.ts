import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { InboundEnvelope } from "./types.js";

export type RecordedInboundEnvelope = InboundEnvelope & {
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

type IncrementalReadState = {
  continuity: Buffer;
  identity:
    | {
        dev: number;
        ino: number;
      }
    | undefined;
  offset: number;
  pending: Buffer;
};

export type RecordedInboundCursor = {
  buffered: RecordedInboundEnvelope[];
  readState: IncrementalReadState;
};

const CONTINUITY_BYTES = 4096;

function createIncrementalReadState(): IncrementalReadState {
  return {
    continuity: Buffer.alloc(0),
    identity: undefined,
    offset: 0,
    pending: Buffer.alloc(0),
  };
}

export function createRecordedInboundCursor(): RecordedInboundCursor {
  return {
    buffered: [],
    readState: createIncrementalReadState(),
  };
}

function resetIncrementalReadState(state: IncrementalReadState): void {
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

async function appendJsonLine(filePath: string, line: string): Promise<void> {
  const key = path.resolve(filePath);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => appendFile(filePath, line, "utf8"));
  pendingAppends.set(key, current);

  try {
    await current;
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

    const chunks: Buffer[] = [];
    let position = state.offset;
    while (position < stats.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, stats.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    state.offset = position;
    state.continuity = Buffer.concat([state.continuity, ...chunks]).subarray(-CONTINUITY_BYTES);

    const raw = Buffer.concat([state.pending, ...chunks]);
    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      state.pending = raw;
      return [];
    }

    state.pending = raw.subarray(lastNewline + 1);
    const lines = raw
      .subarray(0, lastNewline)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const events: RecordedInboundEnvelope[] = [];
    for (const line of lines) {
      events.push(JSON.parse(line) as RecordedInboundEnvelope);
    }
    return events;
  } finally {
    await handle.close();
  }
}

export async function appendRecordedInbound(
  filePath: string,
  event: InboundEnvelope,
): Promise<RecordedInboundEnvelope> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const recorded = {
    ...event,
    recordedAt: new Date().toISOString(),
  } satisfies RecordedInboundEnvelope;

  await appendJsonLine(filePath, `${JSON.stringify(recorded)}\n`);
  return recorded;
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

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const events: RecordedInboundEnvelope[] = [];
  const hasUnterminatedTail = !raw.endsWith("\n");

  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line) as RecordedInboundEnvelope);
    } catch (error) {
      if (hasUnterminatedTail && index === lines.length - 1) {
        continue;
      }
      throw error;
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
      if (params.since && new Date(event.sentAt).getTime() < new Date(params.since).getTime()) {
        continue;
      }

      if (params.matches(event)) {
        cursor.buffered.push(...events.slice(index + 1));
        return event;
      }
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

  while (!params.signal?.aborted) {
    const events = await readRecordedInboundAppend(params.filePath, state);
    if (params.signal?.aborted) {
      return;
    }
    for (const event of events) {
      if (params.signal?.aborted) {
        return;
      }
      if (params.since && new Date(event.sentAt).getTime() < new Date(params.since).getTime()) {
        continue;
      }

      if (params.matches(event)) {
        yield event;
      }
    }

    await sleep(params.pollMs ?? 250, params.signal);
  }
}
