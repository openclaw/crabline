import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, disposeTempDir, writeText } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe.skipIf(process.platform === "win32")("CLI shutdown subprocess", () => {
  it("forces exit after a watch shutdown deadline with a ref'd handle", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  local:",
        "    adapter: loopback",
        "fixtures:",
        "  - id: watched",
        "    provider: local",
        "    mode: agent",
        "    target:",
        "      id: echo-bot",
      ].join("\n"),
    );

    const programUrl = new URL("../src/cli/program.ts", import.meta.url).href;
    const script = `
      import { runCli } from ${JSON.stringify(programUrl)};
      setInterval(() => undefined, 1_000);
      let announced = false;
      const pending = () => new Promise(() => undefined);
      const iterator = {
        next() {
          if (!announced) {
            announced = true;
            process.stdout.write("ready\\n");
          }
          return pending();
        },
        return: pending,
      };
      const provider = {
        cleanup: pending,
        watch() {
          return {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          };
        },
      };
      const exitCode = await runCli(
        ["node", "crabline", "--config", ${JSON.stringify(configPath)}, "watch", "watched"],
        {
          dependencies: {
            createRegistry: () => ({
              resolve: () => provider,
            }),
          },
          forceExit: (code) => process.exit(code),
        },
      );
      process.exitCode = exitCode;
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let exitTimeout: NodeJS.Timeout | undefined;
    try {
      await expect.poll(() => stdout, { interval: 10, timeout: 2_000 }).toContain("ready\n");
      child.kill("SIGTERM");
      const [code, signal] = (await Promise.race([
        once(child, "exit"),
        new Promise<never>((_, reject) => {
          exitTimeout = setTimeout(
            () => reject(new Error("CLI did not exit after shutdown deadline")),
            2_000,
          );
        }),
      ])) as [number | null, NodeJS.Signals | null];

      expect(signal).toBeNull();
      expect(code).toBe(1);
      expect(stderr).toContain("Crabline watch lifecycle failed.");
    } finally {
      clearTimeout(exitTimeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });
});
