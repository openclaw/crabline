import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CrablineServerManifest } from "../servers/index.js";
import {
  captureDirectoryIdentity,
  publishPrivateFileAtomically,
  removeSecuredPrivateDirectory,
  securePrivateDirectory,
  syncParentDirectory,
} from "./private-file.js";
import {
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  type OpenClawCrablineChannelDriverSelection,
} from "./shared.js";
import type { OpenClawCrablineSmokeRunLock } from "./smoke-lock.js";

const GENERATION_NAME_PATTERN =
  /^generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STAGING_NAME_PATTERN =
  /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REMOVAL_TOMBSTONE_PATTERN =
  /^\.(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.remove$/iu;
type OpenClawCrablineArtifactPointerBase = {
  capabilityMatrixPath: string;
  generation: string;
  manifestPath: string;
  previousGeneration?: string;
  providerReadinessArtifactPath: string;
  smokeArtifactPath: string;
};

export type OpenClawCrablineArtifactPointer =
  | (OpenClawCrablineArtifactPointerBase & { version: 1 })
  | (OpenClawCrablineArtifactPointerBase & {
      recorderSnapshotPath: string | null;
      version: 2;
    });

export type PublishedOpenClawCrablineArtifactGeneration = OpenClawCrablineArtifactPointer & {
  pointerPath: string;
  providerReadiness: Record<string, unknown>;
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
  syncParent?: typeof syncParentDirectory;
};

type RecorderSnapshot = {
  contents: string;
  fileName: string;
};

function resolveProviderReadinessArtifactPath(
  selection: OpenClawCrablineChannelDriverSelection,
): typeof OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH {
  const readinessPath = selection.providerReadinessArtifactPath ?? selection.smokeArtifactPath;
  if (
    selection.capabilityMatrixPath !== OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH ||
    readinessPath !== OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH
  ) {
    throw new Error("OpenClaw Crabline artifact selection paths are malformed.");
  }
  return readinessPath;
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

function artifactRemovalTombstoneBaseName(name: string): string | null {
  const originalName = REMOVAL_TOMBSTONE_PATTERN.exec(name)?.[1];
  return originalName !== undefined &&
    (GENERATION_NAME_PATTERN.test(originalName) || STAGING_NAME_PATTERN.test(originalName))
    ? originalName
    : null;
}

function withRecorderSnapshotPath(
  providerReadiness: Record<string, unknown>,
  recorderPath: string,
): Record<string, unknown> {
  const result = providerReadiness.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("OpenClaw Crabline provider readiness result is malformed.");
  }
  return {
    ...providerReadiness,
    result: {
      ...result,
      recorderPath,
    },
  };
}

function parseArtifactPointer(contents: string): OpenClawCrablineArtifactPointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.");
  }
  const value = parsed as Partial<OpenClawCrablineArtifactPointerBase> & {
    recorderSnapshotPath?: unknown;
    version?: unknown;
  };
  if (value.version !== 1 && value.version !== 2) {
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
    providerReadinessArtifactPath: generationArtifactPath(
      value.generation,
      OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
    ),
    smokeArtifactPath: generationArtifactPath(
      value.generation,
      OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
    ),
  };
  if (
    typeof value.capabilityMatrixPath !== "string" ||
    value.capabilityMatrixPath !== expected.capabilityMatrixPath ||
    value.manifestPath !== expected.manifestPath ||
    (value.providerReadinessArtifactPath !== undefined &&
      value.providerReadinessArtifactPath !== expected.providerReadinessArtifactPath) ||
    (value.smokeArtifactPath !== undefined &&
      value.smokeArtifactPath !== expected.smokeArtifactPath) ||
    (value.providerReadinessArtifactPath === undefined && value.smokeArtifactPath === undefined)
  ) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.");
  }
  if (value.version === 1 && value.recorderSnapshotPath !== undefined) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.");
  }
  if (value.version === 2) {
    if (value.recorderSnapshotPath !== null && typeof value.recorderSnapshotPath !== "string") {
      throw new Error("OpenClaw Crabline artifact pointer is malformed.");
    }
    if (typeof value.recorderSnapshotPath === "string") {
      const recorderFileName = path.basename(value.recorderSnapshotPath);
      if (
        !recorderFileName.endsWith(".jsonl") ||
        value.recorderSnapshotPath !== generationArtifactPath(value.generation, recorderFileName)
      ) {
        throw new Error("OpenClaw Crabline artifact pointer is malformed.");
      }
    }
  }

  const pointer = {
    capabilityMatrixPath: value.capabilityMatrixPath,
    generation: value.generation,
    ...(value.previousGeneration ? { previousGeneration: value.previousGeneration } : {}),
    manifestPath: value.manifestPath,
    providerReadinessArtifactPath: value.providerReadinessArtifactPath ?? value.smokeArtifactPath!,
    smokeArtifactPath: value.smokeArtifactPath ?? value.providerReadinessArtifactPath!,
  };
  return value.version === 1
    ? { ...pointer, version: 1 }
    : {
        ...pointer,
        recorderSnapshotPath: value.recorderSnapshotPath as string | null,
        version: 2,
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
  const generationDirectory = path.resolve(
    outputDir,
    OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
    pointer.generation,
  );
  let currentGeneration: Awaited<ReturnType<typeof captureDirectoryIdentity>>;
  try {
    currentGeneration = await captureDirectoryIdentity(generationDirectory);
  } catch (error) {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.", {
      cause: error,
    });
  }
  const assertGenerationIdentity = async (): Promise<void> => {
    try {
      await currentGeneration.assertIdentityAt();
    } catch (error) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.", {
        cause: error,
      });
    }
  };

  for (const artifactPath of [
    pointer.manifestPath,
    pointer.capabilityMatrixPath,
    pointer.providerReadinessArtifactPath,
  ]) {
    await assertGenerationIdentity();
    const stats = await fs.lstat(path.join(outputDir, artifactPath));
    if (!stats.isFile()) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
    }
    await assertGenerationIdentity();
  }

  const readArtifactObject = async (artifactPath: string): Promise<Record<string, unknown>> => {
    try {
      await assertGenerationIdentity();
      const value = JSON.parse(await fs.readFile(path.join(outputDir, artifactPath), "utf8"));
      await assertGenerationIdentity();
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("artifact is not an object");
      }
      return value as Record<string, unknown>;
    } catch (error) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.", {
        cause: error,
      });
    }
  };
  const readNestedRecorderPath = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const result = (value as Record<string, unknown>).result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      return undefined;
    }
    const recorderPath = (result as Record<string, unknown>).recorderPath;
    if (recorderPath !== undefined && typeof recorderPath !== "string") {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
    }
    return recorderPath;
  };

  const manifest = await readArtifactObject(pointer.manifestPath);
  const readiness = await readArtifactObject(pointer.providerReadinessArtifactPath);
  const manifestRecorderPath =
    typeof manifest.recorderPath === "string" ? manifest.recorderPath : undefined;
  const providerReadinessRecorderPath = readNestedRecorderPath(readiness.providerReadiness);
  const smokeRecorderPath = readNestedRecorderPath(readiness.smoke);
  const recorderPaths = [manifestRecorderPath, providerReadinessRecorderPath, smokeRecorderPath];
  if (manifest.recorderPath !== undefined && typeof manifest.recorderPath !== "string") {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
  }
  if (
    pointer.version === 1 &&
    manifestRecorderPath !== undefined &&
    providerReadinessRecorderPath === undefined &&
    smokeRecorderPath === undefined &&
    path.dirname(path.resolve(outputDir, manifestRecorderPath)) !== generationDirectory
  ) {
    return;
  }
  if (pointer.version === 2 && pointer.recorderSnapshotPath === null) {
    if (recorderPaths.some((recorderPath) => recorderPath !== undefined)) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
    }
    return;
  }
  const resolvedRecorderPaths = recorderPaths.map((recorderPath) =>
    recorderPath === undefined ? undefined : path.resolve(outputDir, recorderPath),
  );
  if (
    resolvedRecorderPaths.some(
      (recorderPath) =>
        recorderPath === undefined || path.dirname(recorderPath) !== generationDirectory,
    ) ||
    new Set(resolvedRecorderPaths).size !== 1
  ) {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
  }
  const recorderPath = resolvedRecorderPaths[0]!;
  if (
    pointer.version === 2 &&
    pointer.recorderSnapshotPath !== null &&
    recorderPath !== path.resolve(outputDir, pointer.recorderSnapshotPath)
  ) {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
  }
  try {
    await assertGenerationIdentity();
    const recorderStats = await fs.lstat(recorderPath, { bigint: true });
    if (recorderStats.isFile() && recorderStats.nlink === 1n) {
      await assertGenerationIdentity();
      return;
    }
  } catch (error) {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.", {
      cause: error,
    });
  }
  throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
}

