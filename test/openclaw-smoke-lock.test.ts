import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireOpenClawCrablineSmokeRunLock,
  darwinProcessIdentityEnvironment,
  processIdentityFromDarwin,
  processIdentityFromLinuxStat,
  releaseOpenClawCrablineSmokeRunLock,
} from "../src/openclaw/smoke-lock.js";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "../src/openclaw/shared.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const disableHeartbeat = (_renew: () => Promise<void>, _intervalMs: number) => ({
  assertHealthy() {},
  async settle() {},
  async stop() {},
});

describe("OpenClaw smoke lock cleanup", () => {
  it("extracts the exact Linux process start token", () => {
    expect(
      processIdentityFromLinuxStat(
        "4242 (command with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 123456",
        "01234567-89ab-cdef-0123-456789abcdef",
      ),
    ).toBe("linux:01234567-89ab-cdef-0123-456789abcdef:123456");
    expect(processIdentityFromLinuxStat("malformed", "not-a-boot-id")).toBeNull();
  });

  it("combines Darwin boot and process start identities", () => {
    expect(
      processIdentityFromDarwin(
        "Sun Jul 12 16:04:00 2026",
        "{ sec = 1783864000, usec = 123456 } Sun Jul 12 15:46:40 2026",
      ),
    ).toBe("darwin:1783864000.123456:Sun Jul 12 16:04:00 2026");
    expect(processIdentityFromDarwin("", "{ sec = 1, usec = 2 }")).toBeNull();
  });

  it("uses a canonical environment for Darwin process start times", () => {
    const environment = { LC_ALL: "fr_FR.UTF-8", TZ: "Europe/Paris", UNRELATED: "preserved" };

    expect(darwinProcessIdentityEnvironment(environment)).toEqual({
      LC_ALL: "C",
      TZ: "UTC",
      UNRELATED: "preserved",
    });
    expect(environment).toEqual({
      LC_ALL: "fr_FR.UTF-8",
      TZ: "Europe/Paris",
      UNRELATED: "preserved",
    });
  });

  it("secures an empty Windows lock directory before writing sensitive contents", async () => {
    const outputDir = await createTempDir();
    const destinationPath = path.join(outputDir, "current.json");
    const events: string[] = [];
    try {
      const secureWindowsDirectory = vi.fn(async (directoryPath: string) => {
        events.push("secure");
        expect(await fs.readdir(directoryPath)).toEqual([]);
      });
      const lock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          now: () => 1_000,
          pid: 4_242,
          platform: "win32",
          processStartedAtMs: 100,
          secureWindowsDirectory,
          startHeartbeat: disableHeartbeat,
        },
      );

      const lockDirectory = path.join(
        path.resolve(outputDir),
        `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
      );
      expect(await fs.readdir(lockDirectory)).toEqual(expect.arrayContaining(["owner.json"]));

      await lock.commitFileAtomically({
        contents: "private\n",
        destinationPath,
        stageFile: async (filePath, contents) => {
          events.push("stage");
          expect(events).toEqual(["secure", "stage"]);
          await fs.writeFile(filePath, contents);
        },
      });

      expect(secureWindowsDirectory).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["secure", "stage"]);
      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("private\n");
      await lock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("fails closed before writing Windows lock contents when directory security fails", async () => {
    const outputDir = await createTempDir();
    const aclError = new Error("ACL unavailable");
    try {
      await expect(
        acquireOpenClawCrablineSmokeRunLock(
          { channel: "telegram", outputDir },
          {
            now: () => 1_000,
            pid: 4_242,
            platform: "win32",
            processStartedAtMs: 100,
            secureWindowsDirectory: async (directoryPath) => {
              expect(await fs.readdir(directoryPath)).toEqual([]);
              throw aclError;
            },
            startHeartbeat: disableHeartbeat,
          },
        ),
      ).rejects.toBe(aclError);

      expect(
        (await fs.readdir(outputDir)).filter((entry) =>
          entry.includes(`.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`),
        ),
      ).toEqual([]);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects a Windows lock candidate replaced after owner metadata is written", async () => {
    const outputDir = await createTempDir();
    let displacedPath = "";
    try {
      await expect(
        acquireOpenClawCrablineSmokeRunLock(
          { channel: "telegram", outputDir },
          {
            afterLockOwnerWrite: async (candidateDirectory) => {
              displacedPath = `${candidateDirectory}.displaced`;
              await fs.rename(candidateDirectory, displacedPath);
              await fs.mkdir(candidateDirectory);
            },
            now: () => 1_000,
            pid: 4_242,
            platform: "win32",
            processStartedAtMs: 100,
            secureWindowsDirectory: async () => undefined,
            startHeartbeat: disableHeartbeat,
          },
        ),
      ).rejects.toThrow("Private directory path identity changed during publication.");

      await expect(fs.readdir(displacedPath)).resolves.toEqual(["owner.json"]);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects a Windows lock candidate replaced after installation", async () => {
    const outputDir = await createTempDir();
    let displacedPath = "";
    try {
      await expect(
        acquireOpenClawCrablineSmokeRunLock(
          { channel: "telegram", outputDir },
          {
            afterLockCandidateInstall: async (lockDirectory) => {
              displacedPath = `${lockDirectory}.displaced`;
              await fs.rename(lockDirectory, displacedPath);
              await fs.mkdir(lockDirectory);
            },
            now: () => 1_000,
            pid: 4_242,
            platform: "win32",
            processStartedAtMs: 100,
            secureWindowsDirectory: async () => undefined,
            startHeartbeat: disableHeartbeat,
          },
        ),
      ).rejects.toThrow("Private directory path identity changed during publication.");

      await expect(fs.readdir(displacedPath)).resolves.toEqual(
        expect.arrayContaining(["owner.json"]),
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });

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
        processIdentity: "test:first",
        processStartedAtMs: 100,
      });
      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        now: () => 1_100,
        pid: 4_242,
        processIdentity: "test:second",
        processStartedAtMs: 200,
      });

      await firstLock.release();
      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          now: () => 1_200,
          pid: 4_242,
          processIdentity: "test:second",
          processStartedAtMs: 200,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("reclaims a timestamp-only lock when its PID is reused by the acquiring process", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    try {
      const firstLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        now: () => 1_000,
        pid: 4_242,
        processIdentity: null,
        processStartedAtMs: 100,
      });
      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        isProcessAlive: () => true,
        now: () => 1_100,
        pid: 4_242,
        processIdentity: null,
        processStartedAtMs: 200,
      });

      await firstLock.release();
      await expect(replacementLock.assertOwned()).resolves.toBeUndefined();
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
      await fs.utimes(path.join(lockDirectory, "owner.json"), new Date(1_000), new Date(1_000));

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
          processIdentity: "test:prior",
          processStartedAtMs: 100,
          token: "prior",
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          getProcessIdentity: () => "test:prior",
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

  it("reclaims a dead pre-heartbeat owner when its start time is unavailable", async () => {
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

      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        getProcessIdentity: () => null,
        isProcessAlive: () => false,
        leaseMs: 1_000,
        now: () => 1_100,
        pid: 5_252,
        processStartedAtMs: 200,
      });

      await expect(replacementLock.assertOwned()).resolves.toBeUndefined();
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("reclaims a pre-heartbeat lock after its PID is reused", async () => {
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
          processIdentity: "test:prior",
          processStartedAtMs: 100,
          token: "prior",
        })}\n`,
        { mode: 0o600 },
      );

      const replacementLock = await acquireOpenClawCrablineSmokeRunLock(params, {
        getProcessIdentity: () => "test:replacement",
        isProcessAlive: () => true,
        leaseMs: 1_000,
        now: () => 1_100,
        pid: 5_252,
        processStartedAtMs: 200,
      });

      await expect(replacementLock.assertOwned()).resolves.toBeUndefined();
      await replacementLock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("keeps an expired legacy lock while its PID is still alive", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    const ownerPath = path.join(lockDirectory, "owner.json");
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({
          channel: "telegram",
          pid: 4_242,
          token: "legacy",
        })}\n`,
        { mode: 0o600 },
      );
      await fs.utimes(ownerPath, new Date(1_000), new Date(1_000));

      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => 3_001,
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
          return { assertHealthy() {}, settle: async () => undefined, stop };
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

  it("restores a stale commit claim when its owner renews before deletion", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const destinationPath = path.join(outputDir, "current.json");
    let allowCommit: (() => void) | undefined;
    let commitClaimed: (() => void) | undefined;
    let renew: (() => Promise<void>) | undefined;
    const allowCommitPromise = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const commitClaimedPromise = new Promise<void>((resolve) => {
      commitClaimed = resolve;
    });
    let now = 1_000;
    let commitPromise: Promise<void> | undefined;
    try {
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, {
        beforeCommitFileRename: async () => {
          commitClaimed?.();
          await allowCommitPromise;
        },
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
      commitPromise = lock.commitFileAtomically({
        contents: "{}\n",
        destinationPath,
        stageFile: async (filePath, contents) => {
          await fs.writeFile(filePath, contents);
        },
      });
      await commitClaimedPromise;

      now = 2_001;
      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          beforeRecoveryDeleteClaim: async () => {
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

      const lockClaims = (await fs.readdir(outputDir)).filter((entry) => entry.includes(".lock."));
      expect(lockClaims.filter((entry) => entry.includes(".commit."))).toHaveLength(1);
      expect(lockClaims.filter((entry) => entry.includes(".release."))).toEqual([]);

      allowCommit?.();
      await expect(commitPromise).resolves.toBeUndefined();
      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("{}\n");
      await lock.release();
    } finally {
      allowCommit?.();
      await commitPromise?.catch(() => undefined);
      await disposeTempDir(outputDir);
    }
  });

  it("revokes an expired commit stage before a successor publishes", async () => {
    const outputDir = await createTempDir();
    const stageDirectory = path.join(outputDir, "artifacts");
    const destinationPath = path.join(stageDirectory, "current.json");
    let allowOldCommit: (() => void) | undefined;
    let oldCommitReady: (() => void) | undefined;
    const allowOldCommitPromise = new Promise<void>((resolve) => {
      allowOldCommit = resolve;
    });
    const oldCommitReadyPromise = new Promise<void>((resolve) => {
      oldCommitReady = resolve;
    });
    let now = 1_000;
    let oldCommit: Promise<void> | undefined;
    try {
      await fs.mkdir(stageDirectory);
      const oldLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          beforeCommitRename: async () => {
            oldCommitReady?.();
            await allowOldCommitPromise;
          },
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 4_242,
          processStartedAtMs: 100,
          startHeartbeat: disableHeartbeat,
        },
      );
      oldCommit = oldLock.commitFileAtomically({
        contents: "old\n",
        destinationPath,
        stageDirectory,
        stageFile: async (filePath, contents) => {
          await fs.writeFile(filePath, contents);
        },
      });
      await oldCommitReadyPromise;

      now = 2_001;
      const successorLock = await acquireOpenClawCrablineSmokeRunLock(
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
      await successorLock.commitFileAtomically({
        contents: "successor\n",
        destinationPath,
        stageDirectory,
        stageFile: async (filePath, contents) => {
          await fs.writeFile(filePath, contents);
        },
      });

      allowOldCommit?.();
      await expect(oldCommit).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("successor\n");
      await oldLock.release();
      await successorLock.release();
    } finally {
      allowOldCommit?.();
      await oldCommit?.catch(() => undefined);
      await disposeTempDir(outputDir);
    }
  });

  it("replaces its token-specific stage record when retrying before the commit claim", async () => {
    const outputDir = await createTempDir();
    const stageDirectory = path.join(outputDir, "artifacts");
    const destinationPath = path.join(stageDirectory, "current.json");
    let failCommitClaim = true;
    try {
      await fs.mkdir(stageDirectory);
      const lock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          beforeCommitClaim: async () => {
            if (failCommitClaim) {
              failCommitClaim = false;
              throw new Error("injected pre-claim failure");
            }
          },
          startHeartbeat: disableHeartbeat,
        },
      );
      const commit = (contents: string) =>
        lock.commitFileAtomically({
          contents,
          destinationPath,
          stageDirectory,
          stageFile: async (filePath, value) => {
            await fs.writeFile(filePath, value);
          },
        });

      await expect(commit("first\n")).rejects.toThrow("injected pre-claim failure");
      await expect(commit("second\n")).resolves.toBeUndefined();
      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("second\n");
      await lock.release();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("ignores an interrupted temporary stage record while recovering an expired lock", async () => {
    const outputDir = await createTempDir();
    const lockDirectory = path.join(
      path.resolve(outputDir),
      `.${OPENCLAW_CRABLINE_MANIFEST_PATH}.lock`,
    );
    let now = 1_000;
    try {
      const expiredLock = await acquireOpenClawCrablineSmokeRunLock(
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
      const owner = JSON.parse(await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"));
      await fs.writeFile(
        path.join(lockDirectory, `.commit-stage.${owner.token}.interrupted.tmp`),
        "{",
      );

      now = 2_001;
      const successorLock = await acquireOpenClawCrablineSmokeRunLock(
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

      expect(
        (await fs.readdir(lockDirectory)).some((entry) => entry.endsWith(".interrupted.tmp")),
      ).toBe(false);
      await successorLock.release();
      await expiredLock.release();
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

  it("does not reclaim a live owner after a forward clock jump when its heartbeat advances", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    let now = 1_000;
    let renew: (() => Promise<void>) | undefined;
    try {
      const firstLock = await acquireOpenClawCrablineSmokeRunLock(params, {
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

      now = 100_000;
      await expect(
        acquireOpenClawCrablineSmokeRunLock(params, {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 5_252,
          processStartedAtMs: 200,
          sleep: async () => {
            await renew!();
          },
          startHeartbeat: disableHeartbeat,
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke is already running");

      await firstLock.release();
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

  it("rejects a pointer commit when a pending final renewal fails during heartbeat drain", async () => {
    const outputDir = await createTempDir();
    const params = { channel: "telegram" as const, outputDir };
    const destinationPath = path.join(outputDir, "current.json");
    let allowScheduledRenewal: (() => void) | undefined;
    let startScheduledRenewal: (() => void) | undefined;
    const scheduledRenewalGate = new Promise<void>((resolve) => {
      allowScheduledRenewal = resolve;
    });
    try {
      const lock = await acquireOpenClawCrablineSmokeRunLock(params, {
        beforeCommitFileRename: async () => {
          startScheduledRenewal?.();
        },
        startHeartbeat: (renew) => {
          let failure: unknown;
          let pending: Promise<void> | undefined;
          let settled = false;
          startScheduledRenewal = () => {
            pending = scheduledRenewalGate.then(renew).catch((error: unknown) => {
              failure ??= error;
            });
          };
          return {
            assertHealthy() {
              if (failure !== undefined) {
                throw new Error("OpenClaw Crabline smoke lock heartbeat failed.", {
                  cause: failure,
                });
              }
            },
            async settle() {
              if (!settled) {
                settled = true;
                const commitClaim = (await fs.readdir(outputDir)).find((entry) =>
                  entry.includes(".lock.commit."),
                );
                expect(commitClaim).toBeDefined();
                const ownerPath = path.join(outputDir, commitClaim!, "owner.json");
                const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
                await fs.writeFile(
                  ownerPath,
                  `${JSON.stringify({ ...owner, token: "replacement-owner" })}\n`,
                );
                allowScheduledRenewal?.();
              }
              await pending;
            },
            async stop() {
              await pending;
            },
          };
        },
      });

      await expect(
        lock.commitFileAtomically({
          contents: "{}\n",
          destinationPath,
          stageFile: async (filePath, contents) => {
            await fs.writeFile(filePath, contents);
          },
        }),
      ).rejects.toThrow("OpenClaw Crabline smoke lock heartbeat failed.");
      await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      await lock.release();
    } finally {
      allowScheduledRenewal?.();
      await disposeTempDir(outputDir);
    }
  });
});
