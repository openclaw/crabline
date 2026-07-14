import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
const CURRENT_GENERATION_READ_ATTEMPTS = 8;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyStringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => typeof value[field] === "string" && value[field].length > 0);
}

function isGeneratedManifest(value: Record<string, unknown>): boolean {
  if (
    value.version !== 1 ||
    !hasNonEmptyStringFields(value, ["adminToken", "baseUrl", "provider"]) ||
    !isRecord(value.endpoints) ||
    !isRecord(value.env)
  ) {
    return false;
  }
  const endpoints = value.endpoints;
  const env = value.env;
  const baseUrl = value.baseUrl as string;
  switch (value.provider) {
    case "mattermost":
      return (
        hasNonEmptyStringFields(value, ["botToken", "botUserId"]) &&
        hasNonEmptyStringFields(endpoints, ["adminInboundUrl", "apiRoot", "websocketUrl"]) &&
        hasNonEmptyStringFields(env, ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]) &&
        endpoints.adminInboundUrl === `${baseUrl}/crabline/mattermost/inbound` &&
        endpoints.apiRoot === `${baseUrl}/api/v4` &&
        endpoints.websocketUrl === `${baseUrl.replace(/^http/u, "ws")}/api/v4/websocket` &&
        env.MATTERMOST_BOT_TOKEN === value.botToken &&
        env.MATTERMOST_URL === baseUrl
      );
    case "matrix":
      return (
        hasNonEmptyStringFields(value, ["accessToken", "botUserId", "deviceId"]) &&
        hasNonEmptyStringFields(endpoints, ["adminInboundUrl", "clientApiRoot", "syncUrl"]) &&
        hasNonEmptyStringFields(env, [
          "MATRIX_ACCESS_TOKEN",
          "MATRIX_BASE_URL",
          "MATRIX_USER_ID",
        ]) &&
        endpoints.adminInboundUrl === `${baseUrl}/crabline/matrix/inbound` &&
        endpoints.clientApiRoot === `${baseUrl}/_matrix/client/v3` &&
        endpoints.syncUrl === `${endpoints.clientApiRoot as string}/sync` &&
        env.MATRIX_ACCESS_TOKEN === value.accessToken &&
        env.MATRIX_BASE_URL === baseUrl &&
        env.MATRIX_USER_ID === value.botUserId
      );
    case "signal":
      return (
        hasNonEmptyStringFields(value, ["account"]) &&
        hasNonEmptyStringFields(endpoints, ["adminInboundUrl", "apiRoot", "eventsUrl", "rpcUrl"]) &&
        endpoints.adminInboundUrl === `${baseUrl}/crabline/signal/inbound` &&
        endpoints.apiRoot === baseUrl &&
        endpoints.eventsUrl === `${baseUrl}/api/v1/events` &&
        endpoints.rpcUrl === `${baseUrl}/api/v1/rpc` &&
        Object.keys(env).length === 0
      );
    case "slack":
      return (
        hasNonEmptyStringFields(value, ["botToken", "signingSecret"]) &&
        hasNonEmptyStringFields(endpoints, ["adminInboundUrl", "apiRoot", "eventsUrl"]) &&
        hasNonEmptyStringFields(env, [
          "SLACK_API_URL",
          "SLACK_BOT_TOKEN",
          "SLACK_SIGNING_SECRET",
        ]) &&
        endpoints.adminInboundUrl === `${baseUrl}/crabline/slack/inbound` &&
        endpoints.apiRoot === `${baseUrl}/api/` &&
        endpoints.eventsUrl === `${baseUrl}/slack/events` &&
        env.SLACK_API_URL === endpoints.apiRoot &&
        env.SLACK_BOT_TOKEN === value.botToken &&
        env.SLACK_SIGNING_SECRET === value.signingSecret
      );
    case "telegram":
      return (
        hasNonEmptyStringFields(value, ["botToken"]) &&
        hasNonEmptyStringFields(endpoints, ["adminInboundUrl", "apiRoot"]) &&
        hasNonEmptyStringFields(env, ["TELEGRAM_BOT_TOKEN"]) &&
        endpoints.adminInboundUrl === `${baseUrl}/crabline/telegram/inbound` &&
        endpoints.apiRoot === baseUrl &&
        env.TELEGRAM_BOT_TOKEN === value.botToken
      );
    case "whatsapp":
      return (
        hasNonEmptyStringFields(value, [
          "accessToken",
          "graphVersion",
          "phoneNumberId",
          "selfJid",
        ]) &&
        hasNonEmptyStringFields(endpoints, [
          "adminInboundUrl",
          "apiRoot",
          "baileysWebSocketUrl",
          "messagesUrl",
          "phoneNumberUrl",
          "statusUrl",
        ]) &&
        hasNonEmptyStringFields(env, [
          "CLOUD_API_ACCESS_TOKEN",
          "CLOUD_API_VERSION",
          "WA_BASE_URL",
          "WA_PHONE_NUMBER_ID",
        ]) &&
        endpoints.adminInboundUrl === `${baseUrl}/_crabline/admin/whatsapp/inbound` &&
        endpoints.apiRoot === `${baseUrl}/${value.graphVersion as string}` &&
        endpoints.phoneNumberUrl ===
          `${endpoints.apiRoot as string}/${value.phoneNumberId as string}` &&
        endpoints.messagesUrl === `${endpoints.phoneNumberUrl as string}/messages` &&
        endpoints.statusUrl === endpoints.messagesUrl &&
        endpoints.baileysWebSocketUrl ===
          `${baseUrl.replace(/^http/u, "ws")}/ws/chat?access_token=${encodeURIComponent(
            value.accessToken as string,
          )}` &&
        env.CLOUD_API_ACCESS_TOKEN === value.accessToken &&
        env.CLOUD_API_VERSION === value.graphVersion &&
        env.WA_BASE_URL === baseUrl &&
        env.WA_PHONE_NUMBER_ID === value.phoneNumberId
      );
    case "zalo":
      return (
        hasNonEmptyStringFields(value, ["botId", "botToken"]) &&
        hasNonEmptyStringFields(endpoints, ["adminInboundUrl", "apiRoot"]) &&
        hasNonEmptyStringFields(env, ["ZALO_API_URL", "ZALO_BOT_TOKEN"]) &&
        endpoints.adminInboundUrl === `${baseUrl}/crabline/zalo/inbound` &&
        endpoints.apiRoot === baseUrl &&
        env.ZALO_API_URL === baseUrl &&
        env.ZALO_BOT_TOKEN === value.botToken
      );
    default:
      return false;
  }
}

