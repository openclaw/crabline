import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureErrorMessage } from "../src/core/errors.js";
import { ScriptProviderAdapter } from "../src/providers/builtin/script.js";
import type { ProviderContext } from "../src/providers/types.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

type FakeChild = ChildProcess & {
  kill: ReturnType<typeof vi.fn>;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function createFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    connected: false,
    exitCode: null,
    killed: false,
    kill: vi.fn(() => true),
    pid,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  return child;
}

function createCleanupChild(code: number): FakeChild {
  const child = createFakeChild(9000 + code);
  void Promise.resolve().then(() => child.emit("close", code, null));
  return child;
}

function createContext(): ProviderContext {
  return {
    config: {
      adapter: "script",
      capabilities: ["send", "agent"],
      env: [],
      platform: "slack",
      script: {
        commands: {
          send: "node send.mjs",
          watch: "node watch.mjs",
        },
      },
      status: "active",
    },
    fixture: {
      env: [],
      id: "fixture",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "send",
      provider: "scripted",
      retries: 0,
      tags: [],
      target: { id: "thread-1", metadata: {} },
      timeoutMs: 25,
    },
    manifestPath: "/workspace/crabline.yaml",
    providerId: "scripted",
    userName: "crabline",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: "win32",
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("script provider Windows cleanup", () => {
  it("uses identity-checked taskkill fallback and tears down inherited pipes", async () => {
    const scriptChild = createFakeChild(1234);
    spawnMock.mockReturnValueOnce(scriptChild).mockImplementationOnce(() => createCleanupChild(0));
    const context = createContext();
    const provider = new ScriptProviderAdapter(context);

    const failurePromise = provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(context.fixture.timeoutMs);
    const failure = await failurePromise;

    expect(ensureErrorMessage(failure)).toBe(
      `Script command timed out after ${context.fixture.timeoutMs}ms.`,
    );
    expect(spawnMock.mock.calls[1]?.[0]).toBe("powershell.exe");
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["-NonInteractive", "-Command"]),
    );
    const terminationScript = String(spawnMock.mock.calls[1]?.[1]?.at(-1));
    expect(terminationScript).toContain("taskkill.exe");
    expect(terminationScript).toContain("$Taskkill.ExitCode");
    expect(terminationScript).toContain("$Taskkill.Kill()");
    expect(terminationScript).toContain("CreationDate");
    expect(terminationScript).toContain("$Current.CreationDate -eq $Entry.CreationDate");
    expect(scriptChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(scriptChild.stdin.destroyed).toBe(true);
    expect(scriptChild.stdout.destroyed).toBe(true);
    expect(scriptChild.stderr.destroyed).toBe(true);
  });

  it("bounds child-close waiting without replacing the primary watch failure", async () => {
    const scriptChild = createFakeChild(5678);
    spawnMock.mockReturnValueOnce(scriptChild).mockImplementationOnce(() => createCleanupChild(0));
    const context = createContext();
    const provider = new ScriptProviderAdapter(context);
    const iterator = provider.watch(context);
    const next = iterator.next();
    scriptChild.stdout.write(
      `${JSON.stringify({
        author: "assistant",
        id: "watch-1",
        sentAt: "2026-07-13T00:00:00.000Z",
        text: "payload",
        threadId: "thread-1",
      })}\n`,
    );
    await expect(next).resolves.toMatchObject({ done: false, value: { id: "watch-1" } });

    const primaryFailure = new Error("primary watch failure");
    const failurePromise = iterator.throw(primaryFailure).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(failurePromise).resolves.toBe(primaryFailure);
    expect(scriptChild.stdout.destroyed).toBe(true);
    expect(spawnMock.mock.calls[1]?.[0]).toBe("powershell.exe");
  });
});
