import { Command, CommanderError, Option } from "commander";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { finished } from "node:stream/promises";
import { lock } from "proper-lockfile";
import { loadManifest } from "../config/load.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { createRegistry } from "../providers/registry.js";
import {
  formatJson,
  formatJsonResult,
  formatRunResultText,
  sanitizeTerminalText,
} from "../core/reporters.js";
import {
  assertScriptStdinPayloadSize,
  computeExitCode,
  runFixtureCommand,
  runSuite,
} from "../core/run.js";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import {
  isCrablineServerChannel,
  startCrablineServer,
  type CrablineServerChannel,
  type CrablineServerManifest,
  type StartCrablineServerParams,
  type StartedCrablineServer,
} from "../servers/index.js";

type GlobalOptions = {
  config?: string;
  json?: boolean;
};

type SetExitCode = (code: number) => void;

export type ReadyFileIdentity = {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  size: bigint;
};

type ProgramDependencies = {
  acquireReadyFileLease?: (filePath: string) => Promise<() => Promise<void>>;
  createRegistry?: typeof createRegistry;
  publishReadyFile?: (filePath: string, contents: string) => Promise<ReadyFileIdentity>;
  removeReadyFile?: (
    filePath: string,
    expectedContents: string,
    expectedIdentity: ReadyFileIdentity,
  ) => Promise<void>;
  startServer?: (params: StartCrablineServerParams) => Promise<StartedCrablineServer>;
};

type RunCliOptions = {
  dependencies?: ProgramDependencies;
  forceExit?: (code: number) => never;
};

type ServeSharedOptions = {
  host: string;
  port: number;
  recorderPath?: string | undefined;
};

type ServeCommandOptions = {
  account?: string | undefined;
  accessToken?: string | undefined;
  adminToken?: string | undefined;
  botToken?: string | undefined;
  botUsername?: string | undefined;
  credentialsFd?: string | undefined;
  host: string;
  once?: boolean | undefined;
  port: string;
  readyFile?: string | undefined;
  recorder?: string | undefined;
  selfJid?: string | undefined;
  showSecrets?: boolean | undefined;
  signingSecret?: string | undefined;
};

type ServeParamFactory = (
  shared: ServeSharedOptions,
  commandOptions: ServeCommandOptions,
) => StartCrablineServerParams;

const READY_FILE_LEASE_STALE_MS = 60_000;
const READY_FILE_LEASE_UPDATE_MS = 1_000;
const MAX_SERVE_CREDENTIALS_BYTES = 64 * 1024;
const WATCH_SHUTDOWN_GRACE_MS = 250;
const WATCH_SHUTDOWN_REACHED = Symbol("watch shutdown reached");

const SERVE_CREDENTIAL_ENV = [
  ["accessToken", "CRABLINE_ACCESS_TOKEN"],
  ["adminToken", "CRABLINE_ADMIN_TOKEN"],
  ["botToken", "CRABLINE_BOT_TOKEN"],
  ["signingSecret", "CRABLINE_SIGNING_SECRET"],
] as const;

type ServeCredentialName = (typeof SERVE_CREDENTIAL_ENV)[number][0];
type ServeCredentials = Partial<Record<ServeCredentialName, string>>;

const SERVE_PARAM_FACTORIES = {
  mattermost: (shared, commandOptions) => ({
    ...shared,
    adminToken: commandOptions.adminToken,
    botToken: commandOptions.botToken,
    botUsername: commandOptions.botUsername,
    channel: "mattermost",
  }),
  matrix: (shared, commandOptions) => ({
    ...shared,
    accessToken: commandOptions.accessToken,
    adminToken: commandOptions.adminToken,
    channel: "matrix",
  }),
  signal: (shared, commandOptions) => ({
    ...shared,
    account: commandOptions.account,
    adminToken: commandOptions.adminToken,
    channel: "signal",
  }),
  slack: (shared, commandOptions) => ({
    ...shared,
    adminToken: commandOptions.adminToken,
    botToken: commandOptions.botToken,
    channel: "slack",
    signingSecret: commandOptions.signingSecret,
  }),
  telegram: (shared, commandOptions) => ({
    ...shared,
    adminToken: commandOptions.adminToken,
    botToken: commandOptions.botToken,
    botUsername: commandOptions.botUsername,
    channel: "telegram",
  }),
  whatsapp: (shared, commandOptions) => ({
    ...shared,
    accessToken: commandOptions.accessToken,
    adminToken: commandOptions.adminToken,
    channel: "whatsapp",
    selfJid: commandOptions.selfJid,
  }),
  zalo: (shared, commandOptions) => ({
    ...shared,
    adminToken: commandOptions.adminToken,
    botToken: commandOptions.botToken,
    botName: commandOptions.botUsername,
    channel: "zalo",
  }),
} satisfies Record<CrablineServerChannel, ServeParamFactory>;

function isClosedPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

