import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const DEV_ONLY_RUNTIME_PACKAGES = ["baileys"] as const;
const PUBLIC_RUNTIME_EXPORTS = [
  "BUILTIN_ADAPTERS",
  "CRABLINE_FAKE_PROVIDER_CHANNELS",
  "CRABLINE_SERVER_CHANNELS",
  "FIXTURE_MODES",
  "INBOUND_AUTHORS",
  "INBOUND_NONCE_MODES",
  "INBOUND_STRATEGIES",
  "ManifestSchema",
  "OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH",
  "OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY",
  "OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH",
  "OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH",
  "OPENCLAW_CRABLINE_DEFAULT_CHANNEL",
  "OPENCLAW_CRABLINE_MANIFEST_PATH",
  "OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH",
  "OPENCLAW_SUPPORT_CATALOG",
  "PROVIDER_PLATFORMS",
  "ProviderConfigSchema",
  "createOpenClawCrablineAgentDelivery",
  "createOpenClawCrablineChannelReportNotes",
  "createOpenClawCrablineFakeProviderBinding",
  "createOpenClawCrablineInbound",
  "createOpenClawCrablineOutboundFromRecorderEvent",
  "createOpenClawCrablineProviderBinding",
  "createRegistry",
  "isCrablineFakeProviderChannel",
  "isCrablineServerChannel",
  "probeOpenClawCrablineFakeProvider",
  "probeOpenClawCrablineProvider",
  "resolveOpenClawCrablineChannel",
  "resolveOpenClawCrablineChannelDriverSelection",
  "resolveTelegramAdapterConfig",
  "resolveWhatsAppAdapterConfig",
  "runOpenClawCrablineChannelDriverSmoke",
  "runOpenClawCrablineProviderReadiness",
  "startCrablineFakeProviderServer",
  "startCrablineServer",
  "startMatrixServer",
  "startMattermostServer",
  "startOpenClawCrablineAdapter",
  "startSignalServer",
  "startSlackFakeServer",
  "startSlackServer",
  "startTelegramFakeServer",
  "startTelegramServer",
  "startWhatsAppFakeServer",
  "startWhatsAppServer",
  "startZaloServer",
] as const;
const PUBLIC_TYPE_EXPORTS = [
  "BuiltinAdapterId",
  "CatalogEntry",
  "CrablineFakeProviderChannel",
  "CrablineFakeProviderManifest",
  "CrablineServerChannel",
  "CrablineServerManifest",
  "FixtureDefinition",
  "FixtureMode",
  "InboundEnvelope",
  "ManifestDefinition",
  "MattermostServerManifest",
  "MatrixServerManifest",
  "NormalizedTarget",
  "OpenClawCrablineAgentDelivery",
  "OpenClawCrablineChannelDriverSelection",
  "OpenClawCrablineChannelDriverSmokeResult",
  "OpenClawCrablineConversation",
  "OpenClawCrablineGatewayBinding",
  "OpenClawCrablineInbound",
  "OpenClawCrablineInboundInput",
  "OpenClawCrablineOutboundMessage",
  "OpenClawCrablineProviderReadinessResult",
  "ProbeResult",
  "ProviderAdapter",
  "ProviderConfig",
  "ProviderContext",
  "ProviderPlatform",
  "ProviderSupportStatus",
  "Registry",
  "SendContext",
  "SendResult",
  "ServerEventObserver",
  "ServerRequestEvent",
  "SignalServerManifest",
  "SlackFakeServerManifest",
  "SlackServerManifest",
  "StartedCrablineFakeProviderServer",
  "StartedCrablineServer",
  "StartedMattermostServer",
  "StartedMatrixServer",
  "StartedOpenClawCrablineAdapter",
  "StartedSignalServer",
  "StartedSlackFakeServer",
  "StartedSlackServer",
  "StartedTelegramFakeServer",
  "StartedTelegramServer",
  "StartedWhatsAppFakeServer",
  "StartedWhatsAppServer",
  "StartedZaloServer",
  "StartCrablineFakeProviderServerParams",
  "StartCrablineServerParams",
  "StartMattermostServerParams",
  "StartMatrixServerParams",
  "StartOpenClawCrablineAdapterParams",
  "StartSignalServerParams",
  "StartSlackFakeServerParams",
  "StartSlackServerParams",
  "StartTelegramFakeServerParams",
  "StartTelegramServerParams",
  "StartWhatsAppFakeServerParams",
  "StartWhatsAppServerParams",
  "StartZaloServerParams",
  "TelegramFakeServerManifest",
  "TelegramServerManifest",
  "WaitContext",
  "WatchContext",
  "WhatsAppBaileysMessage",
  "WhatsAppFakeServerManifest",
  "WhatsAppServerManifest",
  "ZaloServerManifest",
] as const;
const IMPORT_PATTERNS = DEV_ONLY_RUNTIME_PACKAGES.map(
  (packageName) =>
    new RegExp(
      String.raw`(?:from\s+["']${escapeRegex(packageName)}["']|import\(\s*["']${escapeRegex(packageName)}["']\s*\)|require\(\s*["']${escapeRegex(packageName)}["']\s*\))`,
      "u",
    ),
);

