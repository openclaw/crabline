import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireOpenClawCrablineSmokeRunLock,
  releaseOpenClawCrablineSmokeRunLock,
} from "../src/openclaw/smoke-lock.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

describe("OpenClaw smoke lock cleanup", () => {
  it("retries release with bounded backoff before unwinding", async () => {
    const releaseError = new Error("transient removal failure");
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(releaseError)
      .mockRejectedValueOnce(releaseError)
      .mockResolvedValueOnce();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    await expect(
      releaseOpenClawCrablineSmokeRunLock({ release }, { sleep }),
    ).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("stops retrying after the bounded release attempts", async () => {
    const releaseError = new Error("persistent removal failure");
    const release = vi.fn(async () => {
      throw releaseError;
    });
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    await expect(releaseOpenClawCrablineSmokeRunLock({ release }, { sleep })).rejects.toBe(
      releaseError,
    );

    expect(release).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("retries release after a transient removal failure", async () => {
    const outputDir = await createTempDir();
    try {
      const removalError = new Error("transient removal failure");
      let failRemoval = true;
      const removeDirectory = vi.fn(async (lockDirectory: string) => {
        if (failRemoval) {
          failRemoval = false;
          throw removalError;
        }
        await fs.rm(lockDirectory, { force: true, recursive: true });
      });
      const params = { channel: "telegram" as const, outputDir };
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, { removeDirectory });

      await expect(lock.release()).rejects.toBe(removalError);
      await expect(acquireOpenClawCrablineSmokeRunLock(params)).rejects.toThrow(
        `OpenClaw Crabline smoke is already running for channel "telegram" in "${path.resolve(outputDir)}"`,
      );

      await expect(lock.release()).resolves.toBeUndefined();
      expect(removeDirectory).toHaveBeenCalledTimes(2);

      const nextLock = await acquireOpenClawCrablineSmokeRunLock(params);
      await expect(nextLock.release()).resolves.toBeUndefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("reclaims a live PID lock when the acquiring process has a new start identity", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    try {
      const firstLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        now: () => 1_000,
        pid: 4_242,
        processStartedAtMs: 100,
      });
      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        now: () => 1_100,
        pid: 4_242,
        processStartedAtMs: 200,
      });

      await firstLock.release();
      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          now: () => 1_200,
          pid: 4_242,
          processStartedAtMs: 200,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("expires an old lock whose PID now belongs to another live process", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    try {
      const firstLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => 1_000,
        pid: 4_242,
        processStartedAtMs: 100,
      });

      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => 1_999,
          pid: 5_252,
          processStartedAtMs: 200,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");

      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => 2_001,
        pid: 5_252,
        processStartedAtMs: 200,
      });
      await firstLock.release();
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });
});
