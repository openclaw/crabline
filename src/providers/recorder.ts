import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { InboundEnvelope } from "./types.js";

export type RecordedInboundEnvelope = InboundEnvelope & {
  recordedAt: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRecordKey(event: InboundEnvelope): string {
  return `${event.provider}:${event.threadId}:${event.id}`;
}

const MAX_WATCH_SEEN_KEYS = 4096;

type IncrementalReadState = {
  offset: number;
  pending: Buffer;
};

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
      state.offset = 0;
      state.pending = Buffer.alloc(0);
      return [];
    }
    throw error;
  }

  try {
    const size = (await handle.stat()).size;
    if (size < state.offset) {
      state.offset = 0;
      state.pending = Buffer.alloc(0);
    }

    const chunks: Buffer[] = [];
    let position = state.offset;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    state.offset = position;

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

  await appendFile(filePath, `${JSON.stringify(recorded)}\n`, "utf8");
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
  filePath: string;
  matches: (event: RecordedInboundEnvelope) => boolean;
  pollMs?: number;
  since?: string | undefined;
  timeoutMs: number;
}): Promise<RecordedInboundEnvelope | null> {
  const deadline = Date.now() + params.timeoutMs;
  const seen = new Set<string>();

  while (Date.now() <= deadline) {
    const events = await readRecordedInbound(params.filePath);
    for (const event of events) {
      const key = toRecordKey(event);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      if (params.since && new Date(event.sentAt).getTime() < new Date(params.since).getTime()) {
        continue;
      }

      if (params.matches(event)) {
        return event;
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await sleep(Math.min(params.pollMs ?? 200, remainingMs));
  }

  return null;
}

export async function* watchRecordedInbound(params: {
  filePath: string;
  matches: (event: RecordedInboundEnvelope) => boolean;
  pollMs?: number;
  since?: string | undefined;
}): AsyncIterable<RecordedInboundEnvelope> {
  const state: IncrementalReadState = {
    offset: 0,
    pending: Buffer.alloc(0),
  };
  const seen = new Set<string>();

  while (true) {
    const events = await readRecordedInboundAppend(params.filePath, state);
    for (const event of events) {
      const key = toRecordKey(event);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (seen.size > MAX_WATCH_SEEN_KEYS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }

      if (params.since && new Date(event.sentAt).getTime() < new Date(params.since).getTime()) {
        continue;
      }

      if (params.matches(event)) {
        yield event;
      }
    }

    await sleep(params.pollMs ?? 250);
  }
}
