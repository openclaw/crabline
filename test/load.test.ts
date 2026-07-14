import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
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

  it("rejects duplicate keys in JSON manifests", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.json");
    await writeText(
      configPath,
      '{"configVersion":1,"providers":{"local":{"adapter":"loopback","adapter":"script"}},"fixtures":[]}',
    );

    await expect(loadManifest(configPath)).rejects.toThrow(
      /JSON parse error: duplicate object key/u,
    );
  });

  it("parses explicit JSON paths case-insensitively", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.JSON");
    await writeText(configPath, "configVersion: 1\nproviders: {}\nfixtures: []\n");

    await expect(loadManifest(configPath)).rejects.toThrow(/JSON parse error/u);
  });

  it("loads the shipped built-in provider fixture", async () => {
    const loaded = await loadManifest(path.resolve("fixtures/examples/crabline.example.yaml"));

    expect(loaded.manifest.providers.whatsapp?.whatsapp).toMatchObject({
      appSecret: "placeholder",
      verifyToken: "placeholder",
    });
    expect(loaded.manifest.fixtures).toContainEqual(
      expect.objectContaining({ id: "loopback-roundtrip", provider: "local" }),
    );
  });

  it("rejects explicit non-regular config paths", async () => {
    const directory = await createTempDir();
    directories.push(directory);

    await expect(loadManifest(directory)).rejects.toThrow(/must be a regular file/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects an explicit FIFO without waiting for a writer",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const configPath = path.join(directory, "crabline.yaml");
      execFileSync("mkfifo", [configPath]);

      await expect(loadManifest(configPath)).rejects.toThrow(/must be a regular file/u);
    },
    1_000,
  );

  it("rejects oversized config files before parsing", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeFile(configPath, Buffer.alloc(1024 * 1024 + 1, 0x20));

    await expect(loadManifest(configPath)).rejects.toThrow(/exceeds the 1048576-byte limit/u);
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
