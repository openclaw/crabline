import { appendFile, mkdir, readFile } from "node:fs/promises";
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

  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line) as RecordedInboundEnvelope);
    } catch (error) {
      if (index === lines.length - 1) {
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

    await sleep(params.pollMs ?? 200);
  }

  return null;
}

export async function* watchRecordedInbound(params: {
  filePath: string;
  matches: (event: RecordedInboundEnvelope) => boolean;
  pollMs?: number;
  since?: string | undefined;
}): AsyncIterable<RecordedInboundEnvelope> {
  const seen = new Set<string>();

  while (true) {
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
        yield event;
      }
    }

    await sleep(params.pollMs ?? 250);
  }
}
