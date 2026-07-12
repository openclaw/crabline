import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  publishOpenClawCrablineArtifactGeneration,
  readOpenClawCrablineArtifactPointer,
} from "../src/openclaw/artifact-generation.js";
import {
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  resolveOpenClawCrablineChannelDriverSelection,
  type CrablineServerManifest,
} from "../src/index.js";
import {
  acquireOpenClawCrablineSmokeRunLock,
  type OpenClawCrablineSmokeRunLock,
} from "../src/openclaw/smoke-lock.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const manifest: CrablineServerManifest = {
  adminToken: "crabline-admin-token",
  baseUrl: "http://127.0.0.1:1234",
  botToken: "424242:crabline-telegram-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:1234/crabline/telegram/inbound",
    apiRoot: "http://127.0.0.1:1234",
  },
  env: {
    TELEGRAM_BOT_TOKEN: "424242:crabline-telegram-token",
  },
  provider: "telegram",
  recorderPath: "/tmp/crabline/telegram.jsonl",
  version: 1,
};

function createLock(): OpenClawCrablineSmokeRunLock & {
  assertOwned: ReturnType<typeof vi.fn<() => Promise<void>>>;
  commitFileAtomically: ReturnType<
    typeof vi.fn<OpenClawCrablineSmokeRunLock["commitFileAtomically"]>
  >;
} {
  return {
    assertOwned: vi.fn(async () => undefined),
    commitFileAtomically: vi.fn(async ({ contents, destinationPath, stageFile }) => {
      await stageFile(destinationPath, contents);
    }),
    release: vi.fn(async () => undefined),
  };
}

function publishParams(outputDir: string, lock = createLock()) {
  return {
    capabilityReport: { result: { selectedChannel: "telegram" } },
    lock,
    manifest,
    outputDir,
    selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" }),
    smoke: { result: { ok: true, provider: "telegram" } },
  };
}

