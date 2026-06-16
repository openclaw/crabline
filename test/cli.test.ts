import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/program.js";
import { captureWrites, createTempDir, disposeTempDir, writeText } from "./test-helpers.js";

const directories: string[] = [];
const ansiPattern = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value: string): string => value.replace(ansiPattern, "");

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

const createConfig = async (): Promise<string> => {
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
      "    loopback:",
      "      delayMs: 0",
      "fixtures:",
      "  - id: roundtrip-fixture",
      "    provider: local",
      "    mode: roundtrip",
      "    target:",
      "      id: echo-bot",
      "      behavior: echo",
      "  - id: send-fixture",
      "    provider: local",
      "    mode: send",
      "    target:",
      "      id: sink-bot",
      "      behavior: sink",
    ].join("\n"),
  );
  return configPath;
};

describe("cli", () => {
  it("lists providers and fixtures", async () => {
    const configPath = await createConfig();
    const captured = captureWrites();

    try {
      expect(await runCli(["node", "crabline", "--config", configPath, "providers"])).toBe(0);
      expect(await runCli(["node", "crabline", "--config", configPath, "fixtures"])).toBe(0);
    } finally {
      captured.restore();
    }

    expect(captured.stdout.join("")).toContain("configured providers:");
    expect(captured.stdout.join("")).toContain("roundtrip-fixture");
  });

  it("lists local channel driver metadata", async () => {
    const captured = captureWrites();

    try {
      expect(await runCli(["node", "crabline", "channel-matrix"])).toBe(0);
      expect(await runCli(["node", "crabline", "--json", "channel-matrix"])).toBe(0);
    } finally {
      captured.restore();
    }

    const stdout = captured.stdout.join("");
    expect(stdout).toContain("telegram channel=telegram version=1");
    expect(stdout).toContain("telegram.dm.text");
    expect(JSON.parse(stdout.slice(stdout.indexOf("{")))).toMatchObject({
      drivers: [expect.objectContaining({ driverId: "telegram", driverVersion: 1 })],
    });
  });

  it("runs doctor, probe, send, roundtrip, and suite commands", async () => {
    const configPath = await createConfig();
    const captured = captureWrites();

    try {
      expect(await runCli(["node", "crabline", "--config", configPath, "doctor"])).toBe(0);
      expect(
        await runCli(["node", "crabline", "--config", configPath, "probe", "roundtrip-fixture"]),
      ).toBe(0);
      expect(
        await runCli(["node", "crabline", "--config", configPath, "send", "send-fixture"]),
      ).toBe(0);
      expect(
        await runCli([
          "node",
          "crabline",
          "--config",
          configPath,
          "roundtrip",
          "roundtrip-fixture",
        ]),
      ).toBe(0);
      expect(
        await runCli([
          "node",
          "crabline",
          "--config",
          configPath,
          "run",
          "roundtrip-fixture",
          "send-fixture",
        ]),
      ).toBe(0);
    } finally {
      captured.restore();
    }

    const stdout = stripAnsi(captured.stdout.join(""));
    expect(stdout).toContain("doctor ok");
    expect(stdout).toContain("PASS roundtrip-fixture");
    expect(stdout).toContain("suite 2/2 passed");
  });

  it("reports CLI errors to stderr", async () => {
    const configPath = await createConfig();
    const captured = captureWrites();

    let exitCode: number;
    try {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "probe", "missing"]);
    } finally {
      captured.restore();
    }

    expect(exitCode!).toBe(10);
    expect(captured.stderr.join("")).toContain("No fixture found");
  });

  it("doctor reports missing slack env", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  slack-native:",
        "    adapter: slack",
        "    platform: slack",
        "    slack: {}",
        "fixtures:",
        "  - id: slack-agent",
        "    provider: slack-native",
        "    mode: agent",
        "    target:",
        "      id: C1234567890",
      ].join("\n"),
    );

    const originalBotToken = process.env.SLACK_BOT_TOKEN;
    const originalSigningSecret = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;

    const captured = captureWrites();
    let exitCode: number;
    try {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    } finally {
      captured.restore();
      if (originalBotToken !== undefined) {
        process.env.SLACK_BOT_TOKEN = originalBotToken;
      }
      if (originalSigningSecret !== undefined) {
        process.env.SLACK_SIGNING_SECRET = originalSigningSecret;
      }
    }

    expect(exitCode!).toBe(10);
    expect(captured.stdout.join("")).toContain("missing env SLACK_BOT_TOKEN");
    expect(captured.stdout.join("")).toContain("missing env SLACK_SIGNING_SECRET");
  });

  it("doctor reports missing discord bot token", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  discord-native:",
        "    adapter: discord",
        "    platform: discord",
        "    discord: {}",
        "fixtures:",
        "  - id: discord-agent",
        "    provider: discord-native",
        "    mode: agent",
        "    target:",
        '      id: "123456789012345678"',
        "      metadata:",
        '        guildId: "987654321098765432"',
      ].join("\n"),
    );

    const originalBotToken = process.env.DISCORD_BOT_TOKEN;
    const originalPublicKey = process.env.DISCORD_PUBLIC_KEY;
    const originalApplicationId = process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_PUBLIC_KEY;
    delete process.env.DISCORD_APPLICATION_ID;

    const captured = captureWrites();
    let exitCode: number;
    try {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    } finally {
      captured.restore();
      if (originalBotToken !== undefined) {
        process.env.DISCORD_BOT_TOKEN = originalBotToken;
      }
      if (originalPublicKey !== undefined) {
        process.env.DISCORD_PUBLIC_KEY = originalPublicKey;
      }
      if (originalApplicationId !== undefined) {
        process.env.DISCORD_APPLICATION_ID = originalApplicationId;
      }
    }

    expect(exitCode!).toBe(10);
    expect(captured.stdout.join("")).toContain("missing discord.botToken or DISCORD_BOT_TOKEN");
  });
});
