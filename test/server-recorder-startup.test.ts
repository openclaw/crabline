import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync(command: string) {
      native.commands.push(command);
      const stdout =
        command === "/usr/sbin/sysctl"
          ? "{ sec = 1000, usec = 0 }"
          : command === "/usr/bin/vmmap"
            ? "Launch Time: 2026-08-28 00:00:00.000000 +0000"
            : command === "/usr/sbin/ioreg"
              ? '"IOPlatformUUID" = "test-machine"'
              : "";
      return { status: 0, stdout, stderr: "" };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  native.commands.length = 0;
});
afterEach(() => vi.restoreAllMocks());

it.each([
  "startDiscordServer",
  "startMattermostServer",
  "startMatrixServer",
  "startSignalServer",
  "startSlackServer",
  "startTelegramServer",
  "startWhatsAppServer",
  "startZaloServer",
] as const)(
  "%s initializes recorder ownership before readiness without artifacts",
  async (name) => {
    const api = await import("../src/index.js");
    const directory = await mkdtemp(path.join(os.tmpdir(), "crabline-cold-recorder-"));
    const observer = vi.fn();
    const server = await api[name]({
      onEvent: observer,
      recorderPath: path.join(directory, "missing", "events.jsonl"),
    });
    try {
      expect(native.commands).toContain("/usr/bin/vmmap");
      expect(native.commands).toContain("/usr/sbin/ioreg");
      expect(await readdir(directory)).toEqual([]);
      expect(observer).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