async function writeOutput(stream: NodeJS.WriteStream, value: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      let drained = false;
      let written = false;
      const cleanup = () => {
        stream.off("drain", onDrain);
        stream.off("error", onError);
      };
      const finish = () => {
        if (drained && written) {
          cleanup();
          resolve();
        }
      };
      const onDrain = () => {
        drained = true;
        finish();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      stream.once("error", onError);
      let hasCapacity: boolean;
      try {
        hasCapacity = stream.write(value, (error) => {
          if (error) {
            stream.once("error", () => undefined);
            onError(error);
            return;
          }
          written = true;
          finish();
        });
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (hasCapacity) {
        drained = true;
        finish();
      } else {
        stream.once("drain", onDrain);
      }
    });
    return true;
  } catch (error) {
    if (isClosedPipeError(error)) {
      return false;
    }
    throw error;
  }
}

async function print(value: string): Promise<boolean> {
  return await writeOutput(process.stdout, `${value}\n`);
}

class WatchShutdownDeadlineError extends CrablineError {}

function createWatchShutdownDeadline(): {
  race<T>(operation: PromiseLike<T>, operationName: string): Promise<T>;
  start(): void;
} {
  let deadlineAt: number | undefined;
  const controller = new AbortController();
  return {
    async race<T>(operation: PromiseLike<T>, operationName: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeStartListener: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        const arm = () => {
          timer = setTimeout(
            () => {
              reject(
                new WatchShutdownDeadlineError(
                  `Provider ${operationName} did not settle within ${WATCH_SHUTDOWN_GRACE_MS}ms during watch shutdown.`,
                  { kind: "timeout" },
                ),
              );
            },
            Math.max(0, deadlineAt! - Date.now()),
          );
        };
        if (controller.signal.aborted) {
          arm();
          return;
        }
        controller.signal.addEventListener("abort", arm, { once: true });
        removeStartListener = () => controller.signal.removeEventListener("abort", arm);
      });
      try {
        return await Promise.race([Promise.resolve(operation), deadline]);
      } finally {
        removeStartListener?.();
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    start() {
      if (deadlineAt !== undefined) {
        return;
      }
      deadlineAt = Date.now() + WATCH_SHUTDOWN_GRACE_MS;
      controller.abort();
    },
  };
}

function containsWatchShutdownDeadline(error: unknown, seen = new Set<object>()): boolean {
  if (error instanceof WatchShutdownDeadlineError) {
    return true;
  }
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => containsWatchShutdownDeadline(entry, seen));
  }
  return "cause" in error && containsWatchShutdownDeadline(error.cause, seen);
}

async function withManifest<T>(
  options: GlobalOptions,
  action: (context: Awaited<ReturnType<typeof loadManifest>>) => Promise<T>,
): Promise<T> {
  return action(await loadManifest(options.config));
}

function rejectedSecretOption(flags: string, optionName: string, envName: string): Option {
  return new Option(flags).hideHelp().argParser(() => {
    throw new CrablineError(
      `${optionName} no longer accepts credential values in command-line arguments. Use ${envName} or --credentials-fd.`,
      { kind: "config" },
    );
  });
}

function parseCredentialsFd(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new CrablineError(
      "Serve credentials file descriptor must be 0 or an integer greater than 2.",
      { kind: "config" },
    );
  }
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd === 1 || fd === 2 || fd > 2_147_483_647) {
    throw new CrablineError(
      "Serve credentials file descriptor must be 0 or an integer greater than 2.",
      { kind: "config" },
    );
  }
  return fd;
}

