import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { ServerRequestEvent } from "./http.js";

export type ServerEventObserver = (event: ServerRequestEvent) => void | Promise<void>;

const pendingAppends = new Map<string, Promise<void>>();

function isManagedRecorderDirectory(directory: string): boolean {
  return (
    directory === path.resolve(".crabline", "servers") ||
    directory === path.resolve("artifacts", "crabline")
  );
}

async function appendJsonLine(filePath: string, line: string): Promise<void> {
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
      const file = await open(filePath, "a", 0o600);
      try {
        await file.chmod(0o600);
        await file.appendFile(line, { encoding: "utf8" });
      } finally {
        await file.close();
      }
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
  await appendJsonLine(params.recorderPath, `${JSON.stringify(params.event)}\n`);
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
