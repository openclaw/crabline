import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CrablineServerManifest } from "../servers/index.js";
import { publishPrivateFileAtomically, securePrivateDirectory } from "./private-file.js";
import {
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  type OpenClawCrablineChannelDriverSelection,
} from "./shared.js";
import type { OpenClawCrablineSmokeRunLock } from "./smoke-lock.js";

const GENERATION_NAME_PATTERN =
  /^generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export type OpenClawCrablineArtifactPointer = {
  capabilityMatrixPath: string;
  generation: string;
  manifestPath: string;
  previousGeneration?: string;
  smokeArtifactPath: string;
  version: 1;
};

export type PublishedOpenClawCrablineArtifactGeneration = OpenClawCrablineArtifactPointer & {
  pointerPath: string;
  smoke: Record<string, unknown>;
  warnings?: string[];
};

type PublishGenerationDependencies = {
  beforePointerSwitch?: (pointer: OpenClawCrablineArtifactPointer) => Promise<void>;
  createGenerationId?: () => string;
  platform?: NodeJS.Platform;
  publishPrivateFile?: typeof publishPrivateFileAtomically;
  secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
  secureWindowsFile?: (filePath: string) => Promise<void>;
};

function assertCanonicalSelectionPaths(selection: OpenClawCrablineChannelDriverSelection): void {
  if (
    selection.capabilityMatrixPath !== OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH ||
    selection.smokeArtifactPath !== OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH
  ) {
    throw new Error("OpenClaw Crabline artifact selection paths are malformed.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertGenerationName(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !GENERATION_NAME_PATTERN.test(value)) {
    throw new Error(`OpenClaw Crabline artifact pointer ${field} is malformed.`);
  }
}

function generationArtifactPath(generation: string, fileName: string): string {
  return path.join(OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY, generation, fileName);
}

function parseArtifactPointer(contents: string): OpenClawCrablineArtifactPointer {
  let value: Partial<OpenClawCrablineArtifactPointer>;
  try {
    value = JSON.parse(contents) as Partial<OpenClawCrablineArtifactPointer>;
  } catch (error) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.", { cause: error });
  }
  if (value.version !== 1) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.");
  }
  assertGenerationName(value.generation, "generation");
  if (value.previousGeneration !== undefined) {
    assertGenerationName(value.previousGeneration, "previousGeneration");
    if (value.previousGeneration === value.generation) {
      throw new Error("OpenClaw Crabline artifact pointer is malformed.");
    }
  }

  const expected = {
    capabilityMatrixPath: generationArtifactPath(
      value.generation,
      OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
    ),
    manifestPath: generationArtifactPath(value.generation, OPENCLAW_CRABLINE_MANIFEST_PATH),
    smokeArtifactPath: generationArtifactPath(
      value.generation,
      OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
    ),
  };
  if (
    typeof value.capabilityMatrixPath !== "string" ||
    value.capabilityMatrixPath !== expected.capabilityMatrixPath ||
    value.manifestPath !== expected.manifestPath ||
    typeof value.smokeArtifactPath !== "string" ||
    value.smokeArtifactPath !== expected.smokeArtifactPath
  ) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.");
  }

  return {
    capabilityMatrixPath: value.capabilityMatrixPath,
    generation: value.generation,
    ...(value.previousGeneration ? { previousGeneration: value.previousGeneration } : {}),
    manifestPath: value.manifestPath,
    smokeArtifactPath: value.smokeArtifactPath,
    version: 1,
  };
}

