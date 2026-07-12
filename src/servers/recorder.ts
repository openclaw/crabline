import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ServerRequestEvent } from "./http.js";

export type ServerEventObserver = (event: ServerRequestEvent) => void | Promise<void>;

const pendingAppends = new Map<string, Promise<void>>();

async function appendJsonLine(filePath: string, line: string): Promise<void> {
  const key = path.resolve(filePath);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, line, "utf8");
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
  await appendJsonLine(params.recorderPath, `${JSON.stringify(params.event)}\n`);
  await params.onEvent?.(params.event);
}
