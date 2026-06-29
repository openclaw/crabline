import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
  it("does not ship dev-only dependencies in the runtime package", async () => {
    const root = process.cwd();
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      bundleDependencies?: string[];
      bundledDependencies?: string[];
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

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
    expect(files).toContain("package.json");
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("test/"))).toBe(false);
    expect(files.some((file) => /(^|\/)baileys(\/|$)/u.test(file))).toBe(false);

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
});

async function npmPackDryRun(root: string): Promise<{ files: Array<{ path: string }> }> {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const jsonStart = stdout.lastIndexOf("\n[");
  const jsonText = stdout.slice(jsonStart >= 0 ? jsonStart + 1 : stdout.indexOf("[")).trim();
  const [pack] = JSON.parse(jsonText) as Array<{ files: Array<{ path: string }> }>;
  if (!pack) {
    throw new Error("npm pack --dry-run returned no package metadata.");
  }
  return pack;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
