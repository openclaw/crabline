import { EventEmitter } from "node:events";
import { closeSync, fstatSync, openSync, type Stats } from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProgram,
  publishReadyFile,
  removeReadyFile,
  runCli,
  waitForShutdown,
} from "../src/cli/program.js";
import type { StartCrablineServerParams, StartedCrablineServer } from "../src/servers/index.js";
import {
  captureWrites,
  createTempDir,
  createWriteCapture,
  disposeTempDir,
  writeText,
} from "./test-helpers.js";

const lockState = vi.hoisted(() => ({
  options: [] as unknown[],
  releaseError: undefined as Error | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    async lock(...args: Parameters<typeof actual.lock>) {
      lockState.options.push(args[1]);
      const release = await actual.lock(...args);
      return async () => {
        await release();
        if (lockState.releaseError) {
          throw lockState.releaseError;
        }
      };
    },
  };
});

const directories: string[] = [];
const ansiPattern = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value: string): string => value.replace(ansiPattern, "");

const expectDescriptorReleased = (fd: number, original: Stats): void => {
  try {
    const current = fstatSync(fd);
    expect([current.dev, current.ino]).not.toEqual([original.dev, original.ino]);
  } catch (error) {
    expect(error).toMatchObject({ code: "EBADF" });
  }
};

const closeIfStillOwned = (fd: number, original: Stats): void => {
  try {
    const current = fstatSync(fd);
    if (current.dev === original.dev && current.ino === original.ino) {
      closeSync(fd);
    }
  } catch {
    // The descriptor was already closed or reassigned.
  }
};

