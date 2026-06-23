import path from "node:path";
import { realpath, access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadManifest, resolveConfigPath } from "../src/config/load.js";
import { createTempDir, disposeTempDir, writeJson, writeText } from "./test-helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("config load", () => {
  it("loads yaml manifests", async () => {
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
        "    platform: loopback",
        "fixtures:",
        "  - id: fixture",
        "    provider: local",
        "    mode: send",
        "    target:",
        "      id: test-target",
      ].join("\n"),
    );

    const loaded = await loadManifest(configPath);
    expect(loaded.manifest.fixtures[0]?.id).toBe("fixture");
  });

  it("loads json manifests", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.json");
    await writeJson(configPath, {
      configVersion: 1,
      fixtures: [{ id: "fixture", mode: "send", provider: "local", target: { id: "test-target" } }],
      providers: { local: { adapter: "loopback", platform: "loopback" } },
    });

    const loaded = await loadManifest(configPath);
    expect(loaded.path).toBe(configPath);
  });

  it("resolves default config names from cwd", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yml");
    await writeText(configPath, "configVersion: 1\nproviders: {}\nfixtures: []\n");
    const originalCwd = process.cwd();

    process.chdir(directory);
    try {
      expect(await realpath(await resolveConfigPath())).toBe(await realpath(configPath));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fails when no config file exists", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const originalCwd = process.cwd();

    process.chdir(directory);
    try {
      await expect(resolveConfigPath()).rejects.toThrow(/No config file found/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("surfaces non-missing filesystem errors during discovery", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(access).mockRejectedValueOnce(error);

    await expect(resolveConfigPath()).rejects.toBe(error);
  });
});
