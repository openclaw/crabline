import { constants as fsConstants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import YAML from "yaml";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import { type ManifestDefinition, ManifestSchema } from "./schema.js";

const DEFAULT_CONFIG_CANDIDATES = ["crabline.yaml", "crabline.yml", "crabline.json"] as const;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class DuplicateJsonKeyError extends SyntaxError {}

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

function formatJsonParseError(error: unknown): string {
  if (error instanceof DuplicateJsonKeyError) {
    return "JSON parse error: duplicate object key.";
  }
  if (!(error instanceof SyntaxError)) {
    return "JSON parse failed.";
  }
  const position = /\bposition (\d+)\b/u.exec(error.message)?.[1];
  return position ? `JSON parse error at position ${position}.` : "JSON parse error.";
}

function parseJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  const document = YAML.parseDocument(raw, { schema: "json", uniqueKeys: true });
  if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) {
    throw new DuplicateJsonKeyError("JSON contains a duplicate object key.");
  }
  return parsed;
}

async function readManifestFile(resolvedPath: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      resolvedPath,
      process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Config path must be a regular file.");
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      throw new Error(`Config file exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
    }

    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > MAX_MANIFEST_BYTES) {
      throw new Error(`Config file exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
    }
    return UTF8_DECODER.decode(buffer.subarray(0, offset));
  } finally {
    await handle?.close();
  }
}

export async function resolveConfigPath(explicitPath?: string): Promise<string> {
  if (explicitPath !== undefined) {
    if (explicitPath.trim().length === 0) {
      throw new CrablineError("Config path must not be empty.", { kind: "config" });
    }
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
    raw = await readManifestFile(resolvedPath);
  } catch (error) {
    throw configLoadError(resolvedPath, error, ensureErrorMessage(error));
  }

  const isJson = path.extname(resolvedPath).toLowerCase() === ".json";
  let parsed: unknown;
  try {
    parsed = isJson ? parseJson(raw) : YAML.parse(raw, { merge: true });
  } catch (error) {
    const detail = isJson ? formatJsonParseError(error) : formatYamlParseError(error);
    throw configLoadError(resolvedPath, new Error(detail), detail);
  }

  try {
    const manifest = ManifestSchema.parse(parsed);
    return { manifest, path: resolvedPath };
  } catch (error) {
    throw configLoadError(resolvedPath, error, ensureErrorMessage(error));
  }
}