async function readBoundedFileDescriptor(fd: number): Promise<string> {
  const stream = createReadStream("", { autoClose: fd !== 0, fd });
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_SERVE_CREDENTIALS_BYTES) {
        throw new CrablineError(
          `Serve credentials JSON exceeds ${MAX_SERVE_CREDENTIALS_BYTES} bytes.`,
          { kind: "config" },
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    stream.destroy();
    if (error instanceof CrablineError) {
      throw error;
    }
    throw new CrablineError(`Unable to read serve credentials from file descriptor ${fd}.`, {
      cause: error,
      kind: "config",
    });
  } finally {
    if (fd !== 0 && !stream.closed) {
      stream.destroy();
      await finished(stream).catch(() => undefined);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseServeCredentialsJson(input: string): ServeCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new CrablineError("Serve credentials input must be valid JSON.", {
      cause: error,
      kind: "config",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CrablineError("Serve credentials JSON must be an object.", { kind: "config" });
  }

  const values: ServeCredentials = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!SERVE_CREDENTIAL_ENV.some(([name]) => name === key)) {
      throw new CrablineError("Serve credentials JSON contains unsupported fields.", {
        kind: "config",
      });
    }
    if (typeof value !== "string") {
      throw new CrablineError("Serve credentials JSON values must be strings.", {
        kind: "config",
      });
    }
    values[key as ServeCredentialName] = value;
  }
  return values;
}

async function resolveServeCredentials(credentialsFd?: string): Promise<ServeCredentials> {
  const overrides =
    credentialsFd === undefined
      ? {}
      : parseServeCredentialsJson(
          await readBoundedFileDescriptor(parseCredentialsFd(credentialsFd)),
        );
  return Object.fromEntries(
    SERVE_CREDENTIAL_ENV.flatMap(([name, envName]) => {
      const override = overrides[name];
      const value = override ?? process.env[envName];
      return value === undefined ? [] : [[name, value]];
    }),
  ) as ServeCredentials;
}

export function createProgram(
  setExitCode: SetExitCode = (code) => {
    process.exitCode = code;
  },
  dependencies: ProgramDependencies = {},
): Command {
  const program = new Command();
  const acquireReadyLease = dependencies.acquireReadyFileLease ?? acquireReadyFileLease;
  const registryFactory = dependencies.createRegistry ?? createRegistry;
  const publish = dependencies.publishReadyFile ?? publishReadyFileUnlocked;
  const removeReady = dependencies.removeReadyFile ?? removeReadyFileIfOwned;
  const startServer = dependencies.startServer ?? startCrablineServer;
  const formatCliJson = (value: unknown): string => {
    const formatted = formatJsonResult(value);
    if (!formatted.ok) {
      setExitCode(EXIT_CODES.FAILURE);
    }
    return formatted.output;
  };

  program
    .exitOverride()
    .name("crabline")
    .description("Deterministic CLI harness for messaging provider E2E tests")
    .option("-c, --config <path>", "Config file path")
    .option("--json", "Machine-readable output", false)
    .showHelpAfterError();

  program
    .command("providers")
    .description("List configured providers and provider catalog coverage")
    .action(async () => {
      const options = program.opts() as GlobalOptions;
      const { manifest, path } = await loadManifest(options.config);
      const registry = registryFactory(manifest, path);
      const payload = {
        configured: Object.entries(manifest.providers).map(([id, config]) => ({
          adapter: config.adapter,
          capabilities: config.capabilities,
          id,
          platform: config.platform,
          status: config.status,
        })),
        support: registry.catalog,
      };
      await print(options.json ? formatCliJson(payload) : renderProvidersText(payload));
    });

  program
    .command("fixtures")
    .description("List fixtures")
    .action(async () => {
      const options = program.opts() as GlobalOptions;
      const { manifest } = await loadManifest(options.config);
      await print(
        options.json
          ? formatCliJson(manifest.fixtures)
          : manifest.fixtures
              .map(
                (fixture) =>
                  `${sanitizeTerminalText(fixture.id, true)} ${sanitizeTerminalText(fixture.mode, true)} provider=${sanitizeTerminalText(fixture.provider, true)} target=${sanitizeTerminalText(fixture.target.id, true)}`,
              )
              .join("\n"),
      );
    });

  program
    .command("probe <fixtureId>")
    .description("Probe provider readiness using a fixture")
    .action(async (fixtureId) => {
      const options = program.opts() as GlobalOptions;
      const { manifest, path } = await loadManifest(options.config);
      const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
      if (!fixture) {
        throw new CrablineError(`Unknown fixture: ${fixtureId}`, { kind: "config" });
      }
      const registry = registryFactory(manifest, path);
      const result = await runFixtureCommand({
        fixtureId: fixture.id,
        manifest,
        manifestPath: path,
        modeOverride: "probe",
        registry,
      });
      setExitCode(computeExitCode(result));
      await print(options.json ? formatCliJson(result) : formatRunResultText(result));
    });

  for (const mode of ["send", "roundtrip", "agent"] as const) {
    program
      .command(`${mode} <fixtureId>`)
      .description(`${mode} a fixture`)
      .action(async (fixtureId) => {
        const options = program.opts() as GlobalOptions;
        const { manifest, path } = await loadManifest(options.config);
        const registry = registryFactory(manifest, path);
        const result = await runFixtureCommand({
          fixtureId,
          manifest,
          manifestPath: path,
          modeOverride: mode,
          registry,
        });
        setExitCode(computeExitCode(result));
        await print(options.json ? formatCliJson(result) : formatRunResultText(result));
      });
  }

  program
    .command("run <fixtureIds...>")
    .description("Run one or more fixtures as a suite")
    .action(async (fixtureIds) => {
      const options = program.opts() as GlobalOptions;
      const { manifest, path } = await loadManifest(options.config);
      const registry = registryFactory(manifest, path);
      const result = await runSuite({
        fixtureIds,
        manifest,
        manifestPath: path,
        registry,
      });
      setExitCode(computeExitCode(result));
      await print(options.json ? formatCliJson(result) : formatRunResultText(result));
    });

  program
    .command("watch <fixtureId>")
    .alias("webhook")
    .description("Watch inbound messages for one fixture using provider webhook/recorder mode")
    .action(async (fixtureId) => {
      const options = program.opts() as GlobalOptions;
      await withManifest(options, async ({ manifest, path }) => {
        const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
        if (!fixture) {
          throw new CrablineError(`Unknown fixture: ${fixtureId}`, { kind: "config" });
        }

        const provider = registryFactory(manifest, path).resolve(fixture.provider, fixture.id);
        if (!provider.watch) {
          throw new CrablineError(`Provider "${fixture.provider}" does not implement watch.`, {
            kind: "config",
          });
        }

        const controller = new AbortController();
        const shutdownDeadline = createWatchShutdownDeadline();
        let iterator:
          | AsyncIterator<NonNullable<Awaited<ReturnType<typeof provider.waitForInbound>>>>
          | undefined;
        const stopWatch = onceAsync(async () => {
          shutdownDeadline.start();
          controller.abort();
          const returnResult = iterator?.return?.();
          if (returnResult) {
            await shutdownDeadline.race(returnResult, "watch iterator return");
          }
        });
        const shutdown = installShutdownHandler(stopWatch);
        const shutdownSettled = shutdown.wait().then(() => WATCH_SHUTDOWN_REACHED);
        const lifecycleErrors: unknown[] = [];
        try {
          const watchContext = {
            config: manifest.providers[fixture.provider]!,
            fixture,
            manifestPath: path,
            providerId: fixture.provider,
            signal: controller.signal,
            userName: manifest.userName,
          };
          if (watchContext.config.adapter === "script") {
            assertScriptStdinPayloadSize({
              fixture,
              provider: {
                config: watchContext.config,
                id: fixture.provider,
                manifestPath: path,
              },
              watch: {
                target: fixture.target,
              },
            });
          }
          const watch = provider.watch(watchContext);
          iterator = watch[Symbol.asyncIterator]();
          while (true) {
            const result = await Promise.race([iterator.next(), shutdownSettled]);
            if (typeof result === "symbol") {
              break;
            }
            if (result.done) {
              break;
            }
            const message = result.value;
            const written = await shutdownDeadline.race(
              print(
                options.json
                  ? formatCliJson(message)
                  : `${sanitizeTerminalText(message.sentAt, true)} ${sanitizeTerminalText(message.author, true)} ${sanitizeTerminalText(message.text, true)}`,
              ),
              "watch output write",
            );
            if (!written) {
              break;
            }
          }
        } catch (error) {
          lifecycleErrors.push(error);
        }
        try {
          await stopWatch();
        } catch (error) {
          if (!lifecycleErrors.includes(error)) {
            lifecycleErrors.push(error);
          }
        }
        try {
          const cleanup = provider.cleanup?.();
          if (cleanup) {
            await shutdownDeadline.race(cleanup, "cleanup");
          }
        } catch (error) {
          if (!lifecycleErrors.includes(error)) {
            lifecycleErrors.push(error);
          }
        } finally {
          shutdown.dispose();
        }
        if (lifecycleErrors.length > 0) {
          throw combineLifecycleErrors(lifecycleErrors, "Crabline watch lifecycle failed.");
        }
      });
    });

  program
    .command("serve <provider>")
    .description("Start a local provider server that OpenClaw live adapters can target")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "0")
    .option("--account <number>", "Signal account number")
    .option(
      "--bot-username <username>",
      "Mattermost, Telegram, or Zalo bot username",
      "crabline_bot",
    )
    .option(
      "--credentials-fd <fd>",
      "Read JSON credentials from fd 0 or an inherited fd; values override CRABLINE_* env",
    )
    .option("--recorder <path>", "JSONL recorder path")
    .option("--ready-file <path>", "Write the server runtime manifest to this path")
    .option("--self-jid <jid>", "WhatsApp self JID")
    .option("--show-secrets", "Print provider credentials in text output", false)
    .option("--once", "Start, print the runtime manifest, and stop immediately", false)
    .addOption(
      rejectedSecretOption("--access-token <token>", "--access-token", "CRABLINE_ACCESS_TOKEN"),
    )
    .addOption(
      rejectedSecretOption("--admin-token <token>", "--admin-token", "CRABLINE_ADMIN_TOKEN"),
    )
    .addOption(rejectedSecretOption("--bot-token <token>", "--bot-token", "CRABLINE_BOT_TOKEN"))
    .addOption(
      rejectedSecretOption(
        "--signing-secret <secret>",
        "--signing-secret",
        "CRABLINE_SIGNING_SECRET",
      ),
    )
    .addHelpText(
      "after",
      [
        "",
        "Credential JSON fields: accessToken, adminToken, botToken, signingSecret",
        "Environment fallbacks: CRABLINE_ACCESS_TOKEN, CRABLINE_ADMIN_TOKEN,",
        "  CRABLINE_BOT_TOKEN, CRABLINE_SIGNING_SECRET",
      ].join("\n"),
    )
    .action(async (provider, commandOptions: ServeCommandOptions) => {
      const options = program.opts() as GlobalOptions;
      if (!isCrablineServerChannel(provider)) {
        throw new CrablineError(`Unsupported server channel: ${provider}`, {
          kind: "config",
        });
      }
      const credentials = await resolveServeCredentials(commandOptions.credentialsFd);
      commandOptions.accessToken = credentials.accessToken;
      commandOptions.adminToken = credentials.adminToken;
      commandOptions.botToken = credentials.botToken;
      commandOptions.signingSecret = credentials.signingSecret;
      if (!/^[0-9]+$/u.test(commandOptions.port)) {
        throw new CrablineError(`Invalid local server port: ${commandOptions.port}`, {
          kind: "config",
        });
      }
      const port = Number(commandOptions.port);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new CrablineError(`Invalid local server port: ${commandOptions.port}`, {
          kind: "config",
        });
      }
      const factory = SERVE_PARAM_FACTORIES[provider];
      if (!factory) {
        throw new CrablineError(`Unsupported server channel: ${provider}`, {
          kind: "config",
        });
      }
      let server: StartedCrablineServer | undefined;
      let startupSettled = false;
      let settleStartup: (() => void) | undefined;
      const startup = new Promise<void>((resolve) => {
        settleStartup = resolve;
      });
      const finishStartup = () => {
        if (!startupSettled) {
          startupSettled = true;
          settleStartup?.();
        }
      };
      let publicationSettled = false;
      let settlePublication: (() => void) | undefined;
      const publication = new Promise<void>((resolve) => {
        settlePublication = resolve;
      });
      const finishPublication = () => {
        if (!publicationSettled) {
          publicationSettled = true;
          settlePublication?.();
        }
      };
      let releaseReadyLease: (() => Promise<void>) | undefined;
      let publishedReady: { contents: string; identity: ReadyFileIdentity } | undefined;
      const close = onceAsync(async () => {
        await startup;
        await publication;
        const lifecycleErrors: unknown[] = [];
        if (commandOptions.readyFile && publishedReady) {
          try {
            await removeReady(
              commandOptions.readyFile,
              publishedReady.contents,
              publishedReady.identity,
            );
          } catch (error) {
            lifecycleErrors.push(error);
          }
        }
        let serverClosed = false;
        try {
          await server?.close();
          serverClosed = true;
        } catch (error) {
          lifecycleErrors.push(error);
        }
        if (serverClosed && releaseReadyLease) {
          try {
            await releaseReadyLease();
          } catch (error) {
            lifecycleErrors.push(error);
          }
        }
        if (lifecycleErrors.length > 0) {
          throw combineLifecycleErrors(lifecycleErrors, "Crabline server shutdown failed.");
        }
      });
      const shutdown = installShutdownHandler(close);
      let actionFailed = false;
      let actionError: unknown;
      try {
        if (commandOptions.readyFile) {
          releaseReadyLease = await acquireReadyLease(commandOptions.readyFile);
        }
        if (shutdown.requested()) {
          finishStartup();
          finishPublication();
          await shutdown.wait();
        } else {
          try {
            server = await startServer(
              factory(
                {
                  host: commandOptions.host,
                  port,
                  recorderPath: commandOptions.recorder,
                },
                commandOptions,
              ),
            );
          } finally {
            finishStartup();
          }
          if (shutdown.requested()) {
            finishPublication();
            await shutdown.wait();
          } else {
            let outputWritten = true;
            try {
              const formatted = formatJsonResult(server.manifest);
              if (!formatted.ok) {
                throw new Error("Unable to serialize server manifest.");
              }
              const payload = formatted.output;
              if (commandOptions.readyFile) {
                const readyContents = `${payload}\n`;
                publishedReady = {
                  contents: readyContents,
                  identity: await publish(commandOptions.readyFile, readyContents),
                };
              }
              if (shutdown.requested()) {
                outputWritten = false;
                finishPublication();
                await shutdown.wait();
              } else {
                outputWritten = await print(
                  options.json
                    ? payload
                    : renderServeText(server.manifest, commandOptions.showSecrets === true),
                );
                if (!outputWritten) {
                  finishPublication();
                  await close();
                }
              }
            } finally {
              finishPublication();
            }
            if (outputWritten && (shutdown.requested() || !commandOptions.once)) {
              await shutdown.wait();
            }
          }
        }
      } catch (error) {
        actionFailed = true;
        actionError = error;
      }
      finishStartup();
      finishPublication();
      const cleanupErrors: unknown[] = [];
      try {
        await close();
      } catch (error) {
        if (!actionFailed || error !== actionError) {
          cleanupErrors.push(error);
        }
      }
      shutdown.dispose();
      if (actionFailed || cleanupErrors.length > 0) {
        throw combineLifecycleErrors(
          actionFailed ? [actionError, ...cleanupErrors] : cleanupErrors,
          "Crabline server lifecycle failed.",
        );
      }
    });

  program
    .command("doctor")
    .description("Diagnose common setup problems")
    .action(async () => {
      const options = program.opts() as GlobalOptions;
      const { manifest } = await loadManifest(options.config);
      const findings = diagnose(manifest);
      const ok = findings.length === 0;
      const payload = { findings, ok };
      setExitCode(ok ? 0 : 10);
      await print(options.json ? formatCliJson(payload) : ok ? "doctor ok" : findings.join("\n"));
    });

  return program;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

