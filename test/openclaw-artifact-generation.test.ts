import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  publishOpenClawCrablineArtifactGeneration,
  readOpenClawCrablineArtifactPointer,
} from "../src/openclaw/artifact-generation.js";
import {
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  resolveOpenClawCrablineChannelDriverSelection,
  type CrablineServerManifest,
} from "../src/index.js";
import type { OpenClawCrablineSmokeRunLock } from "../src/openclaw/smoke-lock.js";
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
  prepareForRelease: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    assertOwned: vi.fn(async () => undefined),
    prepareForRelease: vi.fn(async () => undefined),
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
  it("publishes one complete owner-only generation behind an atomic pointer", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir, lock),
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111", platform: "linux" },
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
      expect(lock.assertOwned).toHaveBeenCalledTimes(2);
      expect(lock.prepareForRelease).toHaveBeenCalledTimes(1);
    } finally {
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

  it("recovers abandoned staging and installed-but-uncommitted generations", async () => {
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
