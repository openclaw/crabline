import path from "node:path";
import fs from "node:fs/promises";
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

  it("isolates exit codes across repeated invocations", async () => {
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
        "  - id: missing-env-fixture",
        "    provider: local",
        "    mode: send",
        "    env:",
        "      - CRABLINE_TEST_MISSING_ENV",
        "    target:",
        "      id: sink-bot",
        "      behavior: sink",
      ].join("\n"),
    );
    const captured = captureWrites();
    const originalEnv = process.env.CRABLINE_TEST_MISSING_ENV;
    delete process.env.CRABLINE_TEST_MISSING_ENV;

    try {
      expect(await runCli(["node", "crabline", "--config", configPath, "doctor"])).toBe(10);
      expect(await runCli(["node", "crabline", "--config", configPath, "fixtures"])).toBe(0);
    } finally {
      captured.restore();
      if (originalEnv !== undefined) {
        process.env.CRABLINE_TEST_MISSING_ENV = originalEnv;
      }
    }
  });

  it("classifies malformed config as a config error", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(configPath, "providers: [\n");
    const captured = captureWrites();

    let exitCode: number;
    try {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    } finally {
      captured.restore();
    }

    expect(exitCode!).toBe(10);
    expect(captured.stderr.join("")).toContain(`Unable to load config file "${configPath}"`);
  });

  it("classifies a missing explicit config path as a config error", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "missing.yaml");
    const captured = captureWrites();

    let exitCode: number;
    try {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    } finally {
      captured.restore();
    }

    expect(exitCode!).toBe(10);
    expect(captured.stderr.join("")).toContain(`Unable to load config file "${configPath}"`);
  });

  it("prints a Telegram server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, ".crabline", "telegram-server.json");
    const captured = captureWrites();

    try {
      expect(
        await runCli([
          "node",
          "crabline",
          "--json",
          "serve",
          "telegram",
          "--once",
          "--ready-file",
          readyFile,
          "--admin-token",
          "test-admin-token",
          "--recorder",
          path.join(directory, "telegram.jsonl"),
        ]),
      ).toBe(0);
    } finally {
      captured.restore();
    }

    const manifest = JSON.parse(captured.stdout.join("")) as {
      adminToken?: string;
      endpoints?: { adminInboundUrl?: string; apiRoot?: string };
      botToken?: string;
      provider?: string;
    };
    expect(manifest.provider).toBe("telegram");
    expect(manifest.adminToken).toBe("test-admin-token");
    expect(manifest.endpoints?.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(manifest.endpoints?.adminInboundUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/crabline\/telegram\/inbound$/u,
    );
    expect(manifest.botToken).toBe("424242:crabline-telegram-token");
    await expect(fs.readFile(readyFile, "utf8")).resolves.toContain('"provider": "telegram"');
  });

  it("prints a Slack server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, ".crabline", "slack-server.json");
    const captured = captureWrites();

    try {
      expect(
        await runCli([
          "node",
          "crabline",
          "--json",
          "serve",
          "slack",
          "--once",
          "--ready-file",
          readyFile,
          "--admin-token",
          "test-admin-token",
          "--bot-token",
          "xoxb-test",
          "--signing-secret",
          "test-signing-secret",
          "--recorder",
          path.join(directory, "slack.jsonl"),
        ]),
      ).toBe(0);
    } finally {
      captured.restore();
    }

    const manifest = JSON.parse(captured.stdout.join("")) as {
      adminToken?: string;
      botToken?: string;
      endpoints?: { adminInboundUrl?: string; apiRoot?: string; eventsUrl?: string };
      provider?: string;
      signingSecret?: string;
    };
    expect(manifest.provider).toBe("slack");
    expect(manifest.adminToken).toBe("test-admin-token");
    expect(manifest.botToken).toBe("xoxb-test");
    expect(manifest.signingSecret).toBe("test-signing-secret");
    expect(manifest.endpoints?.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/$/u);
    expect(manifest.endpoints?.adminInboundUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/crabline\/slack\/inbound$/u,
    );
    expect(manifest.endpoints?.eventsUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/slack\/events$/u);
    await expect(fs.readFile(readyFile, "utf8")).resolves.toContain('"provider": "slack"');
  });

  it("prints a WhatsApp server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, ".crabline", "whatsapp-server.json");
    const captured = captureWrites();

    try {
      expect(
        await runCli([
          "node",
          "crabline",
          "--json",
          "serve",
          "whatsapp",
          "--once",
          "--ready-file",
          readyFile,
          "--admin-token",
          "test-whatsapp-admin-token",
          "--access-token",
          "test-whatsapp-access-token",
          "--recorder",
          path.join(directory, "whatsapp.jsonl"),
        ]),
      ).toBe(0);
    } finally {
      captured.restore();
    }

    const manifest = JSON.parse(captured.stdout.join("")) as {
      accessToken?: string;
      adminToken?: string;
      endpoints?: {
        adminInboundUrl?: string;
        apiRoot?: string;
        baileysWebSocketUrl?: string;
        messagesUrl?: string;
      };
      env?: { CRABLINE_WHATSAPP_BAILEYS_WEB_SOCKET_URL?: string };
      provider?: string;
    };
    expect(manifest.provider).toBe("whatsapp");
    expect(manifest.accessToken).toBe("test-whatsapp-access-token");
    expect(manifest.adminToken).toBe("test-whatsapp-admin-token");
    expect(manifest.endpoints?.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/crabline\/whatsapp$/u);
    expect(manifest.endpoints?.adminInboundUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/crabline\/whatsapp\/inbound$/u,
    );
    expect(manifest.endpoints?.messagesUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/crabline\/whatsapp\/messages$/u,
    );
    expect(manifest.endpoints?.baileysWebSocketUrl).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/crabline\/whatsapp\/ws\/chat\?access_token=test-whatsapp-access-token$/u,
    );
    expect(manifest.env?.CRABLINE_WHATSAPP_BAILEYS_WEB_SOCKET_URL).toBe(
      manifest.endpoints?.baileysWebSocketUrl,
    );
    await expect(fs.readFile(readyFile, "utf8")).resolves.toContain('"provider": "whatsapp"');
  });

  it("doctor accepts local mock slack without live env", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  slack:",
        "    adapter: slack",
        "    platform: slack",
        "    slack: {}",
        "fixtures:",
        "  - id: slack-agent",
        "    provider: slack",
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

    expect(exitCode!).toBe(0);
    expect(captured.stdout.join("")).toContain("doctor ok");
  });

  it("doctor accepts local mock discord without live env", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  discord:",
        "    adapter: discord",
        "    platform: discord",
        "    discord: {}",
        "fixtures:",
        "  - id: discord-agent",
        "    provider: discord",
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

    expect(exitCode!).toBe(0);
    expect(captured.stdout.join("")).toContain("doctor ok");
  });

  it("doctor accepts local mock telegram and whatsapp without live env", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  telegram:",
        "    adapter: telegram",
        "    platform: telegram",
        "    telegram: {}",
        "  whatsapp:",
        "    adapter: whatsapp",
        "    platform: whatsapp",
        "    whatsapp: {}",
        "fixtures:",
        "  - id: telegram-agent",
        "    provider: telegram",
        "    mode: agent",
        "    target:",
        '      id: "123456789"',
        "  - id: whatsapp-agent",
        "    provider: whatsapp",
        "    mode: agent",
        "    target:",
        '      id: "15551234567"',
      ].join("\n"),
    );

    const originals = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_VERIFY_TOKEN;

    const captured = captureWrites();
    let exitCode: number;
    try {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    } finally {
      captured.restore();
      for (const [name, value] of Object.entries(originals)) {
        if (value !== undefined) {
          process.env[name] = value;
        }
      }
    }

    expect(exitCode!).toBe(0);
    expect(captured.stdout.join("")).toContain("doctor ok");
  });
});
