import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, disposeTempDir, writeText } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

const parseManifest = (output: string): Record<string, unknown> => {
  return JSON.parse(output.trim()) as Record<string, unknown>;
};

const spawnChecked = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): string => {
  const result = spawnSync(command, args, { ...options, timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  if (result.status !== 0) {
    throw new Error(`Subprocess exited with status ${String(result.status)}:\n${result.stderr}`);
  }
  return result.stdout;
};

const spawnPnpmChecked = (args: string[], options: SpawnSyncOptionsWithStringEncoding): string => {
  if (process.platform !== "win32") {
    return spawnChecked("pnpm", args, options);
  }
  const command = `"${["pnpm.cmd", ...args]
    .map((value) => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`)
    .join(" ")}"`;
  return spawnChecked(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    ...options,
    windowsVerbatimArguments: true,
  });
};

describe("CLI credential subprocess ingress", () => {
  it("reads package-runner credentials from stdin fd 0", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const recorderPath = path.join(directory, "package-runner.jsonl");
    const output = spawnPnpmChecked(
      [
        "--silent",
        "dev",
        "--json",
        "serve",
        "slack",
        "--once",
        "--recorder",
        recorderPath,
        "--credentials-fd",
        "0",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        input: JSON.stringify({
          adminToken: "fake",
          botToken: "sample",
          signingSecret: "fake",
        }),
      },
    );

    expect(parseManifest(output)).toMatchObject({
      adminToken: "fake",
      botToken: "sample",
      signingSecret: "fake",
    });
  });

  it("reads an inherited descriptor through direct Node execution", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    const recorderPath = path.join(directory, "direct-node.jsonl");
    await writeText(
      credentialsPath,
      JSON.stringify({
        adminToken: "admin",
        botToken: "sample",
        signingSecret: "fake",
      }),
    );
    const credentialsHandle = await fs.open(credentialsPath, "r");

    try {
      const output = spawnChecked(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/bin/crabline.ts",
          "--json",
          "serve",
          "slack",
          "--once",
          "--recorder",
          recorderPath,
          "--credentials-fd",
          "3",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe", credentialsHandle.fd],
        },
      );

      expect(parseManifest(output)).toMatchObject({
        adminToken: "admin",
        botToken: "sample",
        signingSecret: "fake",
      });
    } finally {
      await credentialsHandle.close();
    }
  });
});