function isSuccessfulProbe(
  value: unknown,
  manifest: Record<string, unknown>,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  switch (manifest.provider) {
    case "mattermost":
      return (
        value.id === manifest.botUserId &&
        typeof value.username === "string" &&
        value.username.trim().length > 0 &&
        typeof value.update_at === "number" &&
        Number.isSafeInteger(value.update_at) &&
        value.update_at >= 0
      );
    case "matrix":
      return value.user_id === manifest.botUserId;
    case "signal":
      return (
        value.ok === true &&
        typeof value.status === "number" &&
        Number.isInteger(value.status) &&
        value.status >= 200 &&
        value.status < 300
      );
    case "slack":
      return value.ok === true;
    case "telegram": {
      const result = value.result;
      return (
        value.ok === true &&
        isRecord(result) &&
        typeof result.id === "number" &&
        Number.isSafeInteger(result.id) &&
        result.id > 0 &&
        result.is_bot === true &&
        typeof result.first_name === "string" &&
        result.first_name.length > 0
      );
    }
    case "whatsapp":
      return value.id === manifest.phoneNumberId;
    case "zalo":
      return value.ok === true && isRecord(value.result) && value.result.id === manifest.botId;
    default:
      return false;
  }
}

function isReadinessSection(
  value: unknown,
  manifest: Record<string, unknown>,
  manifestPath: string,
  requireCurrentFields: boolean,
): value is Record<string, unknown> {
  if (!isRecord(value) || value.manifestPath !== manifestPath || !isRecord(value.result)) {
    return false;
  }
  const result = value.result;
  return (
    result.ok === true &&
    result.provider === manifest.provider &&
    isRecord(result.endpoints) &&
    isDeepStrictEqual(result.endpoints, manifest.endpoints) &&
    isSuccessfulProbe(result.probe, manifest) &&
    (!requireCurrentFields || (result.proof === "provider-api-probe" && result.ready === true))
  );
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

function withPublishedRecorderPath(
  providerReadiness: Record<string, unknown>,
  recorderPath: string | undefined,
): Record<string, unknown> {
  const result = providerReadiness.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("OpenClaw Crabline provider readiness result is malformed.");
  }
  const publishedResult: Record<string, unknown> = {
    ...(result as Record<string, unknown>),
  };
  if (recorderPath === undefined) {
    delete publishedResult.recorderPath;
  } else {
    publishedResult.recorderPath = recorderPath;
  }
  return {
    ...providerReadiness,
    result: publishedResult,
  };
}

