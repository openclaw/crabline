import { Command } from "commander";
import { loadManifest } from "../config/load.js";
import { createRegistry } from "../providers/registry.js";
import { formatJson, formatRunResultText } from "../core/reporters.js";
import { computeExitCode, runFixtureCommand, runSuite } from "../core/run.js";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";

type GlobalOptions = {
  config?: string;
  json?: boolean;
};

function print(value: string): void {
  process.stdout.write(`${value}\n`);
}

async function withManifest<T>(
  options: GlobalOptions,
  action: (context: Awaited<ReturnType<typeof loadManifest>>) => Promise<T>,
): Promise<T> {
  return action(await loadManifest(options.config));
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("crabline")
    .description("Deterministic CLI harness for messaging provider E2E tests")
    .option("-c, --config <path>", "Config file path")
    .option("--json", "Machine-readable output", false)
    .showHelpAfterError();

  program
    .command("providers")
    .description("List configured providers and supported platform overlap")
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
      process.exitCode = computeExitCode(result);
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
        process.exitCode = computeExitCode(result);
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
      process.exitCode = computeExitCode(result);
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
    .command("doctor")
    .description("Diagnose common setup problems")
    .action(async () => {
      const options = program.opts() as GlobalOptions;
      const { manifest } = await loadManifest(options.config);
      const findings = diagnose(manifest);
      const ok = findings.length === 0;
      const payload = { findings, ok };
      print(options.json ? formatJson(payload) : ok ? "doctor ok" : findings.join("\n"));
      process.exitCode = ok ? 0 : 10;
    });

  return program;
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

    if (provider.adapter === "slack") {
      if (!process.env.SLACK_BOT_TOKEN) {
        findings.push(`provider ${providerId} missing env SLACK_BOT_TOKEN`);
      }
      if (!process.env.SLACK_SIGNING_SECRET) {
        findings.push(`provider ${providerId} missing env SLACK_SIGNING_SECRET`);
      }
    }

    if (provider.adapter === "discord") {
      if (!provider.discord?.botToken && !process.env.DISCORD_BOT_TOKEN) {
        findings.push(`provider ${providerId} missing discord.botToken or DISCORD_BOT_TOKEN`);
      }
    }

    if (provider.adapter === "matrix") {
      if (!provider.matrix?.baseURL && !process.env.MATRIX_BASE_URL) {
        findings.push(`provider ${providerId} missing matrix.baseURL or MATRIX_BASE_URL`);
      }
      if (
        !provider.matrix?.auth &&
        !process.env.MATRIX_ACCESS_TOKEN &&
        !(process.env.MATRIX_USERNAME && process.env.MATRIX_PASSWORD)
      ) {
        findings.push(
          `provider ${providerId} missing MATRIX_ACCESS_TOKEN or MATRIX_USERNAME/MATRIX_PASSWORD`,
        );
      }
    }

    if (provider.adapter === "imessage") {
      const local = provider.imessage?.local ?? process.env.IMESSAGE_LOCAL !== "false";
      if (!local) {
        if (!provider.imessage?.serverUrl && !process.env.IMESSAGE_SERVER_URL) {
          findings.push(`provider ${providerId} missing imessage.serverUrl or IMESSAGE_SERVER_URL`);
        }
        if (!provider.imessage?.apiKey && !process.env.IMESSAGE_API_KEY) {
          findings.push(`provider ${providerId} missing imessage.apiKey or IMESSAGE_API_KEY`);
        }
      }
    }
  }

  return findings;
}

export async function runCli(argv: string[]): Promise<number> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (error) {
    const message = ensureErrorMessage(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof CrablineError) {
      return error.exitCode;
    }
    return 1;
  }
}
