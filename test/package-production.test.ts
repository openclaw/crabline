import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DEV_ONLY_RUNTIME_PACKAGES = ["baileys"] as const;
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
      main?: string;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      types?: string;
    };

    expect(pkg.dependencies?.["@types/node"]).toBeDefined();
    expect(pkg.devDependencies?.["@types/node"]).toBeUndefined();

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
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("test/"))).toBe(false);
    expect(files.some((file) => /(^|\/)baileys(\/|$)/u.test(file))).toBe(false);

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
  }, 30_000);

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

      await execFileAsync("npm", ["run", "prebuild"], { cwd: tempDir });
      await expect(fs.stat(path.join(tempDir, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.stat(path.join(tempDir, "coverage"))).toBeDefined();

      await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
      await execFileAsync("npm", ["run", "clean"], { cwd: tempDir });
      await expect(fs.stat(path.join(tempDir, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(tempDir, "coverage"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("extracts pack metadata around lifecycle output", () => {
    const pack: NpmPackMetadata = {
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
});

type NpmPackMetadata = {
  files: Array<{ mode?: number; path: string; size?: number }>;
};

async function npmPackDryRun(root: string): Promise<NpmPackMetadata> {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseNpmPackOutput(stdout);
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
    Boolean(value) && typeof value === "object" && Array.isArray((value as NpmPackMetadata).files)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
