import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireOpenClawCrablineSmokeRunLock } from "../src/openclaw/smoke-lock.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

describe("OpenClaw smoke lock cleanup", () => {
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
});