afterEach(async () => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  lockState.options.length = 0;
  lockState.releaseError = undefined;
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
    const captured = await captureWrites(async () => {
      expect(await runCli(["node", "crabline", "--config", configPath, "providers"])).toBe(0);
      expect(await runCli(["node", "crabline", "--config", configPath, "fixtures"])).toBe(0);
    });

    expect(captured.stdout.join("")).toContain("configured providers:");
    expect(captured.stdout.join("")).toContain("roundtrip-fixture");
  });

  it("returns failure when successful JSON output cannot be serialized", async () => {
    const configPath = await createConfig();
    let exitCode = -1;
    const captured = await captureWrites(async () => {
      exitCode = await runCli(
        ["node", "crabline", "--json", "--config", configPath, "providers"],
        {
          dependencies: {
            createRegistry: () =>
              ({
                catalog: [{ value: 1n }],
              }) as never,
          },
        },
      );
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(captured.stdout.join(""))).toEqual({
      error: { message: "Unable to serialize JSON output." },
      ok: false,
    });
  });

  it("sanitizes user-controlled fixture fields in text output", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.json");
    await writeText(
      configPath,
      JSON.stringify({
        configVersion: 1,
        fixtures: [
          {
            id: "fixture",
            mode: "send",
            provider: "local\u001b[2J",
            target: { id: "sink\u0007\nnext" },
          },
        ],
        providers: {
          "local\u001b[2J": { adapter: "loopback", platform: "loopback" },
        },
      }),
    );
    const captured = await captureWrites(async () => {
      expect(await runCli(["node", "crabline", "--config", configPath, "fixtures"])).toBe(0);
    });

    const output = captured.stdout.join("");
    expect(output).toContain(String.raw`provider=local\x1b[2J`);
    expect(output).toContain(String.raw`target=sink\x07\nnext`);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
  });

  it("runs doctor, probe, send, roundtrip, and suite commands", async () => {
    const configPath = await createConfig();
    const captured = await captureWrites(async () => {
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
    });

    const stdout = stripAnsi(captured.stdout.join(""));
    expect(stdout).toContain("doctor ok");
    expect(stdout).toContain("PASS roundtrip-fixture");
    expect(stdout).toContain("suite 2/2 passed");
  });

  it("reports CLI errors to stderr", async () => {
    const configPath = await createConfig();
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "probe", "missing"]);
    });

    expect(exitCode!).toBe(10);
    expect(captured.stderr.join("")).toContain("Unknown fixture");
  });

  it("treats closed ordinary stdout and stderr pipes as graceful", async () => {
    const configPath = await createConfig();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((() => {
      throw Object.assign(new Error("closed stdout"), { code: "EPIPE" });
    }) as typeof process.stdout.write);

    try {
      await expect(runCli(["node", "crabline", "--config", configPath, "fixtures"])).resolves.toBe(
        0,
      );
    } finally {
      stdoutWrite.mockRestore();
    }

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((() => {
      throw Object.assign(new Error("closed stderr"), { code: "ERR_STREAM_DESTROYED" });
    }) as typeof process.stderr.write);
    try {
      await expect(
        runCli(["node", "crabline", "--config", configPath, "probe", "missing"]),
      ).resolves.toBe(10);
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("reports JSON failures as one machine-readable document", async () => {
    const configPath = await createConfig();
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli([
        "node",
        "crabline",
        "--json",
        "--config",
        configPath,
        "probe",
        "missing",
      ]);
    });

    expect(exitCode!).toBe(10);
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        exitCode: 10,
        kind: "config",
        message: "Unknown fixture: missing",
      },
      ok: false,
    });
  });

  it("keeps Commander exits inside runCli without duplicate output", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit must not be called");
    });
    const captured = await captureWrites(async () => {
      try {
        expect(await runCli(["node", "crabline", "not-a-command"])).toBe(1);
        expect(await runCli(["node", "crabline", "--help"])).toBe(0);
      } finally {
        exit.mockRestore();
      }
    });

    expect(exit).not.toHaveBeenCalled();
    expect(captured.stderr.join("").match(/unknown command 'not-a-command'/gu)).toHaveLength(1);
    expect(captured.stdout.join("")).toContain("Usage: crabline");
  });

  it("serializes Commander failures when JSON output is requested", async () => {
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--json", "not-a-command"]);
    });

    expect(exitCode!).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "commander.unknownCommand",
        exitCode: 1,
        message: "error: unknown command 'not-a-command'",
      },
      ok: false,
    });
  });

  it("suppresses subcommand parser output in JSON mode", async () => {
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--json", "probe"]);
    });

    expect(exitCode!).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "commander.missingArgument",
        exitCode: 1,
        message: "error: missing required argument 'fixtureId'",
      },
      ok: false,
    });
  });

  it("reports a useful JSON error when no command is specified", async () => {
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--json"]);
    });

    expect(exitCode!).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "commander.help",
        exitCode: 1,
        message: "No command specified.",
      },
      ok: false,
    });
  });

  it("normalizes missing-command exit codes independently of process state", async () => {
    process.exitCode = 10;
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--json"]);
    });

    expect(exitCode!).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "commander.help",
        exitCode: 1,
        message: "No command specified.",
      },
      ok: false,
    });
  });

  it("does not treat --json option values or positional arguments as the global flag", async () => {
    const configPath = await createConfig();
    const captured = await captureWrites(async () => {
      expect(await runCli(["node", "crabline", "--config", "--json", "doctor"])).toBe(10);
      expect(
        await runCli(["node", "crabline", "--config", configPath, "probe", "--", "--json"]),
      ).toBe(10);
    });

    const stderr = captured.stderr.join("");
    expect(stderr).toMatch(/Unable to load config file ".*\/--json"/u);
    expect(stderr).toContain("Unknown fixture: --json");
    expect(() => JSON.parse(stderr)).toThrow(SyntaxError);
  });

  it("documents probe as a fixture-only command", () => {
    const probe = createProgram().commands.find((command) => command.name() === "probe");

    expect(probe?.usage()).toBe("[options] <fixtureId>");
    expect(probe?.description()).toBe("Probe provider readiness using a fixture");
  });

  it("rejects non-decimal serve ports before startup", async () => {
    const startServer = vi.fn();
    const program = createProgram(() => undefined, { startServer });

    for (const port of ["1e3", "0x10", " 80"]) {
      await expect(
        program.parseAsync(["node", "crabline", "serve", "slack", "--port", port, "--once"]),
      ).rejects.toThrow(`Invalid local server port: ${port}`);
    }
    expect(startServer).not.toHaveBeenCalled();
  });

  it("documents safe serve credential ingress without advertising secret flags", async () => {
    const captured = await captureWrites(async () => {
      expect(await runCli(["node", "crabline", "serve", "--help"])).toBe(0);
    });

    const help = captured.stdout.join("");
    expect(help).toContain("--credentials-fd <fd>");
    expect(help).toContain("accessToken, adminToken, botToken, signingSecret");
    expect(help).toContain("CRABLINE_ACCESS_TOKEN");
    expect(help).not.toContain("--access-token");
    expect(help).not.toContain("--admin-token");
    expect(help).not.toContain("--bot-token");
    expect(help).not.toContain("--signing-secret");
  });

  it("rejects command-line credential values without echoing them", async () => {
    const unsafeArguments = [
      ["--access-token", "access-value"],
      [["--access-token", "access-equals-value"].join("=")],
      ["--admin-token", "admin-value"],
      [["--admin-token", "admin-equals-value"].join("=")],
      ["--bot-token", "bot-value"],
      [["--bot-token", "bot-equals-value"].join("=")],
      ["--signing-secret", "signing-value"],
      [["--signing-secret", "signing-equals-value"].join("=")],
    ];

    const captured = await captureWrites(async () => {
      for (const args of unsafeArguments) {
        expect(await runCli(["node", "crabline", "serve", "slack", "--once", ...args])).toBe(10);
      }
    });

    const stderr = captured.stderr.join("");
    expect(stderr).toContain("no longer accepts credential values in command-line arguments");
    for (const sentinel of [
      "access-value",
      "access-equals-value",
      "admin-value",
      "admin-equals-value",
      "bot-value",
      "bot-equals-value",
      "signing-value",
      "signing-equals-value",
    ]) {
      expect(stderr).not.toContain(sentinel);
    }
  });

  it("loads partial serve secrets from a bounded file descriptor over env", async () => {
    vi.stubEnv("CRABLINE_ACCESS_TOKEN", "example");
    vi.stubEnv("CRABLINE_ADMIN_TOKEN", "fake");
    vi.stubEnv("CRABLINE_BOT_TOKEN", "sample");
    vi.stubEnv("CRABLINE_SIGNING_SECRET", "test-token-placeholder");
    const directory = await createTempDir();
    directories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    const fdBot = ["fd", "bot"].join("-");
    await writeText(credentialsPath, JSON.stringify({ botToken: fdBot }));
    const credentialsFd = openSync(credentialsPath, "r");
    const credentialsIdentity = fstatSync(credentialsFd);
    const startServer = vi.fn(
      async (_params: StartCrablineServerParams): Promise<StartedCrablineServer> => ({
        async close() {},
        manifest: {
          adminToken: "fake",
          baseUrl: "http://127.0.0.1:12345",
          botToken: fdBot,
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/slack/inbound",
            apiRoot: "http://127.0.0.1:12345/api/",
            eventsUrl: "http://127.0.0.1:12345/slack/events",
          },
          env: {
            SLACK_API_URL: "http://127.0.0.1:12345/api/",
            SLACK_BOT_TOKEN: fdBot,
            SLACK_SIGNING_SECRET: "test-token-placeholder",
          },
          provider: "slack" as const,
          recorderPath: "/tmp/slack.jsonl",
          signingSecret: "test-token-placeholder",
          version: 1 as const,
        },
      }),
    );
    const program = createProgram(() => undefined, { startServer });
    try {
      await captureWrites(async () => {
        await program.parseAsync([
          "node",
          "crabline",
          "--json",
          "serve",
          "slack",
          "--credentials-fd",
          String(credentialsFd),
          "--once",
        ]);
      });
      expectDescriptorReleased(credentialsFd, credentialsIdentity);
    } finally {
      closeIfStillOwned(credentialsFd, credentialsIdentity);
    }

    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        adminToken: "fake",
        botToken: fdBot,
        channel: "slack",
        signingSecret: "test-token-placeholder",
      }),
    );
  });

  it("accepts credential JSON at the exact byte limit", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    const emptyDocumentBytes = Buffer.byteLength(JSON.stringify({ botToken: "" }));
    const botToken = "x".repeat(64 * 1024 - emptyDocumentBytes);
    const document = JSON.stringify({ botToken });
    expect(Buffer.byteLength(document)).toBe(64 * 1024);
    await writeText(credentialsPath, document);
    const credentialsFd = openSync(credentialsPath, "r");
    const credentialsIdentity = fstatSync(credentialsFd);
    const startServer = vi.fn(
      async (): Promise<StartedCrablineServer> => ({
        async close() {},
        manifest: {
          adminToken: "fake",
          baseUrl: "http://127.0.0.1:12345",
          botToken,
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/slack/inbound",
            apiRoot: "http://127.0.0.1:12345/api/",
            eventsUrl: "http://127.0.0.1:12345/slack/events",
          },
          env: {
            SLACK_API_URL: "http://127.0.0.1:12345/api/",
            SLACK_BOT_TOKEN: botToken,
            SLACK_SIGNING_SECRET: "fake",
          },
          provider: "slack" as const,
          recorderPath: "/tmp/slack.jsonl",
          signingSecret: "fake",
          version: 1 as const,
        },
      }),
    );
    const program = createProgram(() => undefined, { startServer });

    try {
      await captureWrites(async () => {
        await program.parseAsync([
          "node",
          "crabline",
          "serve",
          "slack",
          "--credentials-fd",
          String(credentialsFd),
          "--once",
        ]);
      });
      expectDescriptorReleased(credentialsFd, credentialsIdentity);
    } finally {
      closeIfStillOwned(credentialsFd, credentialsIdentity);
    }

    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ botToken }));
  });

  it("rejects unsupported or non-string credential fields", async () => {
    const directory = await createTempDir();
    directories.push(directory);

    for (const [index, [document, message]] of (
      [
        [JSON.stringify({ password: "hidden" }), "contains unsupported fields"],
        [JSON.stringify({ botToken: 42 }), "values must be strings"],
      ] as const
    ).entries()) {
      const credentialsPath = path.join(directory, `${index}.json`);
      await writeText(credentialsPath, document);
      const credentialsFd = openSync(credentialsPath, "r");
      const credentialsIdentity = fstatSync(credentialsFd);
      try {
        const captured = await captureWrites(async () => {
          expect(
            await runCli([
              "node",
              "crabline",
              "serve",
              "slack",
              "--once",
              "--credentials-fd",
              String(credentialsFd),
            ]),
          ).toBe(10);
        });
        expectDescriptorReleased(credentialsFd, credentialsIdentity);
        expect(captured.stderr.join("")).toContain(message);
        expect(captured.stderr.join("")).not.toContain(document);
      } finally {
        closeIfStillOwned(credentialsFd, credentialsIdentity);
      }
    }
  });

  it("rejects malformed credential streams without echoing their contents", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    const sentinel = "credential-stream-secret";
    await writeText(credentialsPath, `{"adminToken":"${sentinel}"`);
    const credentialsFd = openSync(credentialsPath, "r");
    const credentialsIdentity = fstatSync(credentialsFd);
    try {
      const captured = await captureWrites(async () => {
        expect(
          await runCli([
            "node",
            "crabline",
            "serve",
            "slack",
            "--once",
            "--credentials-fd",
            String(credentialsFd),
          ]),
        ).toBe(10);
      });
      expectDescriptorReleased(credentialsFd, credentialsIdentity);
      expect(captured.stderr.join("")).toContain("Serve credentials input must be valid JSON.");
      expect(captured.stderr.join("")).not.toContain(sentinel);
    } finally {
      closeIfStillOwned(credentialsFd, credentialsIdentity);
    }
  });

  it("bounds credential streams before parsing them", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    await writeText(credentialsPath, JSON.stringify({ adminToken: "x".repeat(64 * 1024) }));
    const credentialsFd = openSync(credentialsPath, "r");
    const credentialsIdentity = fstatSync(credentialsFd);
    try {
      const captured = await captureWrites(async () => {
        expect(
          await runCli([
            "node",
            "crabline",
            "serve",
            "slack",
            "--once",
            "--credentials-fd",
            String(credentialsFd),
          ]),
        ).toBe(10);
      });
      expectDescriptorReleased(credentialsFd, credentialsIdentity);
      expect(captured.stderr.join("")).toContain("Serve credentials JSON exceeds 65536 bytes.");
    } finally {
      closeIfStillOwned(credentialsFd, credentialsIdentity);
    }
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
    const originalEnv = process.env.CRABLINE_TEST_MISSING_ENV;
    delete process.env.CRABLINE_TEST_MISSING_ENV;

    await captureWrites(async () => {
      try {
        expect(await runCli(["node", "crabline", "--config", configPath, "doctor"])).toBe(10);
        expect(await runCli(["node", "crabline", "--config", configPath, "fixtures"])).toBe(0);
      } finally {
        if (originalEnv !== undefined) {
          process.env.CRABLINE_TEST_MISSING_ENV = originalEnv;
        }
      }
    });
  });

  it("classifies malformed config as a config error", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(configPath, "providers: [\n");
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    });

    expect(exitCode!).toBe(10);
    expect(captured.stderr.join("")).toContain(`Unable to load config file "${configPath}"`);
  });

  it("classifies a missing explicit config path as a config error", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "missing.yaml");
    let exitCode: number;

    const captured = await captureWrites(async () => {
      exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
    });

    expect(exitCode!).toBe(10);
    expect(captured.stderr.join("")).toContain(`Unable to load config file "${configPath}"`);
  });

  it("closes once and removes both shutdown listeners", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const shutdown = waitForShutdown(close, signals);

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await shutdown;

    expect(close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("preserves an existing ready file when replacement startup fails", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    await writeText(readyFile, "stale\n");
    const startError = new Error("start exploded");
    const program = createProgram(() => undefined, {
      startServer: async () => {
        throw startError;
      },
    });

    await expect(
      program.parseAsync([
        "node",
        "crabline",
        "--json",
        "serve",
        "telegram",
        "--ready-file",
        readyFile,
      ]),
    ).rejects.toBe(startError);
    await expect(fs.readFile(readyFile, "utf8")).resolves.toBe("stale\n");
  });

  it("restores an existing ready file when replacement verification fails", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    await writeText(readyFile, "stale\n");
    const identityError = new Error("identity read failed");
    const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(identityError);

    try {
      await expect(publishReadyFile(readyFile, "replacement\n")).rejects.toBe(identityError);
    } finally {
      statSpy.mockRestore();
    }

    await expect(fs.readFile(readyFile, "utf8")).resolves.toBe("stale\n");
  });

  it("replaces an existing ready file without hard-linking its backup", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    await writeText(readyFile, "stale\n");
    const linkSpy = vi.spyOn(fs, "link");

    await expect(publishReadyFile(readyFile, "replacement\n")).resolves.toBeDefined();

    expect(linkSpy).not.toHaveBeenCalled();
    linkSpy.mockRestore();
    await expect(fs.readFile(readyFile, "utf8")).resolves.toBe("replacement\n");
    expect(await fs.readdir(directory)).toEqual(["server.json"]);
  });

  it("does not recursively remove a stale non-lock directory", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    const lockPath = `${readyFile}.lock`;
    const sentinelPath = path.join(lockPath, "keep.txt");
    await fs.mkdir(lockPath);
    await fs.writeFile(sentinelPath, "unrelated\n");
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await expect(publishReadyFile(readyFile, "manifest\n")).rejects.toMatchObject({
      code: "ELOCKED",
    });
    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("unrelated\n");
  });

  it("removes a committed ready file when lock release fails", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    const releaseError = new Error("release exploded");
    lockState.releaseError = releaseError;

    await expect(publishReadyFile(readyFile, "manifest\n")).rejects.toBe(releaseError);

    await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement swapped in during owned ready-file removal", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    const displacedFile = path.join(directory, "displaced.json");
    const contents = "owned\n";
    const identity = await publishReadyFile(readyFile, contents);
    const actualRename = fs.rename;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (source === readyFile && String(destination).endsWith(".remove")) {
        await actualRename(readyFile, displacedFile);
        await fs.writeFile(readyFile, "replacement\n");
      }
      await actualRename(source, destination);
    });

    try {
      await removeReadyFile(readyFile, contents, identity);
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readFile(readyFile, "utf8")).resolves.toBe("replacement\n");
    await expect(fs.readFile(displacedFile, "utf8")).resolves.toBe(contents);
  });

  it("closes the server once when ready-file publication fails after startup", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const close = vi.fn(async () => undefined);
    const removeReadyFileMock = vi.fn(async () => undefined);
    const publishError = new Error("publish exploded");
    const server = {
      close,
      manifest: {
        adminToken: "admin",
        baseUrl: "http://127.0.0.1:12345",
        botToken: "424242:token",
        endpoints: {
          adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
          apiRoot: "http://127.0.0.1:12345",
        },
        env: {
          TELEGRAM_BOT_TOKEN: "424242:token",
        },
        provider: "telegram",
        recorderPath: path.join(directory, "telegram.jsonl"),
        version: 1,
      },
    } satisfies StartedCrablineServer;
    const program = createProgram(() => undefined, {
      publishReadyFile: async () => {
        throw publishError;
      },
      removeReadyFile: removeReadyFileMock,
      startServer: async () => server,
    });

    await expect(
      program.parseAsync([
        "node",
        "crabline",
        "--json",
        "serve",
        "telegram",
        "--ready-file",
        path.join(directory, "server.json"),
      ]),
    ).rejects.toBe(publishError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(removeReadyFileMock).not.toHaveBeenCalled();
  });

  it("withdraws readiness but holds ownership until server shutdown completes", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    let releaseClose: (() => void) | undefined;
    const closeBlocked = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let markCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const server = {
      async close() {
        markCloseStarted?.();
        await closeBlocked;
      },
      manifest: {
        adminToken: "fake",
        baseUrl: "http://127.0.0.1:12345",
        botToken: "sample",
        endpoints: {
          adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
          apiRoot: "http://127.0.0.1:12345",
        },
        env: {
          TELEGRAM_BOT_TOKEN: "sample",
        },
        provider: "telegram",
        recorderPath: path.join(directory, "telegram.jsonl"),
        version: 1,
      },
    } satisfies StartedCrablineServer;
    const firstProgram = createProgram(() => undefined, {
      startServer: async () => server,
    });
    await captureWrites(async () => {
      try {
        const first = firstProgram.parseAsync([
          "node",
          "crabline",
          "--json",
          "serve",
          "telegram",
          "--once",
          "--ready-file",
          readyFile,
        ]);
        await closeStarted;
        const secondStart = vi.fn(async () => server);
        const secondProgram = createProgram(() => undefined, { startServer: secondStart });

        await expect(
          secondProgram.parseAsync([
            "node",
            "crabline",
            "--json",
            "serve",
            "telegram",
            "--once",
            "--ready-file",
            readyFile,
          ]),
        ).rejects.toBeInstanceOf(Error);
        expect(secondStart).not.toHaveBeenCalled();
        await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        releaseClose?.();
        await first;
      } finally {
        releaseClose?.();
      }
    });

    await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not announce readiness when shutdown starts during publication", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    const lifecycle: string[] = [];
    let releasePublish: (() => void) | undefined;
    let markPublishStarted: (() => void) | undefined;
    const publishStarted = new Promise<void>((resolve) => {
      markPublishStarted = resolve;
    });
    const publishBlocked = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const close = vi.fn(async () => {
      lifecycle.push("close");
    });
    const releaseReadyLease = vi.fn(async () => {
      lifecycle.push("release");
    });
    const removeReadyFileMock = vi.fn(async () => {
      lifecycle.push("remove");
    });
    const program = createProgram(() => undefined, {
      acquireReadyFileLease: async () => releaseReadyLease,
      publishReadyFile: async () => {
        markPublishStarted?.();
        await publishBlocked;
        return {
          birthtimeNs: 1n,
          ctimeNs: 1n,
          dev: 1n,
          ino: 1n,
          size: 1n,
        };
      },
      removeReadyFile: removeReadyFileMock,
      startServer: async () => ({
        close,
        manifest: {
          adminToken: "admin",
          baseUrl: "http://127.0.0.1:12345",
          botToken: ["424242", "test-token-placeholder"].join(":"),
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: {
            TELEGRAM_BOT_TOKEN: ["424242", "test-token-placeholder"].join(":"),
          },
          provider: "telegram",
          recorderPath: path.join(directory, "telegram.jsonl"),
          version: 1,
        },
      }),
    });
    const captured = await captureWrites(async () => {
      const running = program.parseAsync([
        "node",
        "crabline",
        "--json",
        "serve",
        "telegram",
        "--ready-file",
        readyFile,
      ]);
      await publishStarted;

      process.emit("SIGTERM", "SIGTERM");
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      releasePublish?.();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      await running;
    });

    expect(captured.stdout).toEqual([]);
    expect(removeReadyFileMock).toHaveBeenCalledTimes(1);
    expect(releaseReadyLease).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(["remove", "close", "release"]);
  });

  it("uses one heartbeat lease policy for ready-file ownership", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const readyFile = path.join(directory, "server.json");
    const program = createProgram(() => undefined, {
      startServer: async () => ({
        close: async () => undefined,
        manifest: {
          adminToken: "fake",
          baseUrl: "http://127.0.0.1:12345",
          botToken: "sample",
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: { TELEGRAM_BOT_TOKEN: "sample" },
          provider: "telegram",
          recorderPath: path.join(directory, "telegram.jsonl"),
          version: 1,
        },
      }),
    });

    await program.parseAsync([
      "node",
      "crabline",
      "--json",
      "serve",
      "telegram",
      "--once",
      "--ready-file",
      readyFile,
    ]);

    expect(lockState.options).toHaveLength(1);
    expect(lockState.options[0]).toMatchObject({
      stale: 60_000,
      update: 1_000,
    });
  });

  it("reports a signal-triggered close failure only once", async () => {
    const closeError = new Error("close exploded");
    const close = vi.fn(async () => {
      throw closeError;
    });
    const program = createProgram(() => undefined, {
      startServer: async () => ({
        close,
        manifest: {
          adminToken: "fake",
          baseUrl: "http://127.0.0.1:12345",
          botToken: "sample",
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: { TELEGRAM_BOT_TOKEN: "sample" },
          provider: "telegram",
          recorderPath: "telegram.jsonl",
          version: 1,
        },
      }),
    });
    const running = program
      .parseAsync(["node", "crabline", "--json", "serve", "telegram"])
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0));

    process.emit("SIGTERM", "SIGTERM");

    await expect(running).resolves.toBe(closeError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps signal handlers installed until server cleanup completes", async () => {
    let finishClose: (() => void) | undefined;
    const close = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const baseline = process.listenerCount("SIGTERM");
    const program = createProgram(() => undefined, {
      startServer: async () => ({
        close,
        manifest: {
          adminToken: "fake",
          baseUrl: "http://127.0.0.1:12345",
          botToken: "sample",
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: { TELEGRAM_BOT_TOKEN: "sample" },
          provider: "telegram",
          recorderPath: "telegram.jsonl",
          version: 1,
        },
      }),
    });
    const running = program.parseAsync(["node", "crabline", "--json", "serve", "telegram"]);
    await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBeGreaterThan(baseline));

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(baseline);

    finishClose?.();
    await running;
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
  });

  it("preserves watch and cleanup failures", async () => {
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
    const watchError = new Error("watch exploded");
    const cleanupError = new Error("cleanup exploded");
    const provider = {
      async cleanup() {
        throw cleanupError;
      },
      async *watch() {
        yield await Promise.reject(watchError);
      },
    };
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });

    const failure = await program
      .parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([watchError, cleanupError]);
    expect((failure as AggregateError).cause).toBe(watchError);
  });

  it("cleans up when watch setup throws synchronously", async () => {
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
    const setupError = new Error("watch setup exploded");
    const cleanup = vi.fn(async () => undefined);
    const provider = {
      cleanup,
      watch() {
        throw setupError;
      },
    };
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });

    await expect(
      program.parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"]),
    ).rejects.toBe(setupError);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves an undefined watch failure", async () => {
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
    const provider = {
      cleanup: vi.fn(async () => undefined),
      async *watch() {
        yield await Promise.reject(undefined);
      },
    };
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });

    let caught: { rejected: boolean; value: unknown } = { rejected: false, value: "not-thrown" };
    try {
      await program.parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"]);
    } catch (error) {
      caught = { rejected: true, value: error };
    }
    expect(caught).toEqual({ rejected: true, value: undefined });
    expect(provider.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cancels and cleans up watch commands on signals", async () => {
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
    const cleanup = vi.fn(async () => undefined);
    let watchSignal: AbortSignal | undefined;
    const provider = {
      cleanup,
      async *watch(context: { signal?: AbortSignal }) {
        watchSignal = context.signal;
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield* [];
      },
    };
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });
    const baseline = process.listenerCount("SIGTERM");
    const running = program.parseAsync([
      "node",
      "crabline",
      "--config",
      configPath,
      "watch",
      "watched",
    ]);
    await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBeGreaterThan(baseline));

    process.emit("SIGTERM", "SIGTERM");
    await running;

    expect(watchSignal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
  });

  it("bounds iterator return and provider cleanup during watch shutdown", async () => {
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
    const iterator = {
      next: vi.fn(async () => await new Promise<never>(() => undefined)),
      return: vi.fn(async () => await new Promise<never>(() => undefined)),
    };
    const cleanup = vi.fn(async () => await new Promise<never>(() => undefined));
    const provider = {
      cleanup,
      watch() {
        return {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        };
      },
    };
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });
    const baseline = process.listenerCount("SIGTERM");
    const running = program
      .parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"])
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(iterator.next).toHaveBeenCalledTimes(1);
      expect(process.listenerCount("SIGTERM")).toBeGreaterThan(baseline);
    });

    process.emit("SIGTERM", "SIGTERM");
    let hangTimer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => {
      hangTimer = setTimeout(() => resolve("hung"), 2_000);
    });
    const failure = await Promise.race([running, hung]);
    clearTimeout(hangTimer);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message:
          "Provider watch iterator return did not settle within 250ms during watch shutdown.",
      }),
      expect.objectContaining({
        message: "Provider cleanup did not settle within 250ms during watch shutdown.",
      }),
    ]);
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
  });

  it("waits for stdout backpressure while watching", async () => {
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
    const cleanup = vi.fn(async () => undefined);
    const provider = {
      cleanup,
      async *watch() {
        yield {
          author: "assistant",
          id: "message",
          provider: "local",
          sentAt: new Date().toISOString(),
          text: "payload",
          threadId: "thread",
        };
      },
    };
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      completeWrite = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      return false;
    }) as typeof process.stdout.write);
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });
    let settled = false;

    try {
      const running = program
        .parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"])
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      completeWrite?.(null);
      await Promise.resolve();
      expect(settled).toBe(false);
      process.stdout.emit("drain");
      await running;
    } finally {
      write.mockRestore();
    }

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("treats a closed watch stdout pipe as graceful shutdown", async () => {
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
    const cleanup = vi.fn(async () => undefined);
    const provider = {
      cleanup,
      async *watch() {
        yield {
          author: "assistant",
          id: "message",
          provider: "local",
          sentAt: new Date().toISOString(),
          text: "payload",
          threadId: "thread",
        };
      },
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation((() => {
      queueMicrotask(() => {
        process.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      });
      return false;
    }) as typeof process.stdout.write);
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });

    try {
      await expect(
        program.parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"]),
      ).resolves.toBe(program);
    } finally {
      write.mockRestore();
    }

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("sanitizes terminal controls in watch text output", async () => {
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
    const provider = {
      async *watch() {
        yield {
          author: "assistant",
          id: "message",
          provider: "local",
          sentAt: "now",
          text: "first\u001b[2J\nsecond",
          threadId: "thread",
        };
      },
    };
    const program = createProgram(() => undefined, {
      createRegistry: () =>
        ({
          resolve: () => provider,
        }) as never,
    });

    const captured = await captureWrites(async () => {
      await program.parseAsync(["node", "crabline", "--config", configPath, "watch", "watched"]);
    });

    expect(captured.stdout.join("")).toContain(String.raw`first\x1b[2J\nsecond`);
    expect(captured.stdout.join("")).not.toContain("\u001b");
  });

  it("preserves shutdown and ready-file cleanup failures", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const closeError = new Error("close exploded");
    const removeError = new Error("remove exploded");
    const program = createProgram(() => undefined, {
      acquireReadyFileLease: async () => async () => undefined,
      publishReadyFile: async () => ({
        birthtimeNs: 1n,
        ctimeNs: 1n,
        dev: 1n,
        ino: 1n,
        size: 1n,
      }),
      removeReadyFile: async () => {
        throw removeError;
      },
      startServer: async () => ({
        async close() {
          throw closeError;
        },
        manifest: {
          adminToken: "admin",
          baseUrl: "http://127.0.0.1:12345",
          botToken: ["424242", "test-token-placeholder"].join(":"),
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: {
            TELEGRAM_BOT_TOKEN: ["424242", "test-token-placeholder"].join(":"),
          },
          provider: "telegram",
          recorderPath: path.join(directory, "telegram.jsonl"),
          version: 1,
        },
      }),
    });

    const failure = await program
      .parseAsync([
        "node",
        "crabline",
        "--json",
        "serve",
        "telegram",
        "--once",
        "--ready-file",
        path.join(directory, "server.json"),
      ])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([removeError, closeError]);
    expect((failure as AggregateError).cause).toBe(removeError);
  });

  it("stops and cleans a serve command when stdout closes", async () => {
    const close = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const write = vi.spyOn(process.stdout, "write").mockImplementation((() => {
      throw Object.assign(new Error("closed stdout"), { code: "EPIPE" });
    }) as typeof process.stdout.write);
    const program = createProgram(() => undefined, {
      acquireReadyFileLease: async () => release,
      publishReadyFile: async () => ({
        birthtimeNs: 1n,
        ctimeNs: 1n,
        dev: 1n,
        ino: 1n,
        size: 1n,
      }),
      removeReadyFile: remove,
      startServer: async () => ({
        close,
        manifest: {
          adminToken: "admin",
          baseUrl: "http://127.0.0.1:12345",
          botToken: "sample",
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: { TELEGRAM_BOT_TOKEN: "sample" },
          provider: "telegram",
          recorderPath: "telegram.jsonl",
          version: 1,
        },
      }),
    });

    try {
      await expect(
        program.parseAsync([
          "node",
          "crabline",
          "--json",
          "serve",
          "telegram",
          "--ready-file",
          "server.json",
        ]),
      ).resolves.toBe(program);
    } finally {
      write.mockRestore();
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retains ready-file ownership when server close fails", async () => {
    const release = vi.fn(async () => undefined);
    const closeError = new Error("close exploded");
    const remove = vi.fn(async () => undefined);
    const program = createProgram(() => undefined, {
      acquireReadyFileLease: async () => release,
      publishReadyFile: async () => ({
        birthtimeNs: 1n,
        ctimeNs: 1n,
        dev: 1n,
        ino: 1n,
        size: 1n,
      }),
      removeReadyFile: remove,
      startServer: async () => ({
        async close() {
          throw closeError;
        },
        manifest: {
          adminToken: "admin",
          baseUrl: "http://127.0.0.1:12345",
          botToken: "sample",
          endpoints: {
            adminInboundUrl: "http://127.0.0.1:12345/crabline/telegram/inbound",
            apiRoot: "http://127.0.0.1:12345",
          },
          env: { TELEGRAM_BOT_TOKEN: "sample" },
          provider: "telegram",
          recorderPath: "telegram.jsonl",
          version: 1,
        },
      }),
    });

    await expect(
      program.parseAsync([
        "node",
        "crabline",
        "--json",
        "serve",
        "telegram",
        "--once",
        "--ready-file",
        "server.json",
      ]),
    ).rejects.toBe(closeError);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("redacts serve credentials from text output unless explicitly requested", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const captured = await captureWrites(async () => {
      vi.stubEnv("CRABLINE_ADMIN_TOKEN", "fake");
      vi.stubEnv("CRABLINE_BOT_TOKEN", "sample");
      expect(
        await runCli([
          "node",
          "crabline",
          "serve",
          "telegram",
          "--once",
          "--recorder",
          path.join(directory, "redacted.jsonl"),
        ]),
      ).toBe(0);
      vi.stubEnv("CRABLINE_ADMIN_TOKEN", "example");
      vi.stubEnv("CRABLINE_ACCESS_TOKEN", "placeholder");
      expect(
        await runCli([
          "node",
          "crabline",
          "serve",
          "whatsapp",
          "--once",
          "--recorder",
          path.join(directory, "whatsapp-redacted.jsonl"),
        ]),
      ).toBe(0);
      vi.stubEnv("CRABLINE_BOT_TOKEN", "placeholder");
      expect(
        await runCli([
          "node",
          "crabline",
          "serve",
          "telegram",
          "--once",
          "--show-secrets",
          "--recorder",
          path.join(directory, "visible.jsonl"),
        ]),
      ).toBe(0);
    });

    const stdout = captured.stdout.join("");
    expect(stdout).not.toContain("adminToken: fake");
    expect(stdout).not.toContain("botToken: sample");
    expect(stdout).toContain("adminToken: <redacted>");
    expect(stdout).toContain("botToken: <redacted>");
    expect(stdout).toContain("adminToken: example");
    expect(stdout).toContain("botToken: placeholder");
    expect(stdout).not.toContain("access_token=placeholder");
    expect(stdout).toContain("access_token=<redacted>");
  });

  it("prints a Telegram server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    vi.stubEnv("CRABLINE_ADMIN_TOKEN", "test-admin-token");
    const readyFile = path.join(directory, ".crabline", "telegram-server.json");
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, "stale\n", { mode: 0o644 });
    const captured = await captureWrites(async () => {
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
          "--recorder",
          path.join(directory, "telegram.jsonl"),
        ]),
      ).toBe(0);
    });

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
    await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.dirname(readyFile))).toEqual([]);
  });

  it("prints a Zalo server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    vi.stubEnv("CRABLINE_ADMIN_TOKEN", "test-admin-token");
    vi.stubEnv("CRABLINE_BOT_TOKEN", "test-token-placeholder");
    const readyFile = path.join(directory, ".crabline", "zalo-server.json");
    const captured = await captureWrites(async () => {
      expect(
        await runCli([
          "node",
          "crabline",
          "--json",
          "serve",
          "zalo",
          "--once",
          "--ready-file",
          readyFile,
          "--recorder",
          path.join(directory, "zalo.jsonl"),
        ]),
      ).toBe(0);
    });

    const manifest = JSON.parse(captured.stdout.join("")) as {
      adminToken?: string;
      botToken?: string;
      endpoints?: { adminInboundUrl?: string; apiRoot?: string };
      env?: { ZALO_API_URL?: string; ZALO_BOT_TOKEN?: string };
      provider?: string;
    };
    expect(manifest.provider).toBe("zalo");
    expect(manifest.adminToken).toBe("test-admin-token");
    expect(manifest.botToken).toBe("test-token-placeholder");
    expect(manifest.endpoints?.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(manifest.endpoints?.adminInboundUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/crabline\/zalo\/inbound$/u,
    );
    expect(manifest.env).toMatchObject({
      ZALO_API_URL: manifest.endpoints?.apiRoot,
      ZALO_BOT_TOKEN: "test-token-placeholder",
    });
    await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints a Slack server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    vi.stubEnv("CRABLINE_ADMIN_TOKEN", "test-admin-token");
    vi.stubEnv("CRABLINE_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("CRABLINE_SIGNING_SECRET", "test-signing-secret");
    const readyFile = path.join(directory, ".crabline", "slack-server.json");
    const captured = await captureWrites(async () => {
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
          "--recorder",
          path.join(directory, "slack.jsonl"),
        ]),
      ).toBe(0);
    });

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
    await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints a WhatsApp server runtime manifest", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    vi.stubEnv("CRABLINE_ADMIN_TOKEN", "test-whatsapp-admin-token");
    vi.stubEnv("CRABLINE_ACCESS_TOKEN", "test-whatsapp-access-token");
    const readyFile = path.join(directory, ".crabline", "whatsapp-server.json");
    const captured = await captureWrites(async () => {
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
          "--recorder",
          path.join(directory, "whatsapp.jsonl"),
        ]),
      ).toBe(0);
    });

    const manifest = JSON.parse(captured.stdout.join("")) as {
      accessToken?: string;
      adminToken?: string;
      endpoints?: {
        adminInboundUrl?: string;
        apiRoot?: string;
        baileysWebSocketUrl?: string;
        messagesUrl?: string;
      };
      env?: {
        CLOUD_API_ACCESS_TOKEN?: string;
        CLOUD_API_VERSION?: string;
        WA_PHONE_NUMBER_ID?: string;
      };
      provider?: string;
    };
    expect(manifest.provider).toBe("whatsapp");
    expect(manifest.accessToken).toBe("test-whatsapp-access-token");
    expect(manifest.adminToken).toBe("test-whatsapp-admin-token");
    expect(manifest.endpoints?.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v25\.0$/u);
    expect(manifest.endpoints?.adminInboundUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/_crabline\/admin\/whatsapp\/inbound$/u,
    );
    expect(manifest.endpoints?.messagesUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v25\.0\/100000000000000\/messages$/u,
    );
    expect(manifest.endpoints?.baileysWebSocketUrl).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/ws\/chat\?access_token=test-whatsapp-access-token$/u,
    );
    expect(manifest.env).toMatchObject({
      CLOUD_API_ACCESS_TOKEN: "test-whatsapp-access-token",
      CLOUD_API_VERSION: "v25.0",
      WA_PHONE_NUMBER_ID: "100000000000000",
    });
    await expect(fs.readFile(readyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

    const captured = createWriteCapture();
    let exitCode: number;
    try {
      exitCode = await captured.run(() =>
        runCli(["node", "crabline", "--config", configPath, "doctor"]),
      );
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

    const captured = createWriteCapture();
    let exitCode: number;
    try {
      exitCode = await captured.run(() =>
        runCli(["node", "crabline", "--config", configPath, "doctor"]),
      );
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

    let exitCode: number;

    const captured = await captureWrites(async () => {
      try {
        exitCode = await runCli(["node", "crabline", "--config", configPath, "doctor"]);
      } finally {
        for (const [name, value] of Object.entries(originals)) {
          if (value !== undefined) {
            process.env[name] = value;
          }
        }
      }
    });

    expect(exitCode!).toBe(0);
    expect(captured.stdout.join("")).toContain("doctor ok");
  });

  it("doctor accepts script providers with capability-scoped commands", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const configPath = path.join(directory, "crabline.yaml");
    await writeText(
      configPath,
      [
        "configVersion: 1",
        "providers:",
        "  probe-only:",
        "    adapter: script",
        "    platform: signal",
        "    capabilities: [probe]",
        "    script:",
        "      commands:",
        '        probe: "printf ok"',
        "  send-only:",
        "    adapter: script",
        "    platform: irc",
        "    capabilities: [send]",
        "    script:",
        "      commands:",
        '        send: "printf ok"',
        "fixtures: []",
      ].join("\n"),
    );
    const captured = await captureWrites(async () => {
      expect(await runCli(["node", "crabline", "--config", configPath, "doctor"])).toBe(0);
    });

    expect(captured.stdout.join("")).toContain("doctor ok");
  });
});
