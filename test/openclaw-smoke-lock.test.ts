import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireOpenClawCrablineSmokeRunLock,
  releaseOpenClawCrablineSmokeRunLock,
} from "../src/openclaw/smoke-lock.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "../src/openclaw/shared.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const disableHeartbeat = (_renew: () => Promise<void>, _intervalMs: number) => ({
  assertHealthy() {},
  async stop() {},
});

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

  it("does not delete a successor lock when a paused owner resumes release", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    const suspendedOwnerDirectory = `${lockDirectory}.suspended-owner`;
    let resumeRelease: (() => void) | undefined;
    let releaseValidated: (() => void) | undefined;
    const resumeReleasePromise = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    const releaseValidatedPromise = new Promise<void>((resolve) => {
      releaseValidated = resolve;
    });
    let successorLock: Awaited<ReturnType<typeof acquireOpenClawCrablineSmokeRunLock>> | undefined;
    try {
      const oldLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        beforeReleaseClaim: async () => {
          releaseValidated?.();
          await resumeReleasePromise;
        },
        startHeartbeat: disableHeartbeat,
      });
      const oldRelease = oldLock.release();
      await releaseValidatedPromise;

      await fs.rename(lockDirectory, suspendedOwnerDirectory);
      successorLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        startHeartbeat: disableHeartbeat,
      });
      resumeRelease?.();

      await expect(oldRelease).resolves.toBeUndefined();
      await expect(successorLock.assertOwned()).resolves.toBeUndefined();
      expect(await fs.stat(lockDirectory)).toBeDefined();
    } finally {
      resumeRelease?.();
      await successorLock?.release();
      await fs.rm(suspendedOwnerDirectory, { force: true, recursive: true });
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

  it("keeps an active legacy-format lock owned by its live PID", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    let legacyOwnerAlive = true;
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDirectory, "owner.json"),
        `${JSON.stringify({
          channel: "telegram",
          pid: 4_242,
          token: "legacy",
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => legacyOwnerAlive,
          now: () => 2_000,
          pid: 5_252,
          processStartedAtMs: 200,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");

      legacyOwnerAlive = false;
      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => legacyOwnerAlive,
        now: () => 2_000,
        pid: 5_252,
        processStartedAtMs: 200,
      });
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("keeps an active pre-heartbeat owner beyond its original lease age", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDirectory, "owner.json"),
        `${JSON.stringify({
          channel: "telegram",
          createdAtMs: 1_000,
          pid: 4_242,
          processStartedAtMs: 100,
          token: "prior",
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => 10_000,
          pid: 5_252,
          processStartedAtMs: 200,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("does not renew a lock after a recovery claimant moves it", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    const recoveryDirectory = `${lockDirectory}.recovering.11111111-1111-4111-8111-111111111111`;
    let now = 1_000;
    let renew: (() => Promise<void>) | undefined;
    const stop = vi.fn(async () => undefined);
    try {
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => now,
        pid: 4_242,
        processStartedAtMs: 100,
        startHeartbeat: (heartbeat, intervalMs) => {
          expect(intervalMs).toBe(333);
          renew = heartbeat;
          return { assertHealthy() {}, stop };
        },
      });

      now = 1_800;
      await renew!();
      await fs.rename(lockDirectory, recoveryDirectory);
      now = 2_600;
      await expect(renew!()).rejects.toThrow("smoke lock ownership was lost");
      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => 2_600,
          pid: 5_252,
          processStartedAtMs: 200,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");

      expect(await fs.stat(lockDirectory)).toBeDefined();
      await expect(fs.stat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(outputDir)).filter((entry) => entry.includes(".recovering")),
      ).toEqual([]);
      await lock.release();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("revalidates a stale owner after claiming recovery before deletion", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    const recoveryDirectory = `${lockDirectory}.recovering`;
    let now = 1_000;
    let renew: (() => Promise<void>) | undefined;
    try {
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => now,
        pid: 4_242,
        processStartedAtMs: 100,
        startHeartbeat: (heartbeat) => {
          renew = heartbeat;
          return disableHeartbeat(heartbeat, 333);
        },
      });

      now = 2_001;
      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          beforeRecoveryClaim: async () => {
            now = 1_999;
            await renew!();
            now = 2_001;
          },
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 5_252,
          processStartedAtMs: 200,
          startHeartbeat: disableHeartbeat,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");

      expect(await fs.stat(lockDirectory)).toBeDefined();
      await expect(fs.stat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(outputDir)).filter((entry) => entry.includes(".recovering")),
      ).toEqual([]);
      await lock.release();
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
        startHeartbeat: disableHeartbeat,
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
        startHeartbeat: disableHeartbeat,
      });
      expect(replacementLock).toBeDefined();
      await firstLock.release();
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("expires a far-future heartbeat whose PID belongs to another live process", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    try {
      const firstLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => 1_000,
        pid: 4_242,
        processStartedAtMs: 100,
        startHeartbeat: disableHeartbeat,
      });
      const future = new Date(10_000);
      await fs.utimes(path.join(lockDirectory, "owner.json"), future, future);

      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => 2_000,
        pid: 5_252,
        processStartedAtMs: 200,
        startHeartbeat: disableHeartbeat,
      });
      expect(replacementLock).toBeDefined();
      await firstLock.release();
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("retries strict owner parsing failures during release", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const ownerPath = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
      "owner.json",
    );
    try {
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, {
        startHeartbeat: disableHeartbeat,
      });
      const owner = await fs.readFile(ownerPath, "utf8");
      await fs.writeFile(ownerPath, "not json\n");
      const sleep = vi.fn(async () => {
        await fs.writeFile(ownerPath, owner);
      });

      await expect(releaseOpenClawCrablineSmokeRunLock(lock, { sleep })).resolves.toBeUndefined();
      expect(sleep).toHaveBeenCalledTimes(1);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("fails pointer fencing after a heartbeat renewal error", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const ownerPath = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
      "owner.json",
    );
    try {
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, {
        leaseMs: 30,
      });
      const owner = await fs.readFile(ownerPath, "utf8");
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({ ...JSON.parse(owner), token: "replacement-owner" })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));

      await expect(
        lock.commitFileAtomically({
          contents: "{}\n",
          destinationPath: path.join(outputDir, "current.json"),
          stageFile: async (filePath, contents) => {
            await fs.writeFile(filePath, contents);
          },
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke lock heartbeat failed.");

      await fs.writeFile(ownerPath, owner);
      await expect(lock.release()).resolves.toBeUndefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });
});