describe("OpenClaw artifact generation publication", () => {
  it("rejects caller-controlled artifact paths before creating the store", async () => {
    const outputDir = await createTempDir();
    const params = publishParams(outputDir);
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration({
          ...params,
          selection: {
            ...params.selection,
            capabilityMatrixPath: "../escaped.json",
          } as unknown as typeof params.selection,
        }),
      ).rejects.toThrow("OpenClaw Crabline artifact selection paths are malformed.");
      await expect(
        fs.access(path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("publishes one complete owner-only generation behind an atomic pointer", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    const syncedPaths: string[] = [];
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir, lock),
        {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
          platform: "linux",
          syncParent: async (filePath) => {
            syncedPaths.push(filePath);
          },
        },
      );

      expect(result).toMatchObject({
        generation: "generation-11111111-1111-4111-8111-111111111111",
        smoke: {
          manifestPath: result.manifestPath,
          result: { ok: true, provider: "telegram" },
        },
      });
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toEqual({
        capabilityMatrixPath: result.capabilityMatrixPath,
        generation: result.generation,
        manifestPath: result.manifestPath,
        smokeArtifactPath: result.smokeArtifactPath,
        version: 1,
      });
      for (const artifactPath of [
        result.manifestPath,
        result.capabilityMatrixPath,
        result.smokeArtifactPath,
      ]) {
        expect((await fs.stat(path.join(outputDir, artifactPath))).mode & 0o777).toBe(0o600);
      }
      expect(
        (
          await fs.stat(
            path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY, result.generation),
          )
        ).mode & 0o777,
      ).toBe(0o700);
      expect(lock.assertOwned).toHaveBeenCalledTimes(3);
      expect(lock.commitFileAtomically).toHaveBeenCalledTimes(1);
      expect(syncedPaths).toContain(
        path.join(
          outputDir,
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          "generation-11111111-1111-4111-8111-111111111111",
        ),
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("preserves a generation when pointer publication fails after the rename", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    const commitFailure = new Error("post-rename verification failed");
    lock.commitFileAtomically.mockImplementation(
      async ({ contents, destinationPath, stageFile }) => {
        await stageFile(destinationPath, contents);
        throw commitFailure;
      },
    );
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir, lock), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toBe(commitFailure);

      const pointer = await readOpenClawCrablineArtifactPointer(outputDir);
      expect(pointer?.generation).toBe("generation-11111111-1111-4111-8111-111111111111");
      await expect(fs.stat(path.join(outputDir, pointer!.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rolls back the installed generation when parent sync fails", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const generationPath = path.join(storePath, "generation-11111111-1111-4111-8111-111111111111");
    const syncFailure = new Error("directory sync failed");
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
          syncParent: async (filePath) => {
            if (filePath === generationPath) {
              throw syncFailure;
            }
          },
        }),
      ).rejects.toBe(syncFailure);

      await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(storePath)).resolves.toEqual([]);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("preserves a generation retained as a successor pointer rollback", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    const commitFailure = new Error("successor replaced the pointer");
    const successorGeneration = "generation-22222222-2222-4222-8222-222222222222";
    lock.commitFileAtomically.mockImplementation(
      async ({ contents, destinationPath, stageFile }) => {
        await stageFile(destinationPath, contents);
        const pointer = JSON.parse(contents) as Record<string, unknown>;
        const generation = String(pointer.generation);
        await fs.writeFile(
          destinationPath,
          `${JSON.stringify(
            {
              ...pointer,
              capabilityMatrixPath: String(pointer.capabilityMatrixPath).replace(
                generation,
                successorGeneration,
              ),
              generation: successorGeneration,
              manifestPath: String(pointer.manifestPath).replace(generation, successorGeneration),
              previousGeneration: generation,
              smokeArtifactPath: String(pointer.smokeArtifactPath).replace(
                generation,
                successorGeneration,
              ),
            },
            null,
            2,
          )}\n`,
        );
        throw commitFailure;
      },
    );
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir, lock), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toBe(commitFailure);

      const pointer = await readOpenClawCrablineArtifactPointer(outputDir);
      expect(pointer).toMatchObject({
        generation: successorGeneration,
        previousGeneration: "generation-11111111-1111-4111-8111-111111111111",
      });
      await expect(
        fs.stat(
          path.join(
            outputDir,
            OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
            pointer!.previousGeneration!,
          ),
        ),
      ).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("retains the committed generation when the pointer disappears before pruning", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    lock.commitFileAtomically.mockImplementation(
      async ({ contents, destinationPath, stageFile }) => {
        await stageFile(destinationPath, contents);
        await fs.rm(destinationPath);
      },
    );
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir, lock),
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );

      expect(result.warnings).toEqual([
        "OpenClaw Crabline artifact retention cleanup failed: OpenClaw Crabline artifact pointer is missing after publication.",
      ]);
      await expect(fs.stat(path.join(outputDir, result.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("fences an expired owner without touching a successor's uncommitted generation", async () => {
    const outputDir = await createTempDir();
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const successorGeneration = "generation-22222222-2222-4222-8222-222222222222";
    const successorGenerationPath = path.join(
      outputDir,
      OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
      successorGeneration,
    );
    let now = 1_000;
    let resumeSuccessor: (() => void) | undefined;
    let successorInstalled: (() => void) | undefined;
    const resumeSuccessorPromise = new Promise<void>((resolve) => {
      resumeSuccessor = resolve;
    });
    const successorInstalledPromise = new Promise<void>((resolve) => {
      successorInstalled = resolve;
    });
    const disableHeartbeat = () => ({
      assertHealthy() {},
      async settle() {},
      async stop() {},
    });
    let expiredLock: OpenClawCrablineSmokeRunLock | undefined;
    let successorLock: OpenClawCrablineSmokeRunLock | undefined;
    let successorPublication:
      | ReturnType<typeof publishOpenClawCrablineArtifactGeneration>
      | undefined;
    try {
      expiredLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 4_242,
          processStartedAtMs: 100,
          startHeartbeat: disableHeartbeat,
        },
      );

      now = 2_001;
      successorLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 5_252,
          processStartedAtMs: 200,
          startHeartbeat: disableHeartbeat,
        },
      );
      successorPublication = publishOpenClawCrablineArtifactGeneration(
        {
          capabilityReport: { result: { generation: "successor" } },
          lock: successorLock,
          manifest,
          outputDir,
          selection,
          smoke: { result: { generation: "successor" } },
        },
        {
          beforePointerSwitch: async () => {
            successorInstalled?.();
            await resumeSuccessorPromise;
          },
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        },
      );

      await successorInstalledPromise;
      await expect(fs.stat(successorGenerationPath)).resolves.toBeDefined();
      await expect(
        publishOpenClawCrablineArtifactGeneration(
          {
            capabilityReport: { result: { generation: "expired" } },
            lock: expiredLock,
            manifest,
            outputDir,
            selection,
            smoke: { result: { generation: "expired" } },
          },
          { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
        ),
      ).rejects.toThrow("OpenClaw Crabline smoke lock ownership was lost.");
      await expect(fs.stat(successorGenerationPath)).resolves.toBeDefined();

      resumeSuccessor?.();
      const successor = await successorPublication;
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: successor.generation,
      });
      await expect(fs.stat(path.join(outputDir, successor.manifestPath))).resolves.toBeDefined();
    } finally {
      resumeSuccessor?.();
      await successorPublication?.catch(() => undefined);
      await expiredLock?.release();
      await successorLock?.release();
      await disposeTempDir(outputDir);
    }
  });

  it("prevents an expired fenced owner from overwriting a successor pointer", async () => {
    const outputDir = await createTempDir();
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    let now = 1_000;
    let resumeOldOwner: (() => void) | undefined;
    let oldOwnerFenced: (() => void) | undefined;
    const resumeOldOwnerPromise = new Promise<void>((resolve) => {
      resumeOldOwner = resolve;
    });
    const oldOwnerFencedPromise = new Promise<void>((resolve) => {
      oldOwnerFenced = resolve;
    });
    const disableHeartbeat = () => ({
      assertHealthy() {},
      async settle() {},
      async stop() {},
    });
    let oldLock: OpenClawCrablineSmokeRunLock | undefined;
    let successorLock: OpenClawCrablineSmokeRunLock | undefined;
    try {
      oldLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          beforeCommitFileRename: async () => {
            oldOwnerFenced?.();
            await resumeOldOwnerPromise;
          },
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 4_242,
          processStartedAtMs: 100,
          startHeartbeat: disableHeartbeat,
        },
      );
      const oldPublication = publishOpenClawCrablineArtifactGeneration(
        {
          capabilityReport: { result: { generation: "old" } },
          lock: oldLock,
          manifest,
          outputDir,
          selection,
          smoke: { result: { generation: "old" } },
        },
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );

      await oldOwnerFencedPromise;
      now = 2_001;
      successorLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 5_252,
          processStartedAtMs: 200,
          startHeartbeat: disableHeartbeat,
        },
      );
      const successor = await publishOpenClawCrablineArtifactGeneration(
        {
          capabilityReport: { result: { generation: "successor" } },
          lock: successorLock,
          manifest,
          outputDir,
          selection,
          smoke: { result: { generation: "successor" } },
        },
        { createGenerationId: () => "22222222-2222-4222-8222-222222222222" },
      );

      resumeOldOwner?.();
      await expect(oldPublication).rejects.toThrow(
        "OpenClaw Crabline smoke lock ownership was lost.",
      );
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: successor.generation,
      });
    } finally {
      resumeOldOwner?.();
      await oldLock?.release();
      await successorLock?.release();
      await disposeTempDir(outputDir);
    }
  });

  it("keeps the prior generation visible until the single pointer switch", async () => {
    const outputDir = await createTempDir();
    let resumeSwitch: (() => void) | undefined;
    let switchStarted: (() => void) | undefined;
    const switchBlocked = new Promise<void>((resolve) => {
      resumeSwitch = resolve;
    });
    const atSwitch = new Promise<void>((resolve) => {
      switchStarted = resolve;
    });
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const secondPromise = publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        beforePointerSwitch: async () => {
          switchStarted?.();
          await switchBlocked;
        },
        createGenerationId: () => "22222222-2222-4222-8222-222222222222",
      });

      await atSwitch;
      const visibleBeforeSwitch = await readOpenClawCrablineArtifactPointer(outputDir);
      expect(visibleBeforeSwitch?.generation).toBe(first.generation);
      expect(
        JSON.parse(await fs.readFile(path.join(outputDir, first.manifestPath), "utf8")),
      ).toMatchObject({ provider: "telegram" });
      expect(
        await fs.stat(
          path.join(
            outputDir,
            OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
            "generation-22222222-2222-4222-8222-222222222222",
          ),
        ),
      ).toBeDefined();

      resumeSwitch?.();
      const second = await secondPromise;
      expect((await readOpenClawCrablineArtifactPointer(outputDir))?.generation).toBe(
        second.generation,
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("does not commit a pointer after the verified artifact store is replaced", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const displacedStorePath = `${storePath}.displaced`;
    let lock: OpenClawCrablineSmokeRunLock | undefined;
    try {
      lock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          beforeCommitFileRename: async () => {
            await fs.rename(storePath, displacedStorePath);
            await fs.mkdir(storePath, { mode: 0o700 });
          },
        },
      );

      await expect(
        publishOpenClawCrablineArtifactGeneration({
          capabilityReport: { result: { ok: true } },
          lock,
          manifest,
          outputDir,
          selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" }),
          smoke: { result: { ok: true } },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await expect(
        fs.access(path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(storePath)).resolves.toEqual([]);
    } finally {
      await lock?.release();
      await disposeTempDir(outputDir);
    }
  });

  it("removes failed staging and retains only the current and previous generations", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const abandonedGeneration = "generation-22222222-2222-4222-8222-222222222222";
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const publicationFailure = new Error("crash before pointer switch");
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          beforePointerSwitch: async () => {
            throw publicationFailure;
          },
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toBe(publicationFailure);
      await fs.mkdir(path.join(storePath, ".staging-33333333-3333-4333-8333-333333333333"), {
        mode: 0o700,
      });

      expect((await readOpenClawCrablineArtifactPointer(outputDir))?.generation).toBe(
        first.generation,
      );
      const third = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "44444444-4444-4444-8444-444444444444",
      });

      await expect(fs.stat(path.join(storePath, abandonedGeneration))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(storePath, ".staging-33333333-3333-4333-8333-333333333333")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readOpenClawCrablineArtifactPointer(outputDir))?.generation).toBe(
        third.generation,
      );

      const fourth = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "55555555-5555-4555-8555-555555555555",
      });
      await expect(fs.stat(path.join(storePath, first.generation))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(storePath, third.generation))).resolves.toBeDefined();
      await expect(fs.stat(path.join(storePath, fourth.generation))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("removes staging when artifact serialization fails", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(
          {
            ...publishParams(outputDir),
            capabilityReport: { unsupported: 1n },
          },
          { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
        ),
      ).rejects.toThrow(/BigInt/u);
      await expect(fs.readdir(storePath)).resolves.toEqual([]);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("preserves publication and rollback cleanup failures", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const generation = "generation-11111111-1111-4111-8111-111111111111";
    const generationPath = path.join(storePath, generation);
    const displacedPath = `${generationPath}.displaced`;
    const publicationError = new Error("pointer switch failed");
    try {
      const failure = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        beforePointerSwitch: async () => {
          await fs.rename(generationPath, displacedPath);
          await fs.mkdir(generationPath);
          throw publicationError;
        },
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBe(publicationError);
      expect((failure as AggregateError).errors[1]).toBeInstanceOf(Error);
      await expect(fs.stat(generationPath)).resolves.toBeDefined();
      await expect(fs.stat(displacedPath)).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("establishes the Windows directory ACL before creating sensitive files", async () => {
    const outputDir = await createTempDir();
    const events: string[] = [];
    const securedDirectories = new Set<string>();
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        platform: "win32",
        secureWindowsDirectory: async (directoryPath) => {
          events.push(`directory:${path.basename(directoryPath)}`);
          expect(await fs.readdir(directoryPath)).toEqual([]);
          securedDirectories.add(directoryPath);
        },
        secureWindowsFile: async (filePath) => {
          events.push(`file:${path.basename(filePath)}`);
          expect(securedDirectories.has(path.dirname(filePath))).toBe(true);
          expect(await fs.readFile(filePath, "utf8")).toBe("");
        },
      });

      expect(events[0]).toBe(`directory:${OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY}`);
      expect(events[1]).toBe("directory:.staging-11111111-1111-4111-8111-111111111111");
      expect(events.filter((event) => event.startsWith("file:"))).toHaveLength(4);
      expect(await fs.readFile(path.join(outputDir, result.manifestPath), "utf8")).toContain(
        "crabline-admin-token",
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });
});