describe("production package", () => {
  it("ships its public entry points and CLI without dev-only dependencies", async () => {
    const root = process.cwd();
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      bundleDependencies?: string[];
      bundledDependencies?: string[];
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      main?: string;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      files?: string[];
      types?: string;
      version?: string;
    };

    expect(pkg.dependencies?.["@types/node"]).toBeDefined();
    expect(pkg.dependencies?.libsignal).toBe("6.0.0");
    expect(pkg.devDependencies?.["@types/node"]).toBeUndefined();
    expect(pkg.exports).toEqual({
      ".": {
        types: "./dist/src/index.d.ts",
        import: "./dist/src/index.js",
      },
    });
    expect(pkg.files).toEqual([
      "assets/crabline-banner.svg",
      "dist/src",
      "README.md",
      "docs/channel-setup.md",
      "fixtures/examples/crabline.example.yaml",
    ]);

    for (const packageName of DEV_ONLY_RUNTIME_PACKAGES) {
      expect(pkg.dependencies?.[packageName]).toBeUndefined();
      expect(pkg.optionalDependencies?.[packageName]).toBeUndefined();
      expect(pkg.peerDependencies?.[packageName]).toBeUndefined();
      expect(pkg.bundleDependencies ?? []).not.toContain(packageName);
      expect(pkg.bundledDependencies ?? []).not.toContain(packageName);
      expect(pkg.devDependencies?.[packageName]).toBeDefined();
    }

    const pack = await npmPackDryRun(root);
    const files = pack.files.map((file) => file.path);
    const cliPath = pkg.bin?.crabline?.replace(/^\.\//u, "");
    const mainPath = pkg.main?.replace(/^\.\//u, "");
    const typesPath = pkg.types?.replace(/^\.\//u, "");

    expect(cliPath).toBe("dist/src/bin/crabline.js");
    expect(mainPath).toBeDefined();
    expect(typesPath).toBeDefined();
    expect(files).toContain("package.json");
    expect(files).toContain(cliPath);
    expect(files).toContain(mainPath);
    expect(files).toContain(typesPath);
    expect(files).toContain("assets/crabline-banner.svg");
    expect(files).toContain("README.md");
    expect(files).toContain("docs/channel-setup.md");
    expect(files).toContain("fixtures/examples/crabline.example.yaml");
    expect(files).not.toContain("fixtures/examples/openclaw-bridge.yaml");
    expect(files).toContain("LICENSE");
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("test/"))).toBe(false);
    expect(files.some((file) => /(^|\/)baileys(\/|$)/u.test(file))).toBe(false);

    const packedFixtures = files.filter(
      (file) => file.startsWith("fixtures/") && /\.ya?ml$/u.test(file),
    );
    expect(packedFixtures).toEqual(["fixtures/examples/crabline.example.yaml"]);
    for (const fixturePath of packedFixtures) {
      const fixture = parse(await fs.readFile(path.join(root, fixturePath), "utf8")) as {
        providers?: Record<string, { adapter?: string }>;
      };
      expect(
        Object.entries(fixture.providers ?? {})
          .filter(([, provider]) => provider.adapter === "script")
          .map(([providerId]) => providerId),
        `${fixturePath} must not depend on unpackaged script commands`,
      ).toEqual([]);
    }

    const cliContents = await fs.readFile(path.join(root, cliPath!), "utf8");
    expect(cliContents).toMatch(/^#!\/usr\/bin\/env node\r?\n/u);
    const { stdout: cliHelp } = await execFileAsync(process.execPath, [
      path.join(root, cliPath!),
      "--help",
    ]);
    expect(cliHelp).toContain("Usage: crabline");

    const runtimeFiles = files.filter((file) => file.startsWith("dist/") && file.endsWith(".js"));
    await Promise.all(
      runtimeFiles.map(async (file) => {
        const contents = await fs.readFile(path.join(root, file), "utf8");
        for (const pattern of IMPORT_PATTERNS) {
          expect(contents, `${file} imports a dev-only runtime package`).not.toMatch(pattern);
        }
      }),
    );
    const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-production-install-"));
    const packDirectory = path.join(installRoot, "pack");
    const consumerDirectory = path.join(installRoot, "consumer");
    try {
      await Promise.all([
        fs.mkdir(packDirectory, { recursive: true }),
        fs.mkdir(consumerDirectory, { recursive: true }),
      ]);
      const packed = await npmPack(root, packDirectory);
      const tarballPath = path.join(packDirectory, packed.filename);
      await fs.writeFile(
        path.join(consumerDirectory, "package.json"),
        JSON.stringify({ name: "crabline-production-consumer", private: true, type: "module" }),
      );
      await execNpm(
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--omit=dev",
          tarballPath,
        ],
        {
          cwd: consumerDirectory,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const installedRoot = path.join(consumerDirectory, "node_modules", "@openclaw", "crabline");
      const installedPackage = JSON.parse(
        await fs.readFile(path.join(installedRoot, "package.json"), "utf8"),
      ) as typeof pkg;
      expect(installedPackage.version).toBe(pkg.version);
      expect(installedPackage.exports).toEqual(pkg.exports);
      for (const packageName of DEV_ONLY_RUNTIME_PACKAGES) {
        await expect(
          fs.stat(path.join(consumerDirectory, "node_modules", packageName)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }

      const { stdout: importOutput } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'const pkg = await import("@openclaw/crabline"); console.log(JSON.stringify(Object.keys(pkg).sort()));',
        ],
        { cwd: consumerDirectory },
      );
      expect(JSON.parse(importOutput) as string[]).toEqual(PUBLIC_RUNTIME_EXPORTS);

      await fs.writeFile(
        path.join(consumerDirectory, "consumer.ts"),
        [
          'import { startCrablineServer } from "@openclaw/crabline";',
          `import type { ${PUBLIC_TYPE_EXPORTS.join(", ")} } from "@openclaw/crabline";`,
          "const start: typeof startCrablineServer = startCrablineServer;",
          `type PublicTypes = [${PUBLIC_TYPE_EXPORTS.join(", ")}];`,
          "const legacySmokeResult: OpenClawCrablineChannelDriverSmokeResult = {",
          '  artifactPointerPath: "pointer.json",',
          "  capabilityReport: {},",
          '  capabilityMatrixPath: "capabilities.json",',
          '  generation: "generation-legacy",',
          '  manifestPath: "manifest.json",',
          "  smoke: { result: { ok: true } },",
          '  smokeArtifactPath: "smoke.json",',
          "};",
          "declare const publicTypes: PublicTypes;",
          "void legacySmokeResult;",
          "void start;",
          "void publicTypes;",
          "",
        ].join("\n"),
      );
      await execFileAsync(
        path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc6.cmd" : "tsc6"),
        [
          "--noEmit",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          "--types",
          "node",
          "--ignoreConfig",
          "consumer.ts",
        ],
        { cwd: consumerDirectory },
      );

      const cliShim = path.join(
        consumerDirectory,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "crabline.cmd" : "crabline",
      );
      await expect(fs.stat(cliShim)).resolves.toBeDefined();
      const { stdout: installedCliHelp } =
        process.platform === "win32"
          ? await execFileAsync(
              process.env.ComSpec ?? "cmd.exe",
              ["/d", "/s", "/c", `"${cliShim}" --help`],
              { cwd: consumerDirectory },
            )
          : await execFileAsync(cliShim, ["--help"], { cwd: consumerDirectory });
      expect(installedCliHelp).toContain("Usage: crabline");
    } finally {
      await fs.rm(installRoot, { force: true, recursive: true });
    }
  }, 120_000);

  it("embeds source contents in published JavaScript source maps", async () => {
    const root = process.cwd();
    const pack = await npmPackDryRun(root);
    const sourceMaps = pack.files
      .map((file) => file.path)
      .filter((file) => file.startsWith("dist/") && file.endsWith(".js.map"));

    expect(sourceMaps).not.toEqual([]);
    await Promise.all(
      sourceMaps.map(async (file) => {
        const sourceMap = JSON.parse(await fs.readFile(path.join(root, file), "utf8")) as {
          sources?: unknown[];
          sourcesContent?: unknown[];
        };
        expect(sourceMap.sourcesContent, `${file} is missing inline source contents`).toHaveLength(
          sourceMap.sources?.length ?? 0,
        );
        expect(sourceMap.sourcesContent?.every((source) => typeof source === "string")).toBe(true);
      }),
    );
  }, 120_000);

  it("uses portable cleanup scripts", async () => {
    const root = process.cwd();
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-package-scripts-"));

    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({
          private: true,
          scripts: {
            clean: pkg.scripts?.clean,
            prebuild: pkg.scripts?.prebuild,
          },
        }),
      );
      await Promise.all([
        fs.mkdir(path.join(tempDir, "coverage"), { recursive: true }),
        fs.mkdir(path.join(tempDir, "dist"), { recursive: true }),
      ]);

      await execNpm(["run", "prebuild"], { cwd: tempDir });
      await expect(fs.stat(path.join(tempDir, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.stat(path.join(tempDir, "coverage"))).toBeDefined();

      await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
      await execNpm(["run", "clean"], { cwd: tempDir });
      await expect(fs.stat(path.join(tempDir, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(tempDir, "coverage"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("runs autoreview Python tests in the verify gate", async () => {
    const [pkgContents, launcher] = await Promise.all([
      fs.readFile("package.json", "utf8"),
      fs.readFile("tools/run-autoreview-tests.mjs", "utf8"),
    ]);
    const pkg = JSON.parse(pkgContents) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.["test:autoreview"]).toBe("node tools/run-autoreview-tests.mjs");
    expect(pkg.scripts?.verify).toContain("pnpm test:autoreview");
    expect(launcher).toContain("sys.version_info >= (3, 10)");
    expect(launcher).toContain("Python 3.10 or newer is required");
  });

  it("keeps the published and development Node floors distinct", async () => {
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as {
      devEngines?: { runtime?: { name?: string; onFail?: string; version?: string } };
      engines?: { node?: string };
      packageManager?: string;
    };

    expect(pkg.engines?.node).toBe(">=22");
    expect(pkg.packageManager).toBe("pnpm@11.13.0");
    expect(pkg.devEngines?.runtime).toEqual({
      name: "node",
      onFail: "error",
      version: ">=22.13.0",
    });
  });

  it("lints repository tooling with the type-aware gate", async () => {
    const [pkgContents, launcher, tsconfigContents] = await Promise.all([
      fs.readFile("package.json", "utf8"),
      fs.readFile("tools/run-autoreview-tests.mjs", "utf8"),
      fs.readFile("tsconfig.test.json", "utf8"),
    ]);
    const pkg = JSON.parse(pkgContents) as { scripts?: Record<string, string> };
    const tsconfig = JSON.parse(tsconfigContents) as { include?: string[] };

    expect(pkg.scripts?.lint).toBe(
      "pnpm format:check && pnpm typecheck && oxlint --deny-warnings " +
        "--allow vitest/require-mock-type-parameters --type-aware " +
        "--tsconfig tsconfig.test.json src test tools vitest.config.ts",
    );
    expect(tsconfig.include).toEqual(["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]);
    expect(launcher).toContain(
      "oxlint-disable-next-line no-console -- This CLI failure must be visible on stderr.",
    );
  });

  it("documents source-checkout and user-supplied script bridge commands", async () => {
    const root = process.cwd();
    const [readme, channelSetup] = await Promise.all([
      fs.readFile(path.join(root, "README.md"), "utf8"),
      fs.readFile(path.join(root, "docs/channel-setup.md"), "utf8"),
    ]);

    expect(readme).toContain("use `pnpm dev` there rather than");
    expect(readme).toContain("`pnpm exec crabline`");
    expect(channelSetup).toContain("does not ship a generic OpenClaw gateway command bridge");
    expect(channelSetup).not.toContain("fixtures/examples/openclaw-bridge.yaml");
  });

  it("documents trusted script manifests and canonical WhatsApp Cloud targets", async () => {
    const root = process.cwd();
    const [readme, channelSetup] = await Promise.all([
      fs.readFile(path.join(root, "README.md"), "utf8"),
      fs.readFile(path.join(root, "docs/channel-setup.md"), "utf8"),
    ]);

    for (const document of [readme, channelSetup]) {
      expect(document).toContain("executable, trusted code");
      expect(document).toContain("only from sources you trust");
    }
    expect(channelSetup).toContain(
      "Matrix webhook ingress currently has no provider-native authentication mode",
    );
    expect(readme).toContain(
      "WhatsApp Cloud API users: digits-only `wa_id` values such as `15551234567`",
    );
    expect(readme).not.toContain("WhatsApp users: `+15551234567`");
  });

  it("extracts pack metadata around lifecycle output", () => {
    const pack: NpmPackMetadata = {
      filename: "openclaw-crabline-0.1.9.tgz",
      files: [{ path: "dist/src/bin/crabline.js" }],
    };
    const outputs = [
      `> @openclaw/crabline prepare\n${JSON.stringify([pack], null, 2)}\n> prepare complete`,
      `npm notice run prepare\n${JSON.stringify({ "@openclaw/crabline": pack }, null, 2)}\nnpm notice complete`,
    ];

    for (const output of outputs) {
      expect(parseNpmPackOutput(output)).toEqual(pack);
    }
  });

  it("wraps Windows npm commands for cmd /s /c quote stripping", () => {
    expect(buildWindowsNpmCommand(["pack", "--pack-destination", "C:\\path with spaces"])).toBe(
      '""npm.cmd" "pack" "--pack-destination" "C:\\path with spaces""',
    );
  });
});

type NpmPackMetadata = {
  filename: string;
  files: Array<{ mode?: number; path: string; size?: number }>;
};

async function npmPackDryRun(root: string): Promise<NpmPackMetadata> {
  const { stdout } = await execNpm(["pack", "--dry-run", "--json"], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseNpmPackOutput(stdout);
}

async function npmPack(root: string, destination: string): Promise<NpmPackMetadata> {
  const { stdout } = await execNpm(["pack", "--json", "--pack-destination", destination], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseNpmPackOutput(stdout);
}

async function execNpm(
  args: string[],
  options: Parameters<typeof execFileAsync>[2],
): Promise<{ stderr: string; stdout: string }> {
  const result =
    process.platform === "win32"
      ? await execFileAsync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", buildWindowsNpmCommand(args)],
          { ...options, windowsVerbatimArguments: true },
        )
      : await execFileAsync("npm", args, options);
  return {
    stderr: String(result.stderr),
    stdout: String(result.stdout),
  };
}

function buildWindowsNpmCommand(args: string[]): string {
  return `"${["npm.cmd", ...args].map(quoteCmdArgument).join(" ")}"`;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function parseNpmPackOutput(output: string): NpmPackMetadata {
  let pack: NpmPackMetadata | undefined;
  for (let start = 0; start < output.length; start += 1) {
    if (!isJsonDocumentStart(output, start)) {
      continue;
    }
    const end = findJsonDocumentEnd(output, start);
    if (end === -1) {
      continue;
    }
    try {
      const metadata = JSON.parse(output.slice(start, end)) as unknown;
      const packs = Array.isArray(metadata)
        ? metadata
        : metadata && typeof metadata === "object"
          ? Object.values(metadata)
          : [];
      if (packs.length === 1 && isNpmPackMetadata(packs[0])) {
        pack = packs[0];
      }
    } catch {
      // Lifecycle output may contain JSON-like text before the metadata document.
    }
    start = end - 1;
  }
  if (!pack) {
    throw new Error("npm pack --dry-run returned no package metadata.");
  }
  return pack;
}

function isJsonDocumentStart(output: string, index: number): boolean {
  if (output[index] !== "{" && output[index] !== "[") {
    return false;
  }
  const lineStart = output.lastIndexOf("\n", index - 1) + 1;
  return output.slice(lineStart, index).trim() === "";
}

function findJsonDocumentEnd(output: string, start: number): number {
  const closingTokens: string[] = [];
  let escaped = false;
  let inString = false;
  for (let index = start; index < output.length; index += 1) {
    const token = output[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (token === "\\") {
        escaped = true;
      } else if (token === '"') {
        inString = false;
      }
      continue;
    }
    if (token === '"') {
      inString = true;
    } else if (token === "{") {
      closingTokens.push("}");
    } else if (token === "[") {
      closingTokens.push("]");
    } else if (token === "}" || token === "]") {
      if (closingTokens.pop() !== token) {
        return -1;
      }
      if (closingTokens.length === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function isNpmPackMetadata(value: unknown): value is NpmPackMetadata {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as NpmPackMetadata).filename === "string" &&
    Array.isArray((value as NpmPackMetadata).files)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
