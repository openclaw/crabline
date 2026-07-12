import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import { type ManifestDefinition, ManifestSchema } from "./schema.js";

const DEFAULT_CONFIG_CANDIDATES = ["crabline.yaml", "crabline.yml", "crabline.json"] as const;

function configLoadError(resolvedPath: string, error: unknown, detail: string): CrablineError {
  return new CrablineError(`Unable to load config file "${resolvedPath}": ${detail}`, {
    cause: error,
    kind: "config",
  });
}

function formatYamlParseError(error: unknown): string {
  if (!(error instanceof Error) || error.name !== "YAMLParseError") {
    return "YAML parse failed.";
  }
  const yamlError = error as Error & {
    code?: unknown;
    linePos?: Array<{ col?: unknown; line?: unknown }>;
  };
  const code = typeof yamlError.code === "string" ? ` (${yamlError.code})` : "";
  const position = yamlError.linePos?.[0];
  const location =
    typeof position?.line === "number" && typeof position.col === "number"
      ? ` at line ${position.line}, column ${position.col}`
      : "";
  return `YAML parse error${code}${location}.`;
}

export async function resolveConfigPath(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const resolved = path.resolve(candidate);
    try {
      if ((await stat(resolved)).isFile()) {
        return resolved;
      }
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
  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw configLoadError(resolvedPath, error, ensureErrorMessage(error));
  }

  let parsed: unknown;
  try {
    parsed = resolvedPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw, { merge: true });
  } catch (error) {
    const detail = resolvedPath.endsWith(".json")
      ? ensureErrorMessage(error)
      : formatYamlParseError(error);
    throw configLoadError(
      resolvedPath,
      resolvedPath.endsWith(".json") ? error : new Error(detail),
      detail,
    );
  }

  try {
    const manifest = ManifestSchema.parse(parsed);
    return { manifest, path: resolvedPath };
  } catch (error) {
    throw configLoadError(resolvedPath, error, ensureErrorMessage(error));
  }
}