async function pruneArtifactStore(params: {
  lock: OpenClawCrablineSmokeRunLock;
  pointer: OpenClawCrablineArtifactPointer | null;
  store: Awaited<ReturnType<typeof securePrivateDirectory>>;
  directoryOptions?: Parameters<typeof securePrivateDirectory>[1];
}): Promise<void> {
  const retainedGenerations = new Set(
    params.pointer
      ? [params.pointer.generation, params.pointer.previousGeneration].filter(
          (generation): generation is string => generation !== undefined,
        )
      : [],
  );
  for (const entry of await fs.readdir(params.store.directoryPath, { withFileTypes: true })) {
    const isAbandonedStaging = entry.isDirectory() && STAGING_NAME_PATTERN.test(entry.name);
    const isObsoleteGeneration =
      entry.isDirectory() &&
      GENERATION_NAME_PATTERN.test(entry.name) &&
      !retainedGenerations.has(entry.name);
    const removalTombstoneBaseName = entry.isDirectory()
      ? artifactRemovalTombstoneBaseName(entry.name)
      : null;
    const isRemovalTombstone = removalTombstoneBaseName !== null;
    if (!isAbandonedStaging && !isObsoleteGeneration && !isRemovalTombstone) {
      continue;
    }
    await params.lock.assertOwned();
    await params.store.assertIdentityAt();
    const obsolete = await securePrivateDirectory(
      path.join(params.store.directoryPath, entry.name),
      params.directoryOptions,
    );
    await removeSecuredPrivateDirectory(
      obsolete,
      undefined,
      removalTombstoneBaseName ?? entry.name,
    );
    await params.store.assertIdentityAt();
  }
}