export async function readOpenClawCrablineArtifactPointer(
  outputDir: string,
): Promise<OpenClawCrablineArtifactPointer | null> {
  try {
    return parseArtifactPointer(
      await fs.readFile(
        path.join(path.resolve(outputDir), OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH),
        "utf8",
      ),
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

async function assertCurrentGenerationExists(
  outputDir: string,
  pointer: OpenClawCrablineArtifactPointer,
): Promise<void> {
  for (const artifactPath of [
    pointer.manifestPath,
    pointer.capabilityMatrixPath,
    pointer.smokeArtifactPath,
  ]) {
    const stats = await fs.lstat(path.join(outputDir, artifactPath));
    if (!stats.isFile()) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
    }
  }
}

async function pruneArtifactStore(params: {
  lock: OpenClawCrablineSmokeRunLock;
  pointer: OpenClawCrablineArtifactPointer | null;
  store: Awaited<ReturnType<typeof securePrivateDirectory>>;
}): Promise<void> {
  const retainedGenerations = new Set(
    params.pointer
      ? [params.pointer.generation, params.pointer.previousGeneration].filter(
          (generation): generation is string => generation !== undefined,
        )
      : [],
  );
  for (const entry of await fs.readdir(params.store.directoryPath, { withFileTypes: true })) {
    const isAbandonedStaging = entry.isDirectory() && entry.name.startsWith(".staging-");
    const isObsoleteGeneration =
      entry.isDirectory() &&
      GENERATION_NAME_PATTERN.test(entry.name) &&
      !retainedGenerations.has(entry.name);
    if (!isAbandonedStaging && !isObsoleteGeneration) {
      continue;
    }
    await params.lock.assertOwned();
    await params.store.assertIdentityAt();
    await fs.rm(path.join(params.store.directoryPath, entry.name), {
      force: true,
      recursive: true,
    });
    await params.store.assertIdentityAt();
  }
}

export async function publishOpenClawCrablineArtifactGeneration(
  params: {
    capabilityReport: unknown;
    lock: OpenClawCrablineSmokeRunLock;
    manifest: CrablineServerManifest;
    outputDir: string;
    selection: OpenClawCrablineChannelDriverSelection;
    smoke: Record<string, unknown>;
  },
  dependencies: PublishGenerationDependencies = {},
): Promise<PublishedOpenClawCrablineArtifactGeneration> {
  assertCanonicalSelectionPaths(params.selection);
  const outputDir = path.resolve(params.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
  const directoryOptions = {
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.secureWindowsDirectory
      ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
      : {}),
  };
  const store = await securePrivateDirectory(storePath, directoryOptions);
  await params.lock.assertOwned();
  const currentPointer = await readOpenClawCrablineArtifactPointer(outputDir);
  if (currentPointer) {
    await assertCurrentGenerationExists(outputDir, currentPointer);
  }
  await pruneArtifactStore({
    lock: params.lock,
    pointer: currentPointer,
    store,
  });

  const generationId = dependencies.createGenerationId?.() ?? randomUUID();
  const generation = `generation-${generationId}`;
  if (!GENERATION_NAME_PATTERN.test(generation)) {
    throw new Error("OpenClaw Crabline artifact generation id is malformed.");
  }
  const stagingPath = path.join(storePath, `.staging-${generationId}`);
  const generationPath = path.join(storePath, generation);
  const staging = await securePrivateDirectory(stagingPath, directoryOptions);
  const pointer: OpenClawCrablineArtifactPointer = {
    capabilityMatrixPath: generationArtifactPath(generation, params.selection.capabilityMatrixPath),
    generation,
    manifestPath: generationArtifactPath(generation, OPENCLAW_CRABLINE_MANIFEST_PATH),
    ...(currentPointer ? { previousGeneration: currentPointer.generation } : {}),
    smokeArtifactPath: generationArtifactPath(generation, params.selection.smokeArtifactPath),
    version: 1,
  };
  const publishPrivateFile = dependencies.publishPrivateFile ?? publishPrivateFileAtomically;
  const fileOptions = {
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.secureWindowsFile
      ? { secureWindowsFile: dependencies.secureWindowsFile }
      : {}),
  };
  const smoke = {
    ...params.smoke,
    manifestPath: pointer.manifestPath,
  };
  const artifactContents = [
    {
      contents: `${JSON.stringify(params.manifest, null, 2)}\n`,
      fileName: OPENCLAW_CRABLINE_MANIFEST_PATH,
    },
    {
      contents: `${JSON.stringify(
        {
          version: 1,
          source: "openclaw/crabline",
          channelDriver: params.selection.channelDriver,
          selectedChannel: params.selection.channel,
          manifestPath: pointer.manifestPath,
          report: params.capabilityReport,
        },
        null,
        2,
      )}\n`,
      fileName: params.selection.capabilityMatrixPath,
    },
    {
      contents: `${JSON.stringify(
        {
          version: 1,
          source: "openclaw/crabline",
          channelDriver: params.selection.channelDriver,
          selectedChannel: params.selection.channel,
          manifestPath: pointer.manifestPath,
          smoke,
        },
        null,
        2,
      )}\n`,
      fileName: params.selection.smokeArtifactPath,
    },
  ] as const;

  let installed = false;
  let committed = false;
  try {
    await params.lock.assertOwned();
    for (const artifact of artifactContents) {
      await staging.assertIdentityAt();
      await publishPrivateFile(
        path.join(stagingPath, artifact.fileName),
        artifact.contents,
        fileOptions,
      );
      await staging.assertIdentityAt();
    }
    await params.lock.assertOwned();
    await fs.rename(stagingPath, generationPath);
    installed = true;
    await staging.assertIdentityAt(generationPath);
    await store.assertIdentityAt();

    await dependencies.beforePointerSwitch?.(pointer);
    await params.lock.commitFileAtomically({
      contents: `${JSON.stringify(pointer, null, 2)}\n`,
      destinationPath: path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH),
      stageDirectory: store.directoryPath,
      stageFile: async (filePath, contents) => {
        await store.assertIdentityAt();
        await publishPrivateFile(filePath, contents, fileOptions);
        await store.assertIdentityAt();
      },
    });
    committed = true;
    let warnings: string[] | undefined;
    try {
      const committedPointer = await readOpenClawCrablineArtifactPointer(outputDir);
      if (!committedPointer) {
        throw new Error("OpenClaw Crabline artifact pointer is missing after publication.");
      }
      await pruneArtifactStore({
        lock: params.lock,
        pointer: committedPointer,
        store,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings = [`OpenClaw Crabline artifact retention cleanup failed: ${detail}`];
    }

    return {
      ...pointer,
      pointerPath: OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
      smoke,
      ...(warnings ? { warnings } : {}),
    };
  } finally {
    if (!committed) {
      const unpublishedPath = installed ? generationPath : stagingPath;
      let referencedByPointer = false;
      if (installed) {
        try {
          const livePointer = await readOpenClawCrablineArtifactPointer(outputDir);
          referencedByPointer =
            livePointer?.generation === generation ||
            livePointer?.previousGeneration === generation;
        } catch {
          referencedByPointer = true;
        }
      }
      if (!referencedByPointer) {
        await staging
          .assertIdentityAt(unpublishedPath)
          .then(() => fs.rm(unpublishedPath, { force: true, recursive: true }))
          .catch(() => undefined);
      }
    }
  }
}
