import { Command } from "commander";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { loadManifest } from "../config/load.js";
import { createRegistry } from "../providers/registry.js";
import { formatJson, formatRunResultText } from "../core/reporters.js";
import { computeExitCode, runFixtureCommand, runSuite } from "../core/run.js";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import {
  isCrablineFakeProviderChannel,
  startCrablineFakeProviderServer,
  type CrablineFakeProviderChannel,
  type CrablineFakeProviderManifest,
  type StartCrablineFakeProviderServerParams,
} from "../servers/index.js";

type GlobalOptions = {
  config?: string;
  json?: boolean;
};

type SetExitCode = (code: number) => void;

type ServeSharedOptions = {
  host: string;
  port: number;
  recorderPath?: string | undefined;
};

type ServeCommandOptions = {
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
  signingSecret?: string | undefined;
};

type ServeParamFactory = (
  shared: ServeSharedOptions,
  commandOptions: ServeCommandOptions,
) => StartCrablineFakeProviderServerParams;

const SERVE_PARAM_FACTORIES = {
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
} satisfies Record<CrablineFakeProviderChannel, ServeParamFactory>;

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
): Command {
  const program = new Command();

  program
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
    .command("probe <fixtureOrProvider>")
    .description("Probe provider readiness using a fixture or provider id")
    .action(async (fixtureOrProvider) => {
      const options = program.opts() as GlobalOptions;
      const { manifest, path } = await loadManifest(options.config);
      const fixture =
        manifest.fixtures.find((entry) => entry.id === fixtureOrProvider) ??
        manifest.fixtures.find((entry) => entry.provider === fixtureOrProvider);
      if (!fixture) {
        throw new CrablineError(`No fixture found for "${fixtureOrProvider}"`, { kind: "config" });
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
    .description("Start a fake provider server that OpenClaw live adapters can target")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "0")
    .option("--admin-token <token>", "Admin token for inbound test messages")
    .option("--access-token <token>", "Fake WhatsApp access token")
    .option("--bot-token <token>", "Fake Telegram or Slack bot token")
    .option("--bot-username <username>", "Fake Telegram bot username", "crabline_bot")
    .option("--recorder <path>", "JSONL recorder path")
    .option("--ready-file <path>", "Write the server runtime manifest to this path")
    .option("--self-jid <jid>", "Fake WhatsApp self JID")
    .option("--signing-secret <secret>", "Fake Slack signing secret")
    .option("--once", "Start, print the runtime manifest, and stop immediately", false)
    .action(async (provider, commandOptions: ServeCommandOptions) => {
      const options = program.opts() as GlobalOptions;
      if (!isCrablineFakeProviderChannel(provider)) {
        throw new CrablineError(`Unsupported fake provider server: ${provider}`, {
          kind: "config",
        });
      }
      const port = Number(commandOptions.port);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new CrablineError(`Invalid fake server port: ${commandOptions.port}`, {
          kind: "config",
        });
      }
      const factory = SERVE_PARAM_FACTORIES[provider];
      if (!factory) {
        throw new CrablineError(`Unsupported fake provider server: ${provider}`, {
          kind: "config",
        });
      }
      const server = await startCrablineFakeProviderServer(
        factory(
          {
            host: commandOptions.host,
            port,
            recorderPath: commandOptions.recorder,
          },
          commandOptions,
        ),
      );
      const payload = formatJson(server.manifest);
      if (commandOptions.readyFile) {
        await fs.mkdir(nodePath.dirname(commandOptions.readyFile), { recursive: true });
        await fs.writeFile(commandOptions.readyFile, `${payload}\n`, "utf8");
      }
      print(options.json ? payload : renderServeText(server.manifest));
      if (commandOptions.once) {
        await server.close();
        return;
      }
      await waitForShutdown(server.close);
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

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const shutdown = () => {
      close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function renderServeText(manifest: CrablineFakeProviderManifest) {
  const lines = [
    `${manifest.provider} fake server ready`,
    `  apiRoot: ${manifest.endpoints.apiRoot}`,
    `  inbound: ${manifest.endpoints.adminInboundUrl}`,
    `  recorder: ${manifest.recorderPath}`,
  ];
  const providerFields = renderServeProviderFields(manifest);
  if (!providerFields) {
    throw new CrablineError(`Unsupported fake provider server: ${String(manifest.provider)}`, {
      kind: "config",
    });
  }
  lines.splice(2, 0, ...providerFields);
  return lines.join("\n");
}

function renderServeProviderFields(manifest: CrablineFakeProviderManifest): string[] | undefined {
  if (manifest.provider === "telegram") {
    return [`  adminToken: ${manifest.adminToken}`, `  botToken: ${manifest.botToken}`];
  }
  if (manifest.provider === "whatsapp") {
    return [
      `  adminToken: ${manifest.adminToken}`,
      `  accessToken: ${manifest.accessToken}`,
      `  baileysWebSocket: ${manifest.endpoints.baileysWebSocketUrl}`,
      `  messages: ${manifest.endpoints.messagesUrl}`,
      `  presence: ${manifest.endpoints.presenceUrl}`,
      `  selfJid: ${manifest.selfJid}`,
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

    if (provider.adapter === "script") {
      if (!provider.script?.commands.send) {
        findings.push(`provider ${providerId} missing script.commands.send`);
      }
      if (!provider.script?.commands.waitForInbound) {
        findings.push(`provider ${providerId} missing script.commands.waitForInbound`);
      }
    }

    void providerId;
  }

  return findings;
}

export async function runCli(argv: string[]): Promise<number> {
  let exitCode = 0;
  const program = createProgram((code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    const message = ensureErrorMessage(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof CrablineError) {
      return error.exitCode;
    }
    return 1;
  }
}
