import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CrablineError } from "../core/errors.js";
import { type ManifestDefinition, ManifestSchema } from "./schema.js";

const DEFAULT_CONFIG_CANDIDATES = ["crabline.yaml", "crabline.yml", "crabline.json"] as const;

export async function resolveConfigPath(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const resolved = path.resolve(candidate);
    try {
      await access(resolved);
      return resolved;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new CrablineError(
    "No config file found. Create crabline.yaml, crabline.yml, or crabline.json.",
    { kind: "config" },
  );
}

export async function loadManifest(
  configPath?: string,
): Promise<{ manifest: ManifestDefinition; path: string }> {
  const resolvedPath = await resolveConfigPath(configPath);
  const raw = await readFile(resolvedPath, "utf8");
  const parsed = resolvedPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  const manifest = ManifestSchema.parse(parsed);
  return { manifest, path: resolvedPath };
}
