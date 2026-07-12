import { Command, CommanderError } from "commander";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { lock } from "proper-lockfile";
import { loadManifest } from "../config/load.js";
import { createRegistry } from "../providers/registry.js";
import { formatJson, formatRunResultText } from "../core/reporters.js";
import { computeExitCode, runFixtureCommand, runSuite } from "../core/run.js";
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
  publishReadyFile?: (filePath: string, contents: string) => Promise<ReadyFileIdentity>;
  removeReadyFile?: (
    filePath: string,
    expectedContents: string,
    expectedIdentity: ReadyFileIdentity,
  ) => Promise<void>;
  startServer?: (params: StartCrablineServerParams) => Promise<StartedCrablineServer>;
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

function print(value: string): void {
  process.stdout.write(`${value}\n`);
}

async function withManifest<T>(
  options: GlobalOptions,
  action: (context: Awaited<ReturnType<typeof loadManifest>>) => Promise<T>,
): Promise<T> {
  return action(await loadManifest(options.config));
}

export function createProgram(
  setExitCode: SetExitCode = (code) => {
    process.exitCode = code;
  },
  dependencies: ProgramDependencies = {},
): Command {
  const program = new Command();
  const acquireReadyLease = dependencies.acquireReadyFileLease ?? acquireReadyFileLease;
  const publish = dependencies.publishReadyFile ?? publishReadyFileUnlocked;
  const removeReady = dependencies.removeReadyFile ?? removeReadyFileIfOwned;
  const startServer = dependencies.startServer ?? startCrablineServer;

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
      const registry = createRegistry(manifest, path);
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
      print(options.json ? formatJson(payload) : renderProvidersText(payload));
    });

  program
    .command("fixtures")
    .description("List fixtures")
    .action(async () => {
      const options = program.opts() as GlobalOptions;
      const { manifest } = await loadManifest(options.config);
      print(
        options.json
          ? formatJson(manifest.fixtures)
          : manifest.fixtures
              .map(
                (fixture) =>
                  `${fixture.id} ${fixture.mode} provider=${fixture.provider} target=${fixture.target.id}`,
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
      const registry = createRegistry(manifest, path);
      const result = await runFixtureCommand({
        fixtureId: fixture.id,
        manifest,
        manifestPath: path,
        modeOverride: "probe",
        registry,
      });
      print(options.json ? formatJson(result) : formatRunResultText(result));
      setExitCode(computeExitCode(result));
    });

  for (const mode of ["send", "roundtrip", "agent"] as const) {
    program
      .command(`${mode} <fixtureId>`)
      .description(`${mode} a fixture`)
      .action(async (fixtureId) => {
        const options = program.opts() as GlobalOptions;
        const { manifest, path } = await loadManifest(options.config);
        const registry = createRegistry(manifest, path);
        const result = await runFixtureCommand({
          fixtureId,
          manifest,
          manifestPath: path,
          modeOverride: mode,
          registry,
        });
        print(options.json ? formatJson(result) : formatRunResultText(result));
        setExitCode(computeExitCode(result));
      });
  }

  program
    .command("run <fixtureIds...>")
    .description("Run one or more fixtures as a suite")
    .action(async (fixtureIds) => {
      const options = program.opts() as GlobalOptions;
      const { manifest, path } = await loadManifest(options.config);
      const registry = createRegistry(manifest, path);
      const result = await runSuite({
        fixtureIds,
        manifest,
        manifestPath: path,
        registry,
      });
      print(options.json ? formatJson(result) : formatRunResultText(result));
      setExitCode(computeExitCode(result));
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

        const provider = createRegistry(manifest, path).resolve(fixture.provider, fixture.id);
        if (!provider.watch) {
          throw new CrablineError(`Provider "${fixture.provider}" does not implement watch.`, {
            kind: "config",
          });
        }

        try {
          for await (const message of provider.watch({
            config: manifest.providers[fixture.provider]!,
            fixture,
            manifestPath: path,
            providerId: fixture.provider,
            userName: manifest.userName,
          })) {
            print(
              options.json
                ? formatJson(message)
                : `${message.sentAt} ${message.author} ${message.text}`,
            );
          }
        } finally {
          await provider.cleanup?.();
        }
      });
    });

  program
    .command("serve <provider>")
    .description("Start a local provider server that OpenClaw live adapters can target")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "0")
    .option("--admin-token <token>", "Admin token for inbound test messages")
    .option("--account <number>", "Signal account number")
    .option("--access-token <token>", "Matrix or WhatsApp access token")
    .option("--bot-token <token>", "Mattermost, Slack, Telegram, or Zalo bot token")
    .option(
      "--bot-username <username>",
      "Mattermost, Telegram, or Zalo bot username",
      "crabline_bot",
    )
    .option("--recorder <path>", "JSONL recorder path")
    .option("--ready-file <path>", "Write the server runtime manifest to this path")
    .option("--self-jid <jid>", "WhatsApp self JID")
    .option("--show-secrets", "Print provider credentials in text output", false)
    .option("--signing-secret <secret>", "Slack signing secret")
    .option("--once", "Start, print the runtime manifest, and stop immediately", false)
    .action(async (provider, commandOptions: ServeCommandOptions) => {
      const options = program.opts() as GlobalOptions;
      if (!isCrablineServerChannel(provider)) {
        throw new CrablineError(`Unsupported server channel: ${provider}`, {
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
      const close = onceAsync(async () => {
        await startup;
        await publication;
        await server?.close();
      });
      const shutdown = installShutdownHandler(close);
      let releaseReadyLease: (() => Promise<void>) | undefined;
      let publishedReady: { contents: string; identity: ReadyFileIdentity } | undefined;
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
            try {
              const payload = formatJson(server.manifest);
              if (commandOptions.readyFile) {
                const readyContents = `${payload}\n`;
                publishedReady = {
                  contents: readyContents,
                  identity: await publish(commandOptions.readyFile, readyContents),
                };
              }
              print(
                options.json
                  ? payload
                  : renderServeText(server.manifest, commandOptions.showSecrets === true),
              );
            } finally {
              finishPublication();
            }
            if (shutdown.requested() || !commandOptions.once) {
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
      shutdown.dispose();
      const cleanupErrors: unknown[] = [];
      const readyToRemove = publishedReady;
      for (const cleanup of [
        close,
        ...(commandOptions.readyFile && readyToRemove
          ? [
              () =>
                removeReady(
                  commandOptions.readyFile!,
                  readyToRemove.contents,
                  readyToRemove.identity,
                ),
            ]
          : []),
        ...(releaseReadyLease ? [releaseReadyLease] : []),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          if (!actionFailed || error !== actionError) {
            cleanupErrors.push(error);
          }
        }
      }
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
      print(options.json ? formatJson(payload) : ok ? "doctor ok" : findings.join("\n"));
      setExitCode(ok ? 0 : 10);
    });

  return program;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

type SignalTarget = {
  once(event: ShutdownSignal, listener: () => void): unknown;
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
  let manifestPublished = false;
  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
    manifestPublished = true;
    return await readReadyFileIdentity(filePath);
  } catch (error) {
    if (manifestPublished) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeReadyFileIfOwned(
  filePath: string,
  expectedContents: string,
  expectedIdentity: ReadyFileIdentity,
): Promise<void> {
  try {
    if (
      (await fs.readFile(filePath, "utf8")) !== expectedContents ||
      !sameReadyFileIdentity(await readReadyFileIdentity(filePath), expectedIdentity)
    ) {
      return;
    }
    await fs.rm(filePath);
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
  let shuttingDown = false;
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
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    removeListeners();
    void Promise.resolve().then(close).then(resolveWait, rejectWait);
  };
  signalTarget.once("SIGINT", shutdown);
  signalTarget.once("SIGTERM", shutdown);
  return {
    dispose: removeListeners,
    requested: () => shuttingDown,
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

export async function runCli(argv: string[]): Promise<number> {
  let exitCode = 0;
  const program = createProgram((code) => {
    exitCode = code;
  });
  const parserErrors: string[] = [];
  const bufferParserErrors = (command: Command): void => {
    command.configureOutput({ writeErr: (message) => parserErrors.push(message) });
    for (const child of command.commands) {
      bufferParserErrors(child);
    }
  };
  bufferParserErrors(program);
  try {
    await program.parseAsync(argv);
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
      return 0;
    }
    const json = program.opts().json === true;
    if (json) {
      process.stderr.write(
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
      process.stderr.write(parserErrors.join(""));
    } else {
      process.stderr.write(`${ensureErrorMessage(error)}\n`);
    }
    return errorExitCode;
  }
}
