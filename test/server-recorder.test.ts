import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRequestEvent } from "../src/servers/http.js";
import { recordCommittedServerEvent, recordServerEvent } from "../src/servers/recorder.js";

const fsMocks = vi.hoisted(() => {
  const file = {
    appendFile: vi.fn<(data: string, options: { encoding: "utf8" }) => Promise<void>>(),
    chmod: vi.fn<(mode: number) => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
  };
  return {
    chmod: vi.fn<(filePath: string, mode: number) => Promise<void>>(),
    file,
    mkdir:
      vi.fn<
        (
          filePath: string,
          options: { mode: number; recursive: true },
        ) => Promise<string | undefined>
      >(),
    open: vi.fn<(filePath: string, flags: string, mode: number) => Promise<typeof file>>(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: fsMocks.chmod,
    mkdir: fsMocks.mkdir,
    open: fsMocks.open,
  };
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
  fsMocks.chmod.mockReset();
  fsMocks.chmod.mockResolvedValue();
  fsMocks.file.appendFile.mockReset();
  fsMocks.file.appendFile.mockResolvedValue();
  fsMocks.file.chmod.mockReset();
  fsMocks.file.chmod.mockResolvedValue();
  fsMocks.file.close.mockReset();
  fsMocks.file.close.mockResolvedValue();
  fsMocks.mkdir.mockReset();
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.open.mockReset();
  fsMocks.open.mockResolvedValue(fsMocks.file);
});

describe("server recorder", () => {
  it("creates recorder artifacts with owner-only permissions before append", async () => {
    const recorderPath = path.join("/tmp", "private", "events.jsonl");
    fsMocks.mkdir.mockResolvedValueOnce(path.join("/tmp", "private"));
    await recordServerEvent({
      event: serverEvent("/private"),
      onEvent: undefined,
      recorderPath,
    });

    expect(fsMocks.mkdir).toHaveBeenCalledWith(path.join("/tmp", "private"), {
      mode: 0o700,
      recursive: true,
    });
    expect(fsMocks.chmod).toHaveBeenCalledWith(path.join("/tmp", "private"), 0o700);
    expect(fsMocks.open).toHaveBeenCalledWith(recorderPath, "a", 0o600);
    expect(fsMocks.file.chmod).toHaveBeenCalledWith(0o600);
    expect(fsMocks.file.appendFile).toHaveBeenCalledWith(expect.any(String), {
      encoding: "utf8",
    });
    expect(fsMocks.file.chmod.mock.invocationCallOrder[0]).toBeLessThan(
      fsMocks.file.appendFile.mock.invocationCallOrder[0]!,
    );
    expect(fsMocks.file.close).toHaveBeenCalledOnce();
  });

  it("repairs managed recorder directories without chmodding caller-owned parents", async () => {
    const callerOwnedPath = path.join("/tmp", "events.jsonl");
    await recordServerEvent({
      event: serverEvent("/caller-owned"),
      onEvent: undefined,
      recorderPath: callerOwnedPath,
    });
    expect(fsMocks.chmod).not.toHaveBeenCalled();
    expect(fsMocks.file.chmod).toHaveBeenCalledWith(0o600);

    const managedPath = path.resolve(".crabline", "servers", "events.jsonl");
    await recordServerEvent({
      event: serverEvent("/managed"),
      onEvent: undefined,
      recorderPath: managedPath,
    });
    expect(fsMocks.chmod).toHaveBeenCalledWith(path.dirname(managedPath), 0o700);
  });

  it("admits directory creation and append into one serialized queue", async () => {
    let releaseFirstMkdir: (() => void) | undefined;
    fsMocks.mkdir
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseFirstMkdir = () => resolve(undefined);
        }),
      )
      .mockResolvedValueOnce(undefined);
    const recorderPath = path.join("/tmp", "crabline-server-recorder-admission.jsonl");

    const first = recordServerEvent({
      event: serverEvent("/first"),
      onEvent: undefined,
      recorderPath,
    });
    const second = recordServerEvent({
      event: serverEvent("/second"),
      onEvent: undefined,
      recorderPath,
    });

    await vi.waitFor(() => expect(fsMocks.mkdir).toHaveBeenCalledTimes(1));
    expect(fsMocks.file.appendFile).not.toHaveBeenCalled();

    releaseFirstMkdir?.();
    await Promise.all([first, second]);

    expect(fsMocks.mkdir).toHaveBeenCalledTimes(2);
    expect(fsMocks.file.appendFile.mock.calls.map(([line]) => JSON.parse(line).path)).toEqual([
      "/first",
      "/second",
    ]);
    expect(fsMocks.mkdir.mock.invocationCallOrder[1]).toBeGreaterThan(
      fsMocks.file.appendFile.mock.invocationCallOrder[0]!,
    );
  });

  it("recovers serialization after an append failure", async () => {
    const recorderPath = path.join("/tmp", "crabline-server-recorder-recovery.jsonl");
    const appendFailure = new Error("disk unavailable");
    fsMocks.file.appendFile.mockRejectedValueOnce(appendFailure).mockResolvedValueOnce();

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

    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
  });

  it("invokes observers only after the event is durable", async () => {
    let releaseAppend: (() => void) | undefined;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    fsMocks.file.appendFile.mockReturnValueOnce(appendBlocked);
    const observer = vi.fn<(event: ServerRequestEvent) => void>();
    const event = serverEvent("/ordered");

    const recording = recordServerEvent({
      event,
      onEvent: observer,
      recorderPath: path.join("/tmp", "crabline-server-recorder-order.jsonl"),
    });
    await vi.waitFor(() => expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(1));
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

    expect(fsMocks.file.appendFile).toHaveBeenCalledTimes(2);
  });

  it("does not surface telemetry failure after a committed mutation", async () => {
    const observerFailure = new Error("observer failed");

    await expect(
      recordCommittedServerEvent({
        event: serverEvent("/committed"),
        onEvent: async () => {
          throw observerFailure;
        },
        recorderPath: path.join("/tmp", "crabline-server-recorder-committed.jsonl"),
      }),
    ).resolves.toBeUndefined();
  });
});
