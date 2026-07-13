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

function createCleanupChild(code: number, beforeClose?: () => void): FakeChild {
  const child = createFakeChild(9000 + code);
  void Promise.resolve().then(() => {
    beforeClose?.();
    child.emit("close", code, null);
  });
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
  it.each([":", "="])(
    "redacts diagnostics for Windows slash options using %s",
    async (separator) => {
      const scriptChild = createFakeChild(1122);
      spawnMock.mockReturnValueOnce(scriptChild);
      const context = createContext();
      context.config.script!.commands.send = `node "C:\\workspace\\send.mjs" /label${separator}opaque-value`;
      const provider = new ScriptProviderAdapter(context);

      const failurePromise = provider
        .send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        })
        .catch((error: unknown) => error);
      scriptChild.stderr.write("opaque-value failed");
      scriptChild.emit("close", 7, null);
      const failure = await failurePromise;

      expect(ensureErrorMessage(failure)).toContain("[redacted command value] failed");
      expect(ensureErrorMessage(failure)).not.toContain("opaque-value");
    },
  );

  it("suppresses diagnostics for unsupported Windows slash options", async () => {
    const scriptChild = createFakeChild(1122);
    spawnMock.mockReturnValueOnce(scriptChild);
    const context = createContext();
    context.config.script!.commands.send = 'node "C:\\workspace\\send.mjs" /label';
    const provider = new ScriptProviderAdapter(context);

    const failurePromise = provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    scriptChild.stderr.write("opaque-value failed");
    scriptChild.emit("close", 7, null);
    const failure = await failurePromise;

    expect(ensureErrorMessage(failure)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(failure)).not.toContain("opaque-value");
  });

  it("suppresses diagnostics for ambiguous Windows backslash quoting", async () => {
    const scriptChild = createFakeChild(1133);
    spawnMock.mockReturnValueOnce(scriptChild);
    const context = createContext();
    context.config.script!.commands.send = String.raw`node "C:\workspace\opaque-value\\"`;
    const provider = new ScriptProviderAdapter(context);

    const failurePromise = provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    scriptChild.stderr.write("opaque-value");
    scriptChild.emit("close", 7, null);
    const failure = await failurePromise;

    expect(ensureErrorMessage(failure)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(failure)).not.toContain("opaque-value");
  });

  it("suppresses diagnostics for ambiguous Windows paired quotes", async () => {
    const scriptChild = createFakeChild(1144);
    spawnMock.mockReturnValueOnce(scriptChild);
    const context = createContext();
    context.config.script!.commands.send = String.raw`node "opaque""value"`;
    const provider = new ScriptProviderAdapter(context);

    const failurePromise = provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    scriptChild.stderr.write('opaque"value');
    scriptChild.emit("close", 7, null);
    const failure = await failurePromise;

    expect(ensureErrorMessage(failure)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(failure)).not.toContain('opaque"value');
  });

  it("suppresses diagnostics for quoted Windows command newlines", async () => {
    const scriptChild = createFakeChild(1145);
    spawnMock.mockReturnValueOnce(scriptChild);
    const context = createContext();
    context.config.script!.commands.send = 'echo "safe\r\nopaque-value"';
    const provider = new ScriptProviderAdapter(context);

    const failurePromise = provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    scriptChild.stderr.write("opaque-value");
    scriptChild.emit("close", 7, null);
    const failure = await failurePromise;

    expect(ensureErrorMessage(failure)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(failure)).not.toContain("opaque-value");
  });

  it("suppresses parsed diagnostics for a non-cmd ComSpec", async () => {
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    try {
      const scriptChild = createFakeChild(1155);
      spawnMock.mockReturnValueOnce(scriptChild);
      const context = createContext();
      context.config.script!.commands.send = "node send.mjs 'opaque-value'";
      const provider = new ScriptProviderAdapter(context);

      const failurePromise = provider
        .send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        })
        .catch((error: unknown) => error);
      scriptChild.stderr.write("opaque-value");
      scriptChild.emit("close", 7, null);
      const failure = await failurePromise;

      expect(ensureErrorMessage(failure)).toContain("[script diagnostics redacted]");
      expect(ensureErrorMessage(failure)).not.toContain("opaque-value");
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
    }
  });

  it("uses handle-bound process termination and tears down inherited pipes", async () => {
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
    expect(terminationScript).toContain("OpenProcess");
    expect(terminationScript).toContain("GetProcessTimes");
    expect(terminationScript).toContain("TerminateProcess");
    expect(terminationScript).toContain("TerminateVerified");
    expect(terminationScript).toContain("creationTime/10!=expectedCreationTime/10");
    expect(terminationScript).not.toContain("taskkill.exe");
    expect(terminationScript).toContain("CreationDate");
    expect(terminationScript).toContain("$ChildCreated -lt $ParentCreated");
    expect(terminationScript).not.toContain("$ChildCreated -gt");
    expect(terminationScript).toContain("HashSet[string]");
    expect(terminationScript).toContain("$RootObservedBy");
    expect(terminationScript).toContain("CreationDate).ToUniversalTime()");
    expect(terminationScript).toContain("$CleanupFailed=$RootExpectedAlive -and !$RootMatches");
    expect(terminationScript).toContain("if($CleanupFailed){exit 1}");
    const rootNotBeforeMs = Number(
      /\$RootNotBefore=\[DateTimeOffset\]::FromUnixTimeMilliseconds\((\d+)\)/u.exec(
        terminationScript,
      )?.[1],
    );
    const rootObservedByMs = Number(
      /\$RootObservedBy=\[DateTimeOffset\]::FromUnixTimeMilliseconds\((\d+)\)/u.exec(
        terminationScript,
      )?.[1],
    );
    expect(rootObservedByMs).toBe(rootNotBeforeMs + 1);
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

  it("does not infer descendants after the direct shell has already exited", async () => {
    const scriptChild = createFakeChild(6789);
    Object.defineProperty(scriptChild, "exitCode", {
      configurable: true,
      value: 0,
    });
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
    await failurePromise;

    expect(spawnMock.mock.calls[1]?.[0]).toBe("powershell.exe");
    const terminationScript = String(spawnMock.mock.calls[1]?.[1]?.at(-1));
    expect(terminationScript).toContain("$RootExpectedAlive=$false");
    expect(terminationScript).not.toContain("CreationDate=$RootNotBefore");
    expect(scriptChild.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(scriptChild.stdin.destroyed).toBe(true);
    expect(scriptChild.stdout.destroyed).toBe(true);
    expect(scriptChild.stderr.destroyed).toBe(true);
  });

  it("falls back to the child handle when PowerShell cleanup fails for a live shell", async () => {
    const scriptChild = createFakeChild(7890);
    spawnMock.mockReturnValueOnce(scriptChild).mockImplementationOnce(() => createCleanupChild(1));
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
    await failurePromise;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(scriptChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill the child handle after the script exits during PowerShell cleanup", async () => {
    const scriptChild = createFakeChild(8901);
    spawnMock.mockReturnValueOnce(scriptChild).mockImplementationOnce(() =>
      createCleanupChild(1, () => {
        Object.defineProperty(scriptChild, "exitCode", {
          configurable: true,
          value: 0,
        });
      }),
    );
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
    await failurePromise;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(scriptChild.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("preserves context cancellation when child close never arrives", async () => {
    vi.useRealTimers();
    const scriptChild = createFakeChild(9012);
    spawnMock.mockReturnValueOnce(scriptChild).mockImplementationOnce(() => createCleanupChild(0));
    const context = createContext();
    const controller = new AbortController();
    const cancellation = new Error("watch cancelled");
    const provider = new ScriptProviderAdapter(context);
    const next = provider.watch({ ...context, signal: controller.signal }).next();

    scriptChild.stdout.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(cancellation);

    await expect(next).rejects.toBe(cancellation);
  });
});
