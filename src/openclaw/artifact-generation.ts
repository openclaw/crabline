import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CrablineServerManifest } from "../servers/index.js";
import {
  publishPrivateFileAtomically,
  securePrivateDirectory,
  type SecuredPrivateDirectory,
} from "./private-file.js";
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
const STAGING_NAME_PATTERN =
  /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CLEANUP_NAME_PATTERN =
  /^\.cleanup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
};

type PublishGenerationDependencies = {
  beforePointerSwitch?: (pointer: OpenClawCrablineArtifactPointer) => Promise<void>;
  createGenerationId?: () => string;
  platform?: NodeJS.Platform;
  publishPrivateFile?: typeof publishPrivateFileAtomically;
  secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
  secureWindowsFile?: (filePath: string) => Promise<void>;
};

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

async function claimAndRemoveDirectory(params: {
  candidatePath: string;
  store: SecuredPrivateDirectory;
}): Promise<void> {
  let candidateStats;
  try {
    candidateStats = await fs.lstat(params.candidatePath, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (!candidateStats.isDirectory() || candidateStats.ino <= 0n) {
    throw new Error("OpenClaw Crabline artifact cleanup candidate is not a directory.");
  }

  const claimPath = path.join(params.store.directoryPath, `.cleanup-${randomUUID()}`);
  await params.store.assertIdentityAt();
  await fs.rename(params.candidatePath, claimPath);
  const claimedStats = await fs.lstat(claimPath, { bigint: true });
  if (
    !claimedStats.isDirectory() ||
    claimedStats.dev !== candidateStats.dev ||
    claimedStats.ino !== candidateStats.ino
  ) {
    throw new Error("OpenClaw Crabline artifact cleanup directory identity changed.");
  }
  await fs.rm(claimPath, { recursive: true });
  await params.store.assertIdentityAt();
}

async function cleanupAbandonedArtifactDirectories(params: {
  pointer: OpenClawCrablineArtifactPointer | null;
  store: SecuredPrivateDirectory;
}): Promise<void> {
  const retainedGenerations = new Set(
    [params.pointer?.generation, params.pointer?.previousGeneration].filter(
      (value): value is string => value !== undefined,
    ),
  );
  const entries = await fs.readdir(params.store.directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const shouldRemove =
      STAGING_NAME_PATTERN.test(entry.name) ||
      CLEANUP_NAME_PATTERN.test(entry.name) ||
      (GENERATION_NAME_PATTERN.test(entry.name) && !retainedGenerations.has(entry.name));
    if (!shouldRemove) {
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error("OpenClaw Crabline artifact cleanup candidate is not a directory.");
    }
    await claimAndRemoveDirectory({
      candidatePath: path.join(params.store.directoryPath, entry.name),
      store: params.store,
    });
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
  const currentPointer = await readOpenClawCrablineArtifactPointer(outputDir);
  if (currentPointer) {
    await assertCurrentGenerationExists(outputDir, currentPointer);
  }
  await cleanupAbandonedArtifactDirectories({ pointer: currentPointer, store });

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
  await staging.assertIdentityAt(generationPath);
  await store.assertIdentityAt();

  await dependencies.beforePointerSwitch?.(pointer);
  await params.lock.commitFileAtomically({
    contents: `${JSON.stringify(pointer, null, 2)}\n`,
    destinationPath: path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH),
    stageFile: async (filePath, contents) => {
      await publishPrivateFile(filePath, contents, fileOptions);
    },
  });
  await store.assertIdentityAt();

  return {
    ...pointer,
    pointerPath: OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
    smoke,
  };
}