function parseArtifactPointer(contents: string): OpenClawCrablineArtifactPointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("OpenClaw Crabline artifact pointer is malformed.", { cause: error });
  }
  if (!isRecord(parsed)) {
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
    (value.version === 2 &&
      value.providerReadinessArtifactPath !== expected.providerReadinessArtifactPath) ||
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

async function assertArtifactGenerationExists(
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
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(path.join(outputDir, artifactPath));
    } catch (error) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.", {
        cause: error,
      });
    }
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
      if (!isRecord(value)) {
        throw new Error("artifact is not an object");
      }
      return value;
    } catch (error) {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.", {
        cause: error,
      });
    }
  };
  const readNestedRecorderPath = (value: Record<string, unknown>): string | undefined => {
    const result = value.result as Record<string, unknown>;
    const recorderPath = result.recorderPath;
    if (recorderPath !== undefined && typeof recorderPath !== "string") {
      throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
    }
    return recorderPath;
  };

  const manifest = await readArtifactObject(pointer.manifestPath);
  const capabilityMatrix = await readArtifactObject(pointer.capabilityMatrixPath);
  const readiness = await readArtifactObject(pointer.providerReadinessArtifactPath);
  const providerReadiness = readiness.providerReadiness;
  const smoke = readiness.smoke;
  if (
    !isGeneratedManifest(manifest) ||
    capabilityMatrix.version !== 1 ||
    capabilityMatrix.source !== "openclaw/crabline" ||
    capabilityMatrix.manifestPath !== pointer.manifestPath ||
    capabilityMatrix.channelDriver !== "crabline" ||
    typeof capabilityMatrix.selectedChannel !== "string" ||
    capabilityMatrix.selectedChannel.length === 0 ||
    capabilityMatrix.report === null ||
    typeof capabilityMatrix.report !== "object" ||
    Array.isArray(capabilityMatrix.report) ||
    readiness.version !== 1 ||
    readiness.source !== "openclaw/crabline" ||
    readiness.manifestPath !== pointer.manifestPath ||
    readiness.channelDriver !== "crabline" ||
    readiness.selectedChannel !== capabilityMatrix.selectedChannel ||
    manifest.provider !== readiness.selectedChannel ||
    !isReadinessSection(
      smoke,
      manifest,
      pointer.manifestPath,
      pointer.version === 2 || providerReadiness !== undefined,
    ) ||
    (pointer.version === 2 &&
      (!isReadinessSection(providerReadiness, manifest, pointer.manifestPath, true) ||
        !isDeepStrictEqual(providerReadiness, smoke))) ||
    (pointer.version === 1 &&
      providerReadiness !== undefined &&
      (!isReadinessSection(providerReadiness, manifest, pointer.manifestPath, true) ||
        !isDeepStrictEqual(providerReadiness, smoke)))
  ) {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
  }
  const manifestRecorderPath =
    typeof manifest.recorderPath === "string" ? manifest.recorderPath : undefined;
  const providerReadinessRecorderPath = isRecord(providerReadiness)
    ? readNestedRecorderPath(providerReadiness)
    : undefined;
  const smokeRecorderPath = readNestedRecorderPath(smoke);
  const readinessRecorderPaths = [
    ...(isRecord(providerReadiness) ? [providerReadinessRecorderPath] : []),
    smokeRecorderPath,
  ];
  const recorderPaths = [manifestRecorderPath, ...readinessRecorderPaths];
  if (manifest.recorderPath !== undefined && typeof manifest.recorderPath !== "string") {
    throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
  }
  // The artifact store is owner-only; v1 compatibility covers historical layouts, not hostile same-owner rewrites.
  if (
    pointer.version === 1 &&
    readinessRecorderPaths.every((recorderPath) => recorderPath === undefined) &&
    (manifestRecorderPath === undefined ||
      path.dirname(path.resolve(outputDir, manifestRecorderPath)) !== generationDirectory)
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

async function readValidCurrentArtifactGeneration(
  outputDir: string,
  initialPointer: OpenClawCrablineArtifactPointer,
): Promise<OpenClawCrablineArtifactPointer> {
  let pointer = initialPointer;
  let lastValidationError: unknown;
  for (let attempt = 0; attempt < CURRENT_GENERATION_READ_ATTEMPTS; attempt += 1) {
    try {
      await assertArtifactGenerationExists(outputDir, pointer);
      lastValidationError = undefined;
    } catch (error) {
      lastValidationError = error;
    }

    const currentPointer = await readOpenClawCrablineArtifactPointer(outputDir);
    if (currentPointer === null || isDeepStrictEqual(currentPointer, pointer)) {
      if (lastValidationError !== undefined) {
        throw lastValidationError;
      }
      if (currentPointer === null) {
        throw new Error("OpenClaw Crabline current artifact generation is incomplete.");
      }
      return pointer;
    }
    pointer = currentPointer;
  }

  throw new Error(
    "OpenClaw Crabline current artifact generation changed too frequently to validate.",
    lastValidationError === undefined ? undefined : { cause: lastValidationError },
  );
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
  let currentPointer = await readOpenClawCrablineArtifactPointer(outputDir);
  await output.assertIdentityAt();
  await store.assertIdentityAt();
  if (currentPointer) {
    currentPointer = await readValidCurrentArtifactGeneration(outputDir, currentPointer);
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
    const providerReadinessBase = withPublishedRecorderPath(
      params.providerReadiness,
      recorderSnapshotPath,
    );
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
    await assertArtifactGenerationExists(outputDir, pointer);
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
