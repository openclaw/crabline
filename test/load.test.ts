import path from "node:path";
import { mkdir, realpath, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadManifest, resolveConfigPath } from "../src/config/load.js";
import { createTempDir, disposeTempDir, writeJson, writeText } from "./test-helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
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

  it("loads the shipped OpenClaw bridge fixture with YAML anchors", async () => {
    const configPath = path.resolve("fixtures/examples/openclaw-bridge.yaml");

    const loaded = await loadManifest(configPath);

    expect(loaded.manifest.providers["slack-openclaw"]).toMatchObject({
      adapter: "script",
      platform: "slack",
      script: {
        commands: {
          probe: "node ./scripts/openclaw-bridge-probe.mjs",
          send: "node ./scripts/openclaw-bridge-send.mjs",
          waitForInbound: "node ./scripts/openclaw-bridge-wait.mjs",
        },
      },
    });
    expect(loaded.manifest).not.toHaveProperty("x-openclaw-bridge");
  });

  it("rejects invalid inbound regular expressions during config load", async () => {
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
        "  - id: fixture",
        "    provider: local",
        "    mode: roundtrip",
        "    inboundMatch:",
        "      nonce: ignore",
        '      pattern: "["',
        "      strategy: regex",
        "    target:",
        "      id: echo-bot",
      ].join("\n"),
    );

    await expect(loadManifest(configPath)).rejects.toThrow(/valid Unicode regular expression/u);
  });

  it("omits malformed YAML source lines from load errors", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    const sentinel = "sentinel-secret-value";
    await writeText(configPath, `accessToken: ${sentinel}: invalid\n`);

    let failure: unknown;
    try {
      await loadManifest(configPath);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("YAML parse error");
    expect((failure as Error).message).toContain("line 1, column");
    expect((failure as Error).message).not.toContain(sentinel);
    expect((failure as Error).message).not.toContain("accessToken");
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("YAML parse error");
    expect((cause as Error).message).not.toContain(sentinel);
    expect((cause as Error).message).not.toContain("accessToken");
  });

  it("omits malformed JSON source text from load errors", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.json");
    const sentinel = "sentinel-json-secret";
    await writeText(configPath, `{"accessToken":"${sentinel}",}`);

    let failure: unknown;
    try {
      await loadManifest(configPath);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("JSON parse error");
    expect((failure as Error).message).not.toContain(sentinel);
    expect((failure as Error).message).not.toContain("accessToken");
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("JSON parse error");
    expect((cause as Error).message).not.toContain(sentinel);
    expect((cause as Error).message).not.toContain("accessToken");
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

  it("skips config-name directories during discovery", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    await mkdir(path.join(directory, "crabline.yaml"));
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
    vi.mocked(stat).mockRejectedValueOnce(error);

    await expect(resolveConfigPath()).rejects.toBe(error);
  });
});
