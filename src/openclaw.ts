import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  CRABLINE_SERVER_CHANNELS,
  isCrablineServerChannel,
  startCrablineServer,
  type CrablineServerChannel,
  type CrablineServerManifest,
  type StartCrablineServerParams,
  type StartedCrablineServer,
} from "./servers/index.js";
import { SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/slack.js";
import { MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/mattermost.js";
import { MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/matrix.js";
import { SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/signal.js";
import { TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/telegram.js";
import { WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/whatsapp.js";
import { ZALO_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "./openclaw/bridges/zalo.js";
import {
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  isRecord,
  parseQaTarget,
  runOpenClawCrablineProviderProbe,
  type OpenClawCrablineAgentDelivery,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineProviderReadinessResult,
  type OpenClawCrablineGatewayBinding,
  type OpenClawCrablineInbound,
  type OpenClawCrablineInboundInput,
  type OpenClawCrablineOutboundMessage,
  type OpenClawCrablineProviderAdapter,
  type OpenClawCrablineProviderBridge,
  type OpenClawCrablineProviderBridgeRegistry,
  type StartedOpenClawCrablineAdapter,
  type StartOpenClawCrablineAdapterParams,
} from "./openclaw/shared.js";
import { publishOpenClawCrablineArtifactGeneration } from "./openclaw/artifact-generation.js";
import { isAcceptedOpenClawCrablineOutbound } from "./openclaw/outbound-contract.js";
import {
  securePrivateDirectory,
  syncParentDirectory,
  type SecuredPrivateDirectory,
} from "./openclaw/private-file.js";
import {
  acquireOpenClawCrablineSmokeRunLock,
  releaseOpenClawCrablineSmokeRunLock,
} from "./openclaw/smoke-lock.js";
import fs from "node:fs/promises";
import path from "node:path";

export {
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
};
export type {
  OpenClawCrablineAgentDelivery,
  OpenClawCrablineChannelDriverSelection,
  OpenClawCrablineChannelDriverSmokeResult,
  OpenClawCrablineProviderReadinessResult,
  OpenClawCrablineConversation,
  OpenClawCrablineGatewayBinding,
  OpenClawCrablineInbound,
  OpenClawCrablineInboundInput,
  OpenClawCrablineOutboundMessage,
  StartedOpenClawCrablineAdapter,
  StartOpenClawCrablineAdapterParams,
} from "./openclaw/shared.js";

const OPENCLAW_CRABLINE_PROVIDER_BRIDGES = {
  mattermost: MATTERMOST_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  matrix: MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  signal: SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  slack: SLACK_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  telegram: TELEGRAM_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  whatsapp: WHATSAPP_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
  zalo: ZALO_OPENCLAW_CRABLINE_PROVIDER_BRIDGE,
} satisfies OpenClawCrablineProviderBridgeRegistry;

const OPENCLAW_CRABLINE_PROVIDER_BRIDGE_LIST = Object.values(
  OPENCLAW_CRABLINE_PROVIDER_BRIDGES,
) as readonly OpenClawCrablineProviderBridge[];
const RECORDER_TEMP_NAME_PATTERN =
  /^\.([a-z]+)-fake-provider\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl\.tmp$/iu;
const RECORDER_LOCK_REMOVAL_TOMBSTONE_PATTERN =
  /^\.(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.remove$/iu;

function isOpenClawCrablineRecorderTemporary(name: string): boolean {
  const channel = RECORDER_TEMP_NAME_PATTERN.exec(name)?.[1]?.toLowerCase();
  return channel !== undefined && isCrablineServerChannel(channel);
}

function hasStringRecordValues(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

type OpenClawCrablineRecorderEvent = {
  accepted: true;
  at: string;
  method: string;
  path: string;
  query: Record<string, string>;
  type: "admin" | "api";
};

function isOpenClawCrablineRecorderEvent(value: unknown): value is OpenClawCrablineRecorderEvent {
  return (
    isRecord(value) &&
    value.accepted === true &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at)) &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    typeof value.path === "string" &&
    value.path.startsWith("/") &&
    hasStringRecordValues(value.query) &&
    (value.type === "admin" || value.type === "api")
  );
}

function openClawCrablineProviderProbeRequest(
  manifest: CrablineServerManifest,
): Pick<OpenClawCrablineRecorderEvent, "method" | "path"> {
  switch (manifest.provider) {
    case "mattermost":
      return {
        method: "GET",
        path: new URL(`${manifest.endpoints.apiRoot}/users/me`).pathname,
      };
    case "matrix":
      return {
        method: "GET",
        path: new URL(`${manifest.endpoints.clientApiRoot}/account/whoami`).pathname,
      };
    case "signal":
      return {
        method: "GET",
        path: new URL("/api/v1/check", manifest.baseUrl).pathname,
      };
    case "slack":
      return {
        method: "POST",
        path: new URL("auth.test", manifest.endpoints.apiRoot).pathname,
      };
    case "telegram":
      return { method: "GET", path: "/bot<redacted>/getMe" };
    case "whatsapp":
      return {
        method: "GET",
        path: new URL(manifest.endpoints.phoneNumberUrl).pathname,
      };
    case "zalo":
      return { method: "POST", path: "/bot<redacted>/getMe" };
  }
}

function assertOpenClawCrablineRecorderEvidence(
  contents: string,
  manifest: CrablineServerManifest,
): void {
  const expectedRequest = openClawCrablineProviderProbeRequest(manifest);
  let recorderEvidence = false;
  for (const line of contents.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        "OpenClaw Crabline provider probe produced no valid JSONL recorder evidence.",
        { cause: error },
      );
    }
    if (!isOpenClawCrablineRecorderEvent(event)) {
      throw new Error(
        "OpenClaw Crabline provider probe produced no valid JSONL recorder evidence.",
      );
    }
    if (
      event.type === "api" &&
      event.method === expectedRequest.method &&
      event.path === expectedRequest.path
    ) {
      recorderEvidence = true;
    }
  }
  if (!recorderEvidence) {
    throw new Error("OpenClaw Crabline provider probe produced no valid JSONL recorder evidence.");
  }
}

function isOpenClawCrablineRecorderTemporaryLock(name: string): boolean {
  return name.endsWith(".lock") && isOpenClawCrablineRecorderTemporary(name.slice(0, -5));
}

function openClawCrablineRecorderLockTombstoneBaseName(name: string): string | null {
  const originalName = RECORDER_LOCK_REMOVAL_TOMBSTONE_PATTERN.exec(name)?.[1];
  return originalName !== undefined && isOpenClawCrablineRecorderTemporaryLock(originalName)
    ? originalName
    : null;
}

async function reclaimOpenClawCrablineRecorderTemporaryLock(
  directoryPath: string,
  name: string,
  lock: Awaited<ReturnType<typeof acquireOpenClawCrablineSmokeRunLock>>,
  quarantineBaseName = name,
): Promise<void> {
  const lockPath = path.join(directoryPath, name);
  let identity: BigIntStats;
  try {
    identity = await fs.lstat(lockPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!identity.isDirectory()) {
    return;
  }
  const currentUserId = process.geteuid?.();
  if (currentUserId !== undefined && identity.uid !== BigInt(currentUserId)) {
    return;
  }

  const quarantinePath = path.join(
    directoryPath,
    `.${quarantineBaseName}.${process.pid}.${randomUUID()}.remove`,
  );
  await lock.assertOwned();
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const quarantined = await fs.lstat(quarantinePath, { bigint: true });
  if (
    !quarantined.isDirectory() ||
    quarantined.dev !== identity.dev ||
    quarantined.ino !== identity.ino
  ) {
    throw new Error("OpenClaw Crabline recorder lock identity changed during recovery.");
  }
  await syncParentDirectory(quarantinePath);
  await fs.rm(quarantinePath, { force: true, recursive: true });
  await syncParentDirectory(quarantinePath);
}

async function reclaimOpenClawCrablineRecorderTemporaries(
  directory: SecuredPrivateDirectory,
  lock: Awaited<ReturnType<typeof acquireOpenClawCrablineSmokeRunLock>>,
): Promise<void> {
  const directoryPath = directory.directoryPath;
  await directory.assertIdentityAt();
  for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
    await directory.assertIdentityAt();
    const tombstoneBaseName = entry.isDirectory()
      ? openClawCrablineRecorderLockTombstoneBaseName(entry.name)
      : null;
    if (isOpenClawCrablineRecorderTemporaryLock(entry.name) || tombstoneBaseName !== null) {
      if (entry.isDirectory()) {
        await reclaimOpenClawCrablineRecorderTemporaryLock(
          directoryPath,
          entry.name,
          lock,
          tombstoneBaseName ?? entry.name,
        );
      }
      continue;
    }
    if (
      !isOpenClawCrablineRecorderTemporary(entry.name) ||
      (!entry.isFile() && !entry.isSymbolicLink())
    ) {
      continue;
    }
    await lock.assertOwned();
    const temporaryPath = path.join(directoryPath, entry.name);
    await fs.rm(temporaryPath, { force: true });
    await syncParentDirectory(temporaryPath);
    await directory.assertIdentityAt();
  }
  await directory.assertIdentityAt();
}

type RecorderSnapshotIdentity = {
  device: bigint;
  inode: bigint;
  userId: bigint;
};

function assertOwnedRecorderStats(
  stats: BigIntStats,
  expected?: RecorderSnapshotIdentity,
): RecorderSnapshotIdentity {
  const currentUserId = process.geteuid?.();
  if (
    !stats.isFile() ||
    stats.nlink !== 1n ||
    stats.ino <= 0n ||
    (currentUserId !== undefined && stats.uid !== BigInt(currentUserId)) ||
    (expected !== undefined &&
      (stats.dev !== expected.device ||
        stats.ino !== expected.inode ||
        stats.uid !== expected.userId))
  ) {
    throw new Error("OpenClaw Crabline recorder snapshot identity is invalid.");
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    userId: stats.uid,
  };
}

async function readOwnedRecorderSnapshot(
  recorderPath: string,
  directory: SecuredPrivateDirectory,
): Promise<{ contents: string; identity: RecorderSnapshotIdentity }> {
  await directory.assertIdentityAt();
  const handle = await fs.open(recorderPath, "r");
  try {
    const identity = assertOwnedRecorderStats(await handle.stat({ bigint: true }));
    assertOwnedRecorderStats(await fs.lstat(recorderPath, { bigint: true }), identity);
    const contents = await handle.readFile("utf8");
    await directory.assertIdentityAt();
    assertOwnedRecorderStats(await fs.lstat(recorderPath, { bigint: true }), identity);
    return { contents, identity };
  } finally {
    await handle.close();
  }
}

async function removeOwnedRecorderTemporary(params: {
  directory: SecuredPrivateDirectory;
  identity?: RecorderSnapshotIdentity;
  recorderPath: string;
  syncParent: (filePath: string) => Promise<void>;
}): Promise<void> {
  await params.directory.assertIdentityAt();
  let stats: BigIntStats;
  try {
    stats = await fs.lstat(params.recorderPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await params.syncParent(params.recorderPath);
      return;
    }
    throw error;
  }
  assertOwnedRecorderStats(stats, params.identity);
  await fs.rm(params.recorderPath);
  await params.directory.assertIdentityAt();
  await params.syncParent(params.recorderPath);
}

function createOpenClawCrablineProviderAdapter(
  manifest: CrablineServerManifest,
): OpenClawCrablineProviderAdapter {
  const bridge = OPENCLAW_CRABLINE_PROVIDER_BRIDGE_LIST.find(
    (candidate) => candidate.provider === manifest.provider,
  );
  if (bridge) {
    const adapter = bridge.createAdapterFromManifest(manifest);
    return {
      ...adapter,
      createOutboundFromRecorderEvent: (params) =>
        isAcceptedOpenClawCrablineOutbound({
          event: params.event,
          manifest,
        })
          ? adapter.createOutboundFromRecorderEvent(params)
          : null,
      probe: () =>
        runOpenClawCrablineProviderProbe(manifest.provider, (signal) => adapter.probe(signal)),
    };
  }
  throw new Error("Unsupported OpenClaw provider binding.");
}

export function resolveOpenClawCrablineChannel(input?: string | null): CrablineServerChannel {
  const channel =
    input === undefined || input === null
      ? OPENCLAW_CRABLINE_DEFAULT_CHANNEL
      : input.trim().toLowerCase();
  if (isCrablineServerChannel(channel)) {
    return channel;
  }
  throw new Error(
    `--channel must be one of ${CRABLINE_SERVER_CHANNELS.join(", ")} for --channel-driver crabline, got "${input}".`,
  );
}

export function resolveOpenClawCrablineChannelDriverSelection(params: {
  channel?: string | null;
}): OpenClawCrablineChannelDriverSelection & {
  providerReadinessArtifactPath: typeof OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH;
} {
  return {
    channel: resolveOpenClawCrablineChannel(params.channel),
    channelDriver: "crabline",
    capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
    providerReadinessArtifactPath: OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
    smokeArtifactPath: OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  };
}

export async function probeOpenClawCrablineProvider(
  manifest: CrablineServerManifest,
): Promise<unknown> {
  return await createOpenClawCrablineProviderAdapter(manifest).probe();
}

export function createOpenClawCrablineProviderBinding(
  manifest: CrablineServerManifest,
): OpenClawCrablineGatewayBinding {
  return createOpenClawCrablineProviderAdapter(manifest).createBinding();
}

export function createOpenClawCrablineAgentDelivery(params: {
  manifest: CrablineServerManifest;
  target: string;
}): OpenClawCrablineAgentDelivery {
  return createOpenClawCrablineProviderAdapter(params.manifest).createAgentDelivery(
    parseQaTarget(params.target),
  );
}

export function createOpenClawCrablineInbound(params: {
  input: OpenClawCrablineInboundInput;
  manifest: CrablineServerManifest;
}): OpenClawCrablineInbound {
  return createOpenClawCrablineProviderAdapter(params.manifest).createInbound(params.input);
}

export function createOpenClawCrablineOutboundFromRecorderEvent(params: {
  event: unknown;
  manifest: CrablineServerManifest;
  targetByProviderTarget: ReadonlyMap<string, string>;
}): OpenClawCrablineOutboundMessage | null {
  return createOpenClawCrablineProviderAdapter(params.manifest).createOutboundFromRecorderEvent({
    event: params.event,
    targetByProviderTarget: params.targetByProviderTarget,
  });
}

export async function startOpenClawCrablineAdapter(
  params: StartOpenClawCrablineAdapterParams,
  dependencies: {
    createProviderAdapter?: typeof createOpenClawCrablineProviderAdapter;
    startServer?: (params: StartCrablineServerParams) => Promise<StartedCrablineServer>;
  } = {},
): Promise<StartedOpenClawCrablineAdapter> {
  const server: StartedCrablineServer = await (dependencies.startServer ?? startCrablineServer)({
    channel: params.channel,
    onEvent: params.onEvent,
    recorderPath: params.recorderPath,
  });
  try {
    const providerAdapter = (
      dependencies.createProviderAdapter ?? createOpenClawCrablineProviderAdapter
    )(server.manifest);
    const binding = providerAdapter.createBinding();
    return {
      ...binding,
      close: server.close,
      createGatewayConfig: (openclawConfig = params.openclawConfig ?? {}) =>
        binding.createGatewayConfig(openclawConfig),
      createAgentDelivery: ({ target }) =>
        providerAdapter.createAgentDelivery(parseQaTarget(target)),
      createInbound: ({ input }) => providerAdapter.createInbound(input),
      createOutboundFromRecorderEvent: ({ event, targetByProviderTarget }) =>
        providerAdapter.createOutboundFromRecorderEvent({
          event,
          targetByProviderTarget,
        }),
      manifest: server.manifest,
      probe: () => providerAdapter.probe(),
    };
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      const aggregateError = new AggregateError(
        [error, closeError],
        "OpenClaw Crabline adapter startup failed.",
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  }
}

type ProviderReadinessDependencies = {
  acquireLock?: typeof acquireOpenClawCrablineSmokeRunLock;
  publishGeneration?: typeof publishOpenClawCrablineArtifactGeneration;
  releaseLock?: typeof releaseOpenClawCrablineSmokeRunLock;
  startAdapter?: typeof startOpenClawCrablineAdapter;
  syncParent?: typeof syncParentDirectory;
};

export function runOpenClawCrablineProviderReadiness(params: {
  outputDir: string;
  selection: OpenClawCrablineChannelDriverSelection;
}): Promise<OpenClawCrablineProviderReadinessResult>;
export async function runOpenClawCrablineProviderReadiness(
  params: {
    outputDir: string;
    selection: OpenClawCrablineChannelDriverSelection;
  },
  dependencies: ProviderReadinessDependencies = {},
): Promise<OpenClawCrablineProviderReadinessResult> {
  const outputDir = path.resolve(params.outputDir);
  const releaseLock = dependencies.releaseLock ?? releaseOpenClawCrablineSmokeRunLock;
  const syncRecorderParent = dependencies.syncParent ?? syncParentDirectory;
  const smokeLock = await (dependencies.acquireLock ?? acquireOpenClawCrablineSmokeRunLock)({
    channel: params.selection.channel,
    outputDir,
  });
  let outcome:
    | { committed: false; error: unknown }
    | { committed: true; result: OpenClawCrablineProviderReadinessResult };
  let recorderDirectory: SecuredPrivateDirectory | undefined;
  let recorderIdentity: RecorderSnapshotIdentity | undefined;
  let recorderPath: string | undefined;

  try {
    const artifactsDirectory = await securePrivateDirectory(path.join(outputDir, "artifacts"));
    recorderDirectory = await securePrivateDirectory(
      path.join(artifactsDirectory.directoryPath, "crabline"),
    );
    await artifactsDirectory.assertIdentityAt();
    await recorderDirectory.assertIdentityAt();
    await reclaimOpenClawCrablineRecorderTemporaries(recorderDirectory, smokeLock);
    recorderPath = path.join(
      recorderDirectory.directoryPath,
      `.${params.selection.channel}-fake-provider.${randomUUID()}.jsonl.tmp`,
    );
    const adapter = await (dependencies.startAdapter ?? startOpenClawCrablineAdapter)({
      channel: params.selection.channel,
      openclawConfig: {},
      recorderPath,
    });
    let probe: unknown;
    let probeFailed = false;
    let probeFailure: unknown;
    try {
      probe = await adapter.probe();
    } catch (error) {
      probeFailed = true;
      probeFailure = error;
    }
    try {
      await adapter.close();
    } catch (cleanupError) {
      if (!probeFailed) {
        throw cleanupError;
      }
      if (probeFailure instanceof Error) {
        const existingCause = probeFailure.cause;
        try {
          Object.defineProperty(probeFailure, "cause", {
            configurable: true,
            value:
              existingCause === undefined
                ? cleanupError
                : new AggregateError(
                    [existingCause, cleanupError],
                    "OpenClaw Crabline provider probe cleanup also failed.",
                  ),
          });
        } catch {
          // Some provider errors are frozen; preserving the primary failure is authoritative.
        }
        throw probeFailure;
      }
      const combinedError = new Error("OpenClaw Crabline provider probe and cleanup both failed.", {
        cause: cleanupError,
      });
      Object.defineProperty(combinedError, "errors", {
        value: [probeFailure, cleanupError],
      });
      throw combinedError;
    }
    if (probeFailed) {
      throw probeFailure;
    }
    const recorderSnapshot = await readOwnedRecorderSnapshot(recorderPath, recorderDirectory);
    recorderIdentity = recorderSnapshot.identity;
    const recorderSnapshotContents = recorderSnapshot.contents;
    assertOpenClawCrablineRecorderEvidence(recorderSnapshotContents, adapter.manifest);

    const capabilityReport = {
      result: {
        driver: "crabline",
        selectedChannel: params.selection.channel,
        supportedChannels: [...CRABLINE_SERVER_CHANNELS],
      },
    };
    const providerReadiness = {
      result: {
        ok: true,
        proof: "provider-api-probe",
        ready: true,
        probe,
        provider: adapter.manifest.provider,
        endpoints: adapter.manifest.endpoints,
        recorderPath: path.relative(outputDir, adapter.manifest.recorderPath),
      },
    };
    const generation = await (
      dependencies.publishGeneration ?? publishOpenClawCrablineArtifactGeneration
    )({
      capabilityReport,
      lock: smokeLock,
      manifest: adapter.manifest,
      outputDir,
      recorderSnapshot: {
        contents: recorderSnapshotContents,
        fileName: `${params.selection.channel}-fake-provider.jsonl`,
      },
      selection: params.selection,
      providerReadiness,
    });
    let recorderCleanupWarning: string | undefined;
    try {
      await removeOwnedRecorderTemporary({
        directory: recorderDirectory,
        identity: recorderIdentity,
        recorderPath,
        syncParent: syncRecorderParent,
      });
      recorderPath = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      recorderCleanupWarning = `OpenClaw Crabline recorder snapshot committed but temporary cleanup failed: ${detail}`;
    }
    outcome = {
      committed: true,
      result: {
        artifactPointerPath: generation.pointerPath,
        capabilityReport,
        capabilityMatrixPath: generation.capabilityMatrixPath,
        generation: generation.generation,
        manifestPath: generation.manifestPath,
        providerReadiness: generation.providerReadiness,
        providerReadinessArtifactPath: generation.providerReadinessArtifactPath,
        smoke: generation.providerReadiness,
        smokeArtifactPath: generation.providerReadinessArtifactPath,
        ...(generation.warnings || recorderCleanupWarning
          ? {
              warnings: [
                ...(generation.warnings ?? []),
                ...(recorderCleanupWarning ? [recorderCleanupWarning] : []),
              ],
            }
          : {}),
      },
    };
  } catch (error) {
    let primaryError = error;
    if (recorderPath && recorderDirectory) {
      try {
        await removeOwnedRecorderTemporary({
          directory: recorderDirectory,
          ...(recorderIdentity ? { identity: recorderIdentity } : {}),
          recorderPath,
          syncParent: syncRecorderParent,
        });
        recorderPath = undefined;
      } catch (cleanupError) {
        if (primaryError instanceof Error) {
          const existingCause = primaryError.cause;
          try {
            Object.defineProperty(primaryError, "cause", {
              configurable: true,
              value:
                existingCause === undefined
                  ? cleanupError
                  : new AggregateError(
                      [existingCause, cleanupError],
                      "OpenClaw Crabline readiness failure cleanup also failed.",
                    ),
            });
          } catch {
            // Frozen failures remain authoritative even if temporary cleanup also fails.
          }
        } else {
          const combinedError = new Error(
            "OpenClaw Crabline readiness and temporary cleanup both failed.",
            { cause: cleanupError },
          );
          Object.defineProperty(combinedError, "errors", {
            value: [primaryError, cleanupError],
          });
          primaryError = combinedError;
        }
      }
    }
    outcome = { committed: false, error: primaryError };
  }

  try {
    await releaseLock(smokeLock);
  } catch (cleanupError) {
    // The pointer switch is authoritative; lock removal cannot roll it back.
    if (!outcome.committed) {
      if (outcome.error instanceof Error) {
        const existingCause = outcome.error.cause;
        try {
          Object.defineProperty(outcome.error, "cause", {
            configurable: true,
            value:
              existingCause === undefined
                ? cleanupError
                : new AggregateError(
                    [existingCause, cleanupError],
                    "OpenClaw Crabline smoke failure cleanup also failed.",
                  ),
          });
        } catch {
          // Some failures are frozen; preserving the primary error is authoritative.
        }
        throw outcome.error;
      }
      const combinedError = new Error("OpenClaw Crabline smoke and lock cleanup both failed.", {
        cause: cleanupError,
      });
      Object.defineProperty(combinedError, "errors", {
        value: [outcome.error, cleanupError],
      });
      throw combinedError;
    }
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    outcome.result = {
      ...outcome.result,
      warnings: [
        ...(outcome.result.warnings ?? []),
        `OpenClaw Crabline smoke committed but lock cleanup failed: ${detail}`,
      ],
    };
  }

  if (!outcome.committed) {
    throw outcome.error;
  }
  return outcome.result;
}

/** @deprecated Use runOpenClawCrablineProviderReadiness. */
export const runOpenClawCrablineChannelDriverSmoke = runOpenClawCrablineProviderReadiness;

export function createOpenClawCrablineChannelReportNotes(
  selection: OpenClawCrablineChannelDriverSelection | null | undefined,
): string[] {
  if (!selection) {
    return [];
  }

  return [
    `Channel driver: ${selection.channelDriver} local provider for ${selection.channel}.`,
    `Channel artifact pointer: ${OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH}.`,
    `Generation capability filename: ${selection.capabilityMatrixPath}.`,
    `Generation provider-readiness filename: ${selection.providerReadinessArtifactPath ?? selection.smokeArtifactPath}.`,
    "Crabline verifies the local provider API is ready; OpenClaw channel behavior is proven separately by QA scenarios that run the real channel adapter.",
  ];
}