export async function publishOpenClawCrablineArtifactGeneration(
  params: {
    capabilityReport: unknown;
    lock: OpenClawCrablineSmokeRunLock;
    manifest: CrablineServerManifest;
    outputDir: string;
    recorderSnapshot?: RecorderSnapshot;
    selection: OpenClawCrablineChannelDriverSelection;
    providerReadiness: Record<string, unknown>;
  },
  dependencies: PublishGenerationDependencies = {},
): Promise<PublishedOpenClawCrablineArtifactGeneration> {
  const providerReadinessArtifactPath = resolveProviderReadinessArtifactPath(params.selection);
  const outputDir = path.resolve(params.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const output = await captureDirectoryIdentity(outputDir);
  await output.assertIdentityAt();
  const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
  const directoryOptions = {
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.secureWindowsDirectory
      ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
      : {}),
    ...(dependencies.syncParent ? { syncParent: dependencies.syncParent } : {}),
  };
  const store = await securePrivateDirectory(storePath, directoryOptions);
  await output.assertIdentityAt();
  await store.assertIdentityAt();
  await params.lock.assertOwned();
  const currentPointer = await readOpenClawCrablineArtifactPointer(outputDir);
  await output.assertIdentityAt();
  await store.assertIdentityAt();
  if (currentPointer) {
    await assertCurrentGenerationExists(outputDir, currentPointer);
    await output.assertIdentityAt();
    await store.assertIdentityAt();
  }
  await pruneArtifactStore({
    directoryOptions,
    lock: params.lock,
    pointer: currentPointer,
    store,
  });
  await output.assertIdentityAt();
  await store.assertIdentityAt();

  const generationId = dependencies.createGenerationId?.() ?? randomUUID();
  const generation = `generation-${generationId}`;
  if (!GENERATION_NAME_PATTERN.test(generation)) {
    throw new Error("OpenClaw Crabline artifact generation id is malformed.");
  }
  const stagingPath = path.join(storePath, `.staging-${generationId}`);
  const generationPath = path.join(storePath, generation);
  const staging = await securePrivateDirectory(stagingPath, directoryOptions);
  await output.assertIdentityAt();
  await store.assertIdentityAt();
  await staging.assertIdentityAt();
  const publishPrivateFile = dependencies.publishPrivateFile ?? publishPrivateFileAtomically;
  const fileOptions = {
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.secureWindowsFile
      ? { secureWindowsFile: dependencies.secureWindowsFile }
      : {}),
    ...(dependencies.syncParent ? { syncParent: dependencies.syncParent } : {}),
  };
  let installed = false;
  let committed = false;
  let primaryError: unknown;
  let published: PublishedOpenClawCrablineArtifactGeneration | undefined;
  try {
    if (
      params.recorderSnapshot &&
      (path.basename(params.recorderSnapshot.fileName) !== params.recorderSnapshot.fileName ||
        !params.recorderSnapshot.fileName.endsWith(".jsonl"))
    ) {
      throw new Error("OpenClaw Crabline recorder snapshot filename is malformed.");
    }
    const recorderSnapshotPath = params.recorderSnapshot
      ? generationArtifactPath(generation, params.recorderSnapshot.fileName)
      : undefined;
    const pointer: OpenClawCrablineArtifactPointer = {
      capabilityMatrixPath: generationArtifactPath(
        generation,
        params.selection.capabilityMatrixPath,
      ),
      generation,
      manifestPath: generationArtifactPath(generation, OPENCLAW_CRABLINE_MANIFEST_PATH),
      ...(currentPointer ? { previousGeneration: currentPointer.generation } : {}),
      providerReadinessArtifactPath: generationArtifactPath(
        generation,
        providerReadinessArtifactPath,
      ),
      recorderSnapshotPath: recorderSnapshotPath ?? null,
      smokeArtifactPath: generationArtifactPath(generation, providerReadinessArtifactPath),
      version: 2,
    };
    const publishedManifest = recorderSnapshotPath
      ? { ...params.manifest, recorderPath: recorderSnapshotPath }
      : Object.fromEntries(
          Object.entries(params.manifest).filter(([key]) => key !== "recorderPath"),
        );
    const providerReadinessBase = recorderSnapshotPath
      ? withRecorderSnapshotPath(params.providerReadiness, recorderSnapshotPath)
      : params.providerReadiness;
    const providerReadiness = {
      ...providerReadinessBase,
      manifestPath: pointer.manifestPath,
    };
    const artifactContents: { contents: string; fileName: string }[] = [
      {
        contents: `${JSON.stringify(publishedManifest, null, 2)}\n`,
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
            providerReadiness,
            smoke: providerReadiness,
          },
          null,
          2,
        )}\n`,
        fileName: providerReadinessArtifactPath,
      },
      ...(params.recorderSnapshot
        ? [
            {
              contents: params.recorderSnapshot.contents,
              fileName: params.recorderSnapshot.fileName,
            },
          ]
        : []),
    ];

    await params.lock.assertOwned();
    for (const artifact of artifactContents) {
      await output.assertIdentityAt();
      await store.assertIdentityAt();
      await staging.assertIdentityAt();
      await publishPrivateFile(
        path.join(stagingPath, artifact.fileName),
        artifact.contents,
        fileOptions,
      );
      await output.assertIdentityAt();
      await store.assertIdentityAt();
      await staging.assertIdentityAt();
    }
    await params.lock.assertOwned();
    await output.assertIdentityAt();
    await store.assertIdentityAt();
    await fs.rename(stagingPath, generationPath);
    installed = true;
    await (dependencies.syncParent ?? syncParentDirectory)(generationPath, dependencies.platform);
    await output.assertIdentityAt();
    await staging.assertIdentityAt(generationPath);
    await store.assertIdentityAt();

    await dependencies.beforePointerSwitch?.(pointer);
    await output.assertIdentityAt();
    await store.assertIdentityAt();
    await staging.assertIdentityAt(generationPath);
    await params.lock.commitFileAtomically({
      contents: `${JSON.stringify(pointer, null, 2)}\n`,
      destinationPath: path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH),
      stageDirectory: store.directoryPath,
      stageFile: async (filePath, contents) => {
        await output.assertIdentityAt();
        await store.assertIdentityAt();
        await staging.assertIdentityAt(generationPath);
        await publishPrivateFile(filePath, contents, fileOptions);
        await output.assertIdentityAt();
        await store.assertIdentityAt();
        await staging.assertIdentityAt(generationPath);
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
        directoryOptions,
        lock: params.lock,
        pointer: committedPointer,
        store,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings = [`OpenClaw Crabline artifact retention cleanup failed: ${detail}`];
    }

    published = {
      ...pointer,
      pointerPath: OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
      providerReadiness,
      smoke: providerReadiness,
      ...(warnings ? { warnings } : {}),
    };
  } catch (error) {
    primaryError = error;
  }

  if (!committed) {
    const unpublishedPath = installed ? generationPath : stagingPath;
    let referencedByPointer = false;
    if (installed) {
      try {
        const livePointer = await readOpenClawCrablineArtifactPointer(outputDir);
        referencedByPointer =
          livePointer?.generation === generation || livePointer?.previousGeneration === generation;
      } catch {
        referencedByPointer = true;
      }
    }
    if (!referencedByPointer) {
      try {
        await removeSecuredPrivateDirectory(staging, unpublishedPath);
      } catch (cleanupError) {
        if (primaryError !== undefined) {
          const primaryMessage =
            primaryError instanceof Error ? primaryError.message : String(primaryError);
          const aggregateError = new AggregateError(
            [primaryError, cleanupError],
            `${primaryMessage} OpenClaw Crabline artifact rollback cleanup also failed.`,
          );
          aggregateError.cause = primaryError;
          const primaryCode = (primaryError as NodeJS.ErrnoException).code;
          if (primaryCode) {
            Object.assign(aggregateError, { code: primaryCode });
          }
          throw aggregateError;
        }
        throw cleanupError;
      }
    }
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }
  return published!;
}