type SignalTarget = {
  on(event: ShutdownSignal, listener: () => void): unknown;
  removeListener(event: ShutdownSignal, listener: () => void): unknown;
};

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => (result ??= Promise.resolve().then(action));
}

async function readReadyFileIdentity(filePath: string): Promise<ReadyFileIdentity> {
  const stats = await fs.stat(filePath, { bigint: true });
  return {
    birthtimeNs: stats.birthtimeNs,
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
  };
}

function sameReadyFileIdentity(left: ReadyFileIdentity, right: ReadyFileIdentity): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

function sameReadyFileObject(left: ReadyFileIdentity, right: ReadyFileIdentity): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

async function withReadyFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireReadyFileLease(filePath);
  let actionFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (actionFailed) {
      throw combineLifecycleErrors(
        [actionError, releaseError],
        `Ready-file action and lock release both failed for "${filePath}".`,
      );
    }
    throw releaseError;
  }
  if (actionFailed) {
    throw actionError;
  }
  return result as T;
}

async function acquireReadyFileLease(filePath: string): Promise<() => Promise<void>> {
  await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
  return await lock(filePath, {
    realpath: false,
    retries: {
      factor: 1,
      maxTimeout: 10,
      minTimeout: 10,
      retries: 100,
    },
    stale: READY_FILE_LEASE_STALE_MS,
    update: READY_FILE_LEASE_UPDATE_MS,
  });
}

