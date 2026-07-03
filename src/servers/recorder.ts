import fs from "node:fs/promises";
import path from "node:path";
import type { ServerRequestEvent } from "./http.js";

export type ServerEventObserver = (event: ServerRequestEvent) => void | Promise<void>;

export async function recordServerEvent(params: {
  event: ServerRequestEvent;
  onEvent: ServerEventObserver | undefined;
  recorderPath: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.recorderPath), { recursive: true });
  await fs.appendFile(params.recorderPath, `${JSON.stringify(params.event)}\n`, "utf8");
  await params.onEvent?.(params.event);
}
