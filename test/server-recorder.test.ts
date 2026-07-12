import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRequestEvent } from "../src/servers/http.js";
import { recordServerEvent } from "../src/servers/recorder.js";

const fsMocks = vi.hoisted(() => ({
  appendFile: vi.fn<(filePath: string, data: string, encoding: string) => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, appendFile: fsMocks.appendFile };
});

function serverEvent(pathname: string): ServerRequestEvent {
  return {
    at: "2026-07-12T12:00:00.000Z",
    method: "POST",
    path: pathname,
    query: {},
    type: "api",
  };
}

beforeEach(() => {
  fsMocks.appendFile.mockReset();
  fsMocks.appendFile.mockResolvedValue();
});

describe("server recorder", () => {
  it("recovers serialization after an append failure", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-recovery.jsonl");
    const appendFailure = new Error("disk unavailable");
    fsMocks.appendFile.mockRejectedValueOnce(appendFailure).mockResolvedValueOnce();

    await expect(
      recordServerEvent({
        event: serverEvent("/first"),
        onEvent: undefined,
        recorderPath,
      }),
    ).rejects.toBe(appendFailure);
    await expect(
      recordServerEvent({
        event: serverEvent("/second"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
  });

  it("invokes observers only after the event is durable", async () => {
    let releaseAppend: (() => void) | undefined;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    fsMocks.appendFile.mockReturnValueOnce(appendBlocked);
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    const event = serverEvent("/ordered");

    const recording = recordServerEvent({
      event,
      onEvent: observer,
      recorderPath: path.join("/tmp", "crabline-server-recorder-order.jsonl"),
    });
    await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1));
    expect(observer).not.toHaveBeenCalled();

    releaseAppend?.();
    await recording;
    expect(observer).toHaveBeenCalledWith(event);
  });

  it("keeps later appends available after an observer failure", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-observer.jsonl");
    const observerFailure = new Error("observer failed");

    await expect(
      recordServerEvent({
        event: serverEvent("/first"),
        onEvent: async () => {
          throw observerFailure;
        },
        recorderPath,
      }),
    ).rejects.toBe(observerFailure);
    await expect(
      recordServerEvent({
        event: serverEvent("/second"),
        onEvent: undefined,
        recorderPath,
      }),
    ).resolves.toBeUndefined();

    expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
  });
});