export async function publishReadyFile(
  filePath: string,
  contents: string,
): Promise<ReadyFileIdentity> {
  let publishedIdentity: ReadyFileIdentity | undefined;
  try {
    return await withReadyFileLock(filePath, async () => {
      publishedIdentity = await publishReadyFileUnlocked(filePath, contents);
      return publishedIdentity;
    });
  } catch (error) {
    if (publishedIdentity) {
      try {
        await removeReadyFileIfOwned(filePath, contents, publishedIdentity);
      } catch (cleanupError) {
        const aggregateError = new AggregateError(
          [error, cleanupError],
          `Ready-file publication and compensation both failed for "${filePath}".`,
        );
        aggregateError.cause = error;
        throw aggregateError;
      }
    }
    throw error;
  }
}

async function publishReadyFileUnlocked(
  filePath: string,
  contents: string,
): Promise<ReadyFileIdentity> {
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = nodePath.join(
    nodePath.dirname(filePath),
    `.${nodePath.basename(filePath)}.${suffix}`,
  );
  const backupPath = `${temporaryPath}.backup`;
  let manifestPublished = false;
  let destinationBackedUp = false;
  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    destinationBackedUp = await backupReadyFile(filePath, backupPath);
    await fs.rename(temporaryPath, filePath);
    manifestPublished = true;
    const identity = await readReadyFileIdentity(filePath);
    if (destinationBackedUp) {
      await fs.rm(backupPath);
      destinationBackedUp = false;
    }
    return identity;
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    if (manifestPublished && !destinationBackedUp) {
      await fs.rm(filePath, { force: true }).catch((cleanupError: unknown) => {
        recoveryErrors.push(cleanupError);
      });
    }
    if (destinationBackedUp) {
      await fs.rename(backupPath, filePath).catch((restoreError: unknown) => {
        recoveryErrors.push(restoreError);
      });
    }
    if (recoveryErrors.length > 0) {
      const aggregateError = new AggregateError(
        [error, ...recoveryErrors],
        `Ready-file replacement and recovery both failed for "${filePath}".`,
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function backupReadyFile(filePath: string, backupPath: string): Promise<boolean> {
  try {
    await fs.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeReadyFileIfOwned(
  filePath: string,
  expectedContents: string,
  expectedIdentity: ReadyFileIdentity,
): Promise<void> {
  const tombstonePath = nodePath.join(
    nodePath.dirname(filePath),
    `.${nodePath.basename(filePath)}.${process.pid}.${randomUUID()}.remove`,
  );
  try {
    if (
      (await fs.readFile(filePath, "utf8")) !== expectedContents ||
      !sameReadyFileIdentity(await readReadyFileIdentity(filePath), expectedIdentity)
    ) {
      return;
    }
    await fs.rename(filePath, tombstonePath);
    if (
      (await fs.readFile(tombstonePath, "utf8")) === expectedContents &&
      sameReadyFileObject(await readReadyFileIdentity(tombstonePath), expectedIdentity)
    ) {
      await fs.rm(tombstonePath);
      return;
    }
    try {
      await fs.link(tombstonePath, filePath);
      await fs.rm(tombstonePath);
    } catch (restoreError) {
      throw new Error(
        `Ready-file path changed while removing "${filePath}"; the moved file remains at "${tombstonePath}".`,
        { cause: restoreError },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function removeReadyFile(
  filePath: string,
  expectedContents: string,
  expectedIdentity: ReadyFileIdentity,
): Promise<void> {
  await withReadyFileLock(filePath, async () => {
    await removeReadyFileIfOwned(filePath, expectedContents, expectedIdentity);
  });
}

export function waitForShutdown(
  close: () => Promise<void>,
  signalTarget: SignalTarget = process,
): Promise<void> {
  return installShutdownHandler(close, signalTarget).wait();
}

function installShutdownHandler(
  close: () => Promise<void>,
  signalTarget: SignalTarget = process,
): {
  dispose(): void;
  requested(): boolean;
  wait(): Promise<void>;
} {
  let shutdownPromise: Promise<void> | undefined;
  let resolveWait: (() => void) | undefined;
  let rejectWait: ((error: unknown) => void) | undefined;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  void wait.catch(() => undefined);
  const removeListeners = () => {
    signalTarget.removeListener("SIGINT", shutdown);
    signalTarget.removeListener("SIGTERM", shutdown);
  };
  const shutdown = () => {
    if (shutdownPromise) {
      return;
    }
    shutdownPromise = Promise.resolve().then(close);
    void shutdownPromise.then(
      () => {
        removeListeners();
        resolveWait?.();
      },
      (error: unknown) => {
        removeListeners();
        rejectWait?.(error);
      },
    );
  };
  signalTarget.on("SIGINT", shutdown);
  signalTarget.on("SIGTERM", shutdown);
  return {
    dispose: removeListeners,
    requested: () => shutdownPromise !== undefined,
    wait: () => wait,
  };
}

function combineLifecycleErrors(errors: unknown[], message: string): unknown {
  if (errors.length === 1) {
    return errors[0];
  }
  const aggregateError = new AggregateError(errors, message);
  aggregateError.cause = errors[0];
  return aggregateError;
}

function renderServeText(manifest: CrablineServerManifest, showSecrets: boolean) {
  const lines = [
    `${manifest.provider} local server ready`,
    `  apiRoot: ${manifest.provider === "matrix" ? manifest.endpoints.clientApiRoot : manifest.endpoints.apiRoot}`,
    `  inbound: ${manifest.endpoints.adminInboundUrl}`,
    `  recorder: ${manifest.recorderPath}`,
  ];
  const providerFields = renderServeProviderFields(manifest, showSecrets);
  if (!providerFields) {
    throw new CrablineError(`Unsupported server manifest provider: ${String(manifest.provider)}`, {
      kind: "config",
    });
  }
  lines.splice(2, 0, ...providerFields);
  return lines.join("\n");
}

function renderServeProviderFields(
  manifest: CrablineServerManifest,
  showSecrets: boolean,
): string[] | undefined {
  const secret = (value: string) => (showSecrets ? value : "<redacted>");
  if (manifest.provider === "mattermost") {
    return [
      `  adminToken: ${secret(manifest.adminToken)}`,
      `  botToken: ${secret(manifest.botToken)}`,
      `  websocket: ${manifest.endpoints.websocketUrl}`,
    ];
  }
  if (manifest.provider === "matrix") {
    return [
      `  adminToken: ${secret(manifest.adminToken)}`,
      `  accessToken: ${secret(manifest.accessToken)}`,
      `  botUserId: ${manifest.botUserId}`,
      `  sync: ${manifest.endpoints.syncUrl}`,
    ];
  }
  if (manifest.provider === "signal") {
    return [`  adminToken: ${secret(manifest.adminToken)}`, `  account: ${manifest.account}`];
  }
  if (manifest.provider === "slack") {
    return [
      `  adminToken: ${secret(manifest.adminToken)}`,
      `  botToken: ${secret(manifest.botToken)}`,
      `  signingSecret: ${secret(manifest.signingSecret)}`,
    ];
  }
  if (manifest.provider === "telegram") {
    return [
      `  adminToken: ${secret(manifest.adminToken)}`,
      `  botToken: ${secret(manifest.botToken)}`,
    ];
  }
  if (manifest.provider === "whatsapp") {
    const baileysWebSocketUrl = showSecrets
      ? manifest.endpoints.baileysWebSocketUrl
      : `${manifest.endpoints.baileysWebSocketUrl.split("?")[0]}?access_token=<redacted>`;
    return [
      `  adminToken: ${secret(manifest.adminToken)}`,
      `  accessToken: ${secret(manifest.accessToken)}`,
      `  baileysWebSocket: ${baileysWebSocketUrl}`,
      `  messages: ${manifest.endpoints.messagesUrl}`,
      `  phoneNumber: ${manifest.endpoints.phoneNumberUrl}`,
      `  status: ${manifest.endpoints.statusUrl}`,
      `  selfJid: ${manifest.selfJid}`,
    ];
  }
  if (manifest.provider === "zalo") {
    return [
      `  adminToken: ${secret(manifest.adminToken)}`,
      `  botToken: ${secret(manifest.botToken)}`,
      `  botId: ${manifest.botId}`,
    ];
  }
  return undefined;
}

function renderProvidersText(payload: {
  configured: Array<{
    adapter: string;
    capabilities: string[];
    id: string;
    platform: string;
    status: string;
  }>;
  support: ReadonlyArray<{
    notes: string;
    platform: string;
    status: string;
    supports: readonly string[];
  }>;
}): string {
  const lines = ["configured providers:"];
  if (payload.configured.length === 0) {
    lines.push("  none");
  } else {
    for (const provider of payload.configured) {
      lines.push(
        `  ${provider.id} platform=${provider.platform} adapter=${provider.adapter} status=${provider.status} supports=${provider.capabilities.join(",")}`,
      );
    }
  }

  lines.push("support catalog:");
  for (const entry of payload.support) {
    lines.push(
      `  ${entry.platform} status=${entry.status} supports=${entry.supports.join(",")} ${entry.notes}`,
    );
  }

  return lines.join("\n");
}

function diagnose(manifest: Awaited<ReturnType<typeof loadManifest>>["manifest"]): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();

  for (const fixture of manifest.fixtures) {
    if (seen.has(fixture.id)) {
      findings.push(`duplicate fixture id: ${fixture.id}`);
    }
    seen.add(fixture.id);

    if (!manifest.providers[fixture.provider]) {
      findings.push(`fixture ${fixture.id} references unknown provider ${fixture.provider}`);
    }

    for (const envName of fixture.env) {
      if (!process.env[envName]) {
        findings.push(`fixture ${fixture.id} missing env ${envName}`);
      }
    }
  }

  for (const [providerId, provider] of Object.entries(manifest.providers)) {
    for (const envName of provider.env) {
      if (!process.env[envName]) {
        findings.push(`provider ${providerId} missing env ${envName}`);
      }
    }

    if (provider.adapter === "script" && provider.status === "active") {
      const commands = provider.script?.commands;
      if (provider.capabilities.includes("probe") && !commands?.probe) {
        findings.push(`provider ${providerId} missing script.commands.probe`);
      }
      if (
        provider.capabilities.some((capability) =>
          ["agent", "roundtrip", "send"].includes(capability),
        ) &&
        !commands?.send
      ) {
        findings.push(`provider ${providerId} missing script.commands.send`);
      }
      if (
        provider.capabilities.some((capability) => ["agent", "roundtrip"].includes(capability)) &&
        !commands?.waitForInbound
      ) {
        findings.push(`provider ${providerId} missing script.commands.waitForInbound`);
      }
    }
  }

  return findings;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  let exitCode = 0;
  const program = createProgram((code) => {
    exitCode = code;
  }, options.dependencies);
  const parserErrors: string[] = [];
  const parserOutput: string[] = [];
  const bufferParserErrors = (command: Command): void => {
    command.configureOutput({
      writeErr: (message) => parserErrors.push(message),
      writeOut: (message) => parserOutput.push(message),
    });
    for (const child of command.commands) {
      bufferParserErrors(child);
    }
  };
  bufferParserErrors(program);
  try {
    await program.parseAsync(argv);
    await writeOutput(process.stdout, parserOutput.join(""));
    return exitCode;
  } catch (error) {
    const errorExitCode =
      error instanceof CommanderError
        ? error.code === "commander.help" && error.exitCode !== 0
          ? 1
          : error.exitCode
        : error instanceof CrablineError
          ? error.exitCode
          : 1;
    if (error instanceof CommanderError && errorExitCode === 0) {
      await writeOutput(process.stdout, parserOutput.join(""));
      return 0;
    }
    const json = program.opts().json === true;
    if (json) {
      await writeOutput(
        process.stderr,
        `${formatJson({
          error: {
            ...(error instanceof CommanderError ? { code: error.code } : {}),
            exitCode: errorExitCode,
            ...(error instanceof CrablineError && error.kind ? { kind: error.kind } : {}),
            message:
              error instanceof CommanderError && error.code === "commander.help"
                ? "No command specified."
                : ensureErrorMessage(error),
          },
          ok: false,
        })}\n`,
      );
    } else if (error instanceof CommanderError) {
      await writeOutput(process.stderr, parserErrors.join(""));
    } else {
      await writeOutput(process.stderr, `${ensureErrorMessage(error)}\n`);
    }
    if (options.forceExit && containsWatchShutdownDeadline(error)) {
      options.forceExit(errorExitCode);
    }
    return errorExitCode;
  }
}
