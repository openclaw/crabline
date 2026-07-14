import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyOwnerOnlyWindowsDirectoryAcl,
  createOwnerOnlyWindowsDirectoryAncestry,
  createOwnerOnlyWindowsFile,
  publishPrivateFileAtomically,
  removeSecuredPrivateDirectory,
  securePrivateDirectory,
  verifyOwnerOnlyWindowsDirectoryAcl,
  verifyOwnerOnlyWindowsFileAcl,
  verifySafeWindowsDirectoryEntryParent,
  verifySafeWindowsDirectoryMutationBoundary,
  type WindowsAclRunner,
} from "../src/openclaw/private-file.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const currentEffectiveUserId = process.geteuid?.();

function expectedAncestrySyncPaths(filePath: string, syncThroughPath?: string): string[] {
  const paths: string[] = [];
  let currentPath = path.resolve(filePath);
  const resolvedSyncThroughPath =
    syncThroughPath === undefined ? undefined : path.resolve(syncThroughPath);
  for (;;) {
    paths.push(currentPath);
    if (currentPath === resolvedSyncThroughPath) {
      return paths;
    }
    const parentPath = path.dirname(currentPath);
    if (path.dirname(parentPath) === parentPath) {
      return paths;
    }
    currentPath = parentPath;
  }
}

describe("OpenClaw private file publication", () => {
  it.skipIf(process.platform === "win32")(
    "replaces permissive POSIX files with mode 0600",
    async () => {
      const directory = await createTempDir();
      try {
        const filePath = path.join(directory, "manifest.json");
        await fs.writeFile(filePath, "stale\n", { mode: 0o666 });
        await fs.chmod(filePath, 0o666);

        await publishPrivateFileAtomically(filePath, "private\n", { platform: "linux" });

        expect(await fs.readFile(filePath, "utf8")).toBe("private\n");
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "secures POSIX generation directories with mode 0700",
    async () => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        await fs.mkdir(generationPath, { mode: 0o777 });
        await fs.chmod(generationPath, 0o777);

        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });

        await secured.assertIdentityAt();
        expect((await fs.stat(generationPath)).mode & 0o777).toBe(0o700);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates every POSIX publication ancestor with mode 0700 under a permissive umask",
    async () => {
      const directory = await createTempDir();
      const previousUmask = process.umask(0);
      try {
        const firstParent = path.join(directory, "first");
        const finalParent = path.join(firstParent, "nested");
        const filePath = path.join(finalParent, "manifest.json");

        await publishPrivateFileAtomically(filePath, "private\n", { platform: "linux" });

        expect((await fs.stat(firstParent)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(firstParent)).mode & 0o1000).toBe(0o1000);
        expect((await fs.stat(finalParent)).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(previousUmask);
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects missing publication ancestry beneath an unsafe writable boundary",
    async () => {
      const directory = await createTempDir();
      try {
        await fs.chmod(directory, 0o777);
        const filePath = path.join(directory, "nested", "manifest.json");

        await expect(publishPrivateFileAtomically(filePath, "private\n")).rejects.toThrow(
          "Private mutation boundary is writable by another POSIX principal.",
        );

        await expect(fs.stat(path.dirname(filePath))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.chmod(directory, 0o700);
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a private mutation boundary beneath a replaceable ancestor",
    async () => {
      const directory = await createTempDir();
      try {
        const sharedParent = path.join(directory, "shared");
        const privateParent = path.join(sharedParent, "private");
        const publicationParent = path.join(privateParent, "generation");
        await fs.mkdir(publicationParent, { recursive: true, mode: 0o700 });
        await fs.chmod(sharedParent, 0o777);
        await fs.chmod(privateParent, 0o700);
        await fs.chmod(publicationParent, 0o755);

        await expect(
          publishPrivateFileAtomically(path.join(publicationParent, "manifest.json"), "private\n"),
        ).rejects.toThrow("Private mutation boundary is writable by another POSIX principal.");

        await expect(fs.stat(path.join(publicationParent, "manifest.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await fs.stat(publicationParent)).mode & 0o777).toBe(0o755);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(
    process.platform === "win32" ||
      currentEffectiveUserId === undefined ||
      currentEffectiveUserId === 0,
  )("rejects recursive removal beneath a directory owned by another user", async () => {
    const directory = await createTempDir();
    const targetPath = path.join(directory, "generation");
    await fs.mkdir(targetPath, { mode: 0o700 });
    const secured = await securePrivateDirectory(targetPath);
    const geteuidSpy = vi
      .spyOn(process, "geteuid")
      .mockReturnValue((currentEffectiveUserId ?? 0) + 1);
    try {
      await expect(removeSecuredPrivateDirectory(secured)).rejects.toThrow(
        "Private mutation boundary is not owned by the current POSIX user or root.",
      );

      await expect(fs.stat(targetPath)).resolves.toBeDefined();
    } finally {
      geteuidSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "syncs a POSIX directory handle after persisting mode 0700",
    async () => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        const events: string[] = [];
        await fs.mkdir(generationPath, { mode: 0o777 });
        await fs.chmod(generationPath, 0o777);

        await securePrivateDirectory(generationPath, {
          platform: "linux",
          syncDirectory: async () => {
            events.push("directory");
            expect((await fs.stat(generationPath)).mode & 0o777).toBe(0o700);
          },
          syncParent: async () => {
            events.push("parent");
          },
        });

        expect(events).toEqual(["directory", "parent"]);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "resyncs an existing private directory after an interrupted creation",
    async () => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        const syncFailure = new Error("simulated parent sync interruption");
        const syncParent = vi
          .fn<(filePath: string, platform?: NodeJS.Platform) => Promise<void>>()
          .mockRejectedValueOnce(syncFailure)
          .mockResolvedValueOnce();
        await fs.mkdir(generationPath, { mode: 0o700 });

        await expect(
          securePrivateDirectory(generationPath, { platform: "linux", syncParent }),
        ).rejects.toBe(syncFailure);
        await expect(fs.stat(generationPath)).resolves.toBeDefined();

        const secured = await securePrivateDirectory(generationPath, {
          platform: "linux",
          syncParent,
        });

        await secured.assertIdentityAt();
        expect(syncParent.mock.calls).toEqual([
          [generationPath, "linux"],
          [generationPath, "linux"],
        ]);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["EACCES", "EPERM"] as const)(
    "accepts an existing private directory below a parent that rejects fsync with %s",
    async (code) => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        const syncParent = vi.fn(async () => {
          throw Object.assign(new Error("inaccessible parent"), { code });
        });
        await fs.mkdir(generationPath, { mode: 0o700 });

        const secured = await securePrivateDirectory(generationPath, {
          platform: "linux",
          syncParent,
        });

        await secured.assertIdentityAt();
        expect(syncParent).toHaveBeenCalledWith(generationPath, "linux");
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["EACCES", "EPERM"] as const)(
    "rolls back a newly created private directory when parent fsync fails with %s",
    async (code) => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        const syncFailure = Object.assign(new Error("parent sync denied"), { code });

        await expect(
          securePrivateDirectory(generationPath, {
            platform: "linux",
            syncParent: async () => {
              throw syncFailure;
            },
          }),
        ).rejects.toBe(syncFailure);

        await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readdir(directory)).resolves.toEqual([]);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects POSIX private directories not owned by the current user",
    async () => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        await fs.mkdir(generationPath, { mode: 0o777 });
        await fs.chmod(generationPath, 0o777);
        const currentUserId = process.geteuid?.();
        if (currentUserId === undefined) {
          throw new Error("POSIX effective user id is unavailable.");
        }

        await expect(
          securePrivateDirectory(generationPath, {
            currentUserId: currentUserId + 1,
            platform: "linux",
          }),
        ).rejects.toThrow("Private directory must be owned by the current POSIX user.");

        expect((await fs.stat(generationPath)).mode & 0o777).toBe(0o777);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked POSIX directory before changing target permissions",
    async () => {
      const directory = await createTempDir();
      try {
        const targetPath = path.join(directory, "target");
        const generationPath = path.join(directory, "generation");
        await fs.mkdir(targetPath);
        await fs.chmod(targetPath, 0o777);
        await fs.symlink(targetPath, generationPath);

        await expect(securePrivateDirectory(generationPath, { platform: "linux" })).rejects.toThrow(
          "Private directory path identity changed during publication.",
        );

        expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o777);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("secures an empty Windows generation directory before child creation", async () => {
    const directory = await createTempDir();
    try {
      const generationPath = path.join(directory, "generation");
      const createWindowsDirectories = vi.fn(async (securedPath: string) => {
        await fs.mkdir(securedPath);
        expect(await fs.readdir(securedPath)).toEqual([]);
        return securedPath;
      });
      const secureWindowsDirectory = vi.fn<(directoryPath: string) => Promise<void>>();

      const secured = await securePrivateDirectory(generationPath, {
        createWindowsDirectories,
        platform: "win32",
        secureWindowsDirectory,
      });
      await secured.assertIdentityAt();
      await fs.writeFile(path.join(generationPath, "manifest.json"), "private\n");

      expect(createWindowsDirectories).toHaveBeenCalledWith(generationPath);
      expect(secureWindowsDirectory).not.toHaveBeenCalled();
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("rejects a Windows generation directory path substitution before child creation", async () => {
    const directory = await createTempDir();
    try {
      const generationPath = path.join(directory, "generation");
      const originalPath = `${generationPath}.original`;
      await fs.mkdir(generationPath);

      await expect(
        securePrivateDirectory(generationPath, {
          platform: "win32",
          secureWindowsDirectory: async (securedPath) => {
            await fs.rename(securedPath, originalPath);
            await fs.mkdir(securedPath);
          },
        }),
      ).rejects.toThrow("Private directory path identity changed during publication.");

      expect(await fs.readdir(originalPath)).toEqual([]);
      expect(await fs.readdir(generationPath)).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("secures an empty Windows temporary file before writing credentials", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      await fs.writeFile(filePath, "stale\n");
      const secureWindowsFile = vi.fn(async (temporaryPath: string) => {
        expect(await fs.readFile(temporaryPath, "utf8")).toBe("");
        expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
      });

      await publishPrivateFileAtomically(filePath, "private\n", {
        platform: "win32",
        secureWindowsFile,
      });

      expect(secureWindowsFile).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(filePath, "utf8")).toBe("private\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("rejects a temporary path substitution before writing credentials", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      await fs.writeFile(filePath, "stale\n");
      let originalTemporaryPath: string | undefined;
      let substituteTemporaryPath: string | undefined;

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          platform: "win32",
          secureWindowsFile: async (temporaryPath) => {
            substituteTemporaryPath = temporaryPath;
            originalTemporaryPath = `${temporaryPath}.original`;
            await fs.rename(temporaryPath, originalTemporaryPath);
            await fs.writeFile(temporaryPath, "substitute\n");
          },
        }),
      ).rejects.toThrow("Private file path identity changed during publication.");

      expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
      expect(originalTemporaryPath).toBeDefined();
      expect(await fs.readFile(originalTemporaryPath!, "utf8")).toBe("");
      expect(await fs.readFile(substituteTemporaryPath!, "utf8")).toBe("substitute\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("never ACL-mutates a Windows replacement substituted after atomic creation", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      await fs.writeFile(filePath, "stale\n");
      const aclMutatedInodes: bigint[] = [];
      let originalTemporaryPath: string | undefined;
      let replacementInode: bigint | undefined;

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          createWindowsFile: async (temporaryPath) => {
            await fs.writeFile(temporaryPath, "");
            const stats = await fs.stat(temporaryPath, { bigint: true });
            originalTemporaryPath = `${temporaryPath}.original`;
            aclMutatedInodes.push(stats.ino);
            await fs.rename(temporaryPath, originalTemporaryPath);
            await fs.writeFile(temporaryPath, "attacker-controlled\n");
            replacementInode = (await fs.stat(temporaryPath, { bigint: true })).ino;
            return { device: stats.dev, inode: stats.ino };
          },
          platform: "win32",
        }),
      ).rejects.toThrow("Private file path identity changed during publication.");

      expect(aclMutatedInodes).toHaveLength(1);
      expect(replacementInode).toBeDefined();
      expect(aclMutatedInodes).not.toContain(replacementInode);
      expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
      expect(await fs.readFile(originalTemporaryPath!, "utf8")).toBe("");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink alias substituted before writing credentials",
    async () => {
      const directory = await createTempDir();
      try {
        const filePath = path.join(directory, "manifest.json");
        await fs.writeFile(filePath, "stale\n");
        let originalTemporaryPath: string | undefined;

        await expect(
          publishPrivateFileAtomically(filePath, "private\n", {
            platform: "win32",
            secureWindowsFile: async (temporaryPath) => {
              originalTemporaryPath = `${temporaryPath}.original`;
              await fs.rename(temporaryPath, originalTemporaryPath);
              await fs.symlink(originalTemporaryPath, temporaryPath);
            },
          }),
        ).rejects.toThrow("Private file path identity changed during publication.");

        expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
        expect(originalTemporaryPath).toBeDefined();
        expect(await fs.readFile(originalTemporaryPath!, "utf8")).toBe("");
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("rejects a hard-link alias substituted before writing credentials", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      await fs.writeFile(filePath, "stale\n");
      let originalTemporaryPath: string | undefined;

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          platform: "win32",
          secureWindowsFile: async (temporaryPath) => {
            originalTemporaryPath = `${temporaryPath}.original`;
            await fs.rename(temporaryPath, originalTemporaryPath);
            await fs.link(originalTemporaryPath, temporaryPath);
          },
        }),
      ).rejects.toThrow("Private file path identity changed during publication.");

      expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
      expect(originalTemporaryPath).toBeDefined();
      expect(await fs.readFile(originalTemporaryPath!, "utf8")).toBe("");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("fails closed when the Windows ACL cannot be established", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      await fs.writeFile(filePath, "stale\n");
      const aclError = new Error("ACL unavailable");

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          platform: "win32",
          secureWindowsFile: async () => {
            throw aclError;
          },
        }),
      ).rejects.toBe(aclError);

      expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
      expect((await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("surfaces credential-bearing temporary file cleanup failures", async () => {
    const directory = await createTempDir();
    const publicationError = new Error("publication failed");
    const cleanupError = new Error("temporary cleanup failed");
    let temporaryPath: string | undefined;
    try {
      const failure = await publishPrivateFileAtomically(
        path.join(directory, "manifest.json"),
        "private credential\n",
        {
          beforeRename: async (candidatePath) => {
            temporaryPath = candidatePath;
            throw publicationError;
          },
          removeTemporaryFile: async () => {
            throw cleanupError;
          },
        },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([publicationError, cleanupError]);
      expect((failure as Error).message).toContain("Private temporary file cleanup also failed.");
      expect(temporaryPath).toBeDefined();
      await expect(fs.readFile(temporaryPath!, "utf8")).resolves.toBe("private credential\n");
    } finally {
      if (temporaryPath) {
        await fs.rm(temporaryPath, { force: true });
      }
      await disposeTempDir(directory);
    }
  });

  it("preserves undefined and null publication rejection reasons", async () => {
    const directory = await createTempDir();
    try {
      for (const rejectionReason of [undefined, null]) {
        let rejected = false;
        let receivedReason: unknown = Symbol("unrejected");
        await publishPrivateFileAtomically(
          path.join(directory, `manifest-${String(rejectionReason)}.json`),
          "private credential\n",
          {
            beforeRename: async () => {
              throw rejectionReason;
            },
          },
        ).then(
          () => undefined,
          (error: unknown) => {
            rejected = true;
            receivedReason = error;
          },
        );
        expect(rejected).toBe(true);
        expect(receivedReason).toBe(rejectionReason);
      }

      const cleanupError = new Error("temporary cleanup failed");
      const failure = await publishPrivateFileAtomically(
        path.join(directory, "manifest-null-cleanup.json"),
        "private credential\n",
        {
          beforeRename: async () => {
            throw null;
          },
          removeTemporaryFile: async (temporaryPath) => {
            await fs.rm(temporaryPath, { force: true });
            throw cleanupError;
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([null, cleanupError]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("preserves a replacement installed after the atomic rename", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      const displacedPath = `${filePath}.published`;

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          afterRename: async (publishedPath) => {
            await fs.rename(publishedPath, displacedPath);
            await fs.writeFile(publishedPath, "replacement\n");
          },
        }),
      ).rejects.toThrow("Private file path identity changed during publication.");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement\n");
      await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("private\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("rejects a temporary substitution at the claimed rename boundary", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      await fs.writeFile(filePath, "stale\n");
      let originalTemporaryPath: string | undefined;
      let substituteTemporaryPath: string | undefined;

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          beforeCommitRename: async (temporaryPath) => {
            substituteTemporaryPath = temporaryPath;
            originalTemporaryPath = `${temporaryPath}.original`;
            await fs.rename(temporaryPath, originalTemporaryPath);
            await fs.writeFile(temporaryPath, "substitute\n");
          },
        }),
      ).rejects.toThrow("Private file path identity changed during publication.");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("stale\n");
      await expect(fs.readFile(originalTemporaryPath!, "utf8")).resolves.toBe("private\n");
      await expect(fs.readFile(substituteTemporaryPath!, "utf8")).resolves.toBe("substitute\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "serializes same-target publication with an owner-only mutation claim",
    async () => {
      const directory = await createTempDir();
      let releaseCommit!: () => void;
      const commitReleased = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let commitReached!: () => void;
      const reachedCommit = new Promise<void>((resolve) => {
        commitReached = resolve;
      });
      try {
        const filePath = path.join(directory, "manifest.json");
        const firstPublication = publishPrivateFileAtomically(filePath, "first\n", {
          beforeCommitRename: async () => {
            const claimName = (await fs.readdir(directory)).find((entry) =>
              entry.endsWith(".claim"),
            );
            expect(claimName).toBeDefined();
            const claimStats = await fs.stat(path.join(directory, claimName!));
            expect(claimStats.isFile()).toBe(true);
            expect(claimStats.mode & 0o777).toBe(0o600);
            commitReached();
            await commitReleased;
          },
        });
        await reachedCommit;

        await expect(publishPrivateFileAtomically(filePath, "second\n")).rejects.toThrow(
          "Private path mutation is already claimed.",
        );

        releaseCommit();
        await firstPublication;
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("first\n");
        expect((await fs.readdir(directory)).filter((entry) => entry.endsWith(".claim"))).toEqual(
          [],
        );
      } finally {
        releaseCommit();
        await disposeTempDir(directory);
      }
    },
  );

  it("falls back to an atomically renamed claim directory without hard-link support", async () => {
    const directory = await createTempDir();
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitReached!: () => void;
    const reachedCommit = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    let firstPublication: Promise<void> | undefined;
    try {
      const filePath = path.join(directory, "manifest.json");
      firstPublication = publishPrivateFileAtomically(filePath, "private\n", {
        beforeCommitRename: async () => {
          commitReached();
          await commitReleased;
        },
      });
      await reachedCommit;

      await expect(publishPrivateFileAtomically(filePath, "second\n")).rejects.toThrow(
        "Private path mutation is already claimed.",
      );

      releaseCommit();
      await firstPublication;
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      releaseCommit();
      await firstPublication?.catch(() => undefined);
      linkSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("recovers a stale directory claim on filesystems without hard-link support", async () => {
    const directory = await createTempDir();
    try {
      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      await fs.mkdir(claimPath, { mode: 0o700 });
      await fs.writeFile(
        path.join(claimPath, "owner.json"),
        `${JSON.stringify({
          ownerId: "stale-directory-owner",
          pid: 999_994,
          processIdentity: "dead:stale-directory-owner",
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );

      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => false,
          ownerId: "replacement-owner",
          pid: process.pid,
          processIdentity: "test:replacement-owner",
          processStartedAtMs: 200,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "compacts stale directory claim chains before publication",
    async () => {
      const directory = await createTempDir();
      try {
        const claimPath = path.join(directory, ".crabline-private-mutation.claim");
        let staleClaimPath = claimPath;
        for (let index = 0; index < 12; index += 1) {
          await fs.mkdir(staleClaimPath, { mode: 0o700 });
          await fs.writeFile(
            path.join(staleClaimPath, "owner.json"),
            `${JSON.stringify({
              ownerId: `stale-directory-owner-${index}`,
              pid: 900_000 + index,
              processIdentity: `dead:stale-directory-owner-${index}`,
              processStartedAtMs: 100 + index,
            })}\n`,
            { mode: 0o600 },
          );
          staleClaimPath = path.join(staleClaimPath, ".next");
        }

        await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
          beforeCommitRename: async () => {
            await expect(fs.readdir(claimPath)).resolves.toEqual(["owner.json"]);
            const owner = JSON.parse(
              await fs.readFile(path.join(claimPath, "owner.json"), "utf8"),
            ) as { ownerId: string };
            expect(owner.ownerId).toBe("replacement-owner");
          },
          claimRuntime: {
            getProcessIdentity: () => null,
            isProcessAlive: () => false,
            ownerId: "replacement-owner",
            pid: process.pid,
            processIdentity: "test:replacement-owner",
            processStartedAtMs: 200,
          },
        });

        await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
          "private\n",
        );
        expect(
          (await fs.readdir(directory)).filter((entry) =>
            entry.startsWith(".crabline-private-mutation"),
          ),
        ).toEqual([]);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries when a competing root claim wins directory compaction",
    async () => {
      const directory = await createTempDir();
      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      const actualRename = fs.rename.bind(fs);
      let competitorInstalled = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (!competitorInstalled && to === claimPath && String(from).includes(".stale-dir")) {
          competitorInstalled = true;
          await fs.mkdir(claimPath, { mode: 0o700 });
          await fs.writeFile(
            path.join(claimPath, "owner.json"),
            `${JSON.stringify({
              ownerId: "live-compaction-winner",
              pid: 777_777,
              processIdentity: "live:compaction-winner",
              processStartedAtMs: 300,
            })}\n`,
            { mode: 0o600 },
          );
          throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
        }
        await actualRename(from, to);
      });
      try {
        await fs.mkdir(claimPath, { mode: 0o700 });
        await fs.writeFile(
          path.join(claimPath, "owner.json"),
          `${JSON.stringify({
            ownerId: "stale-directory-owner",
            pid: 999_994,
            processIdentity: "dead:stale-directory-owner",
            processStartedAtMs: 100,
          })}\n`,
          { mode: 0o600 },
        );

        await expect(
          publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
            claimRuntime: {
              getProcessIdentity: (pid) => (pid === 777_777 ? "live:compaction-winner" : null),
              isProcessAlive: (pid) => pid === 777_777,
              ownerId: "replacement-owner",
              pid: process.pid,
              processIdentity: "test:replacement-owner",
              processStartedAtMs: 200,
            },
          }),
        ).rejects.toThrow("Private path mutation is already claimed.");

        expect(competitorInstalled).toBe(true);
        await expect(fs.readdir(claimPath)).resolves.toEqual(["owner.json"]);
        expect(
          (await fs.readdir(directory)).filter((entry) => entry.endsWith(".stale-dir")),
        ).toEqual([]);
      } finally {
        renameSpy.mockRestore();
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a permissive live directory claim instead of trusting its owner metadata",
    async () => {
      const directory = await createTempDir();
      const linkSpy = vi
        .spyOn(fs, "link")
        .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
      try {
        const claimPath = path.join(directory, ".crabline-private-mutation.claim");
        await fs.mkdir(claimPath, { mode: 0o777 });
        await fs.chmod(claimPath, 0o777);
        await fs.writeFile(
          path.join(claimPath, "owner.json"),
          `${JSON.stringify({
            ownerId: "planted-directory-owner",
            pid: process.pid,
            processIdentity: "planted:directory-owner",
            processStartedAtMs: 100,
          })}\n`,
          { mode: 0o600 },
        );

        await expect(
          publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n"),
        ).rejects.toThrow("Private mutation claim directory must be owner-only.");

        await expect(fs.stat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        linkSpy.mockRestore();
        await disposeTempDir(directory);
      }
    },
  );

  it("rejects a replacement root installed before a nested directory claim", async () => {
    const directory = await createTempDir();
    const claimPath = path.join(directory, ".crabline-private-mutation.claim");
    const nestedClaimPath = path.join(claimPath, ".next");
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
    const actualRename = fs.rename.bind(fs);
    let replacedRoot = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!replacedRoot && to === nestedClaimPath) {
        replacedRoot = true;
        await fs.rm(claimPath, { recursive: true });
        await fs.mkdir(claimPath, { mode: 0o700 });
        await fs.writeFile(
          path.join(claimPath, "owner.json"),
          `${JSON.stringify({
            ownerId: "live-directory-owner",
            pid: 777_777,
            processIdentity: "live:directory-owner",
            processStartedAtMs: 300,
          })}\n`,
          { mode: 0o600 },
        );
      }
      await actualRename(from, to);
    });
    try {
      await fs.mkdir(claimPath, { mode: 0o700 });
      await fs.writeFile(
        path.join(claimPath, "owner.json"),
        `${JSON.stringify({
          ownerId: "stale-directory-owner",
          pid: 999_994,
          processIdentity: "dead:stale-directory-owner",
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
          claimRuntime: {
            getProcessIdentity: (pid) => (pid === 777_777 ? "live:directory-owner" : null),
            isProcessAlive: (pid) => pid === 777_777,
            ownerId: "replacement-owner",
            pid: process.pid,
            processIdentity: "test:replacement-owner",
            processStartedAtMs: 200,
          },
        }),
      ).rejects.toThrow("Private path mutation is already claimed.");

      expect(replacedRoot).toBe(true);
      await expect(fs.readdir(claimPath)).resolves.toEqual(["owner.json"]);
      await expect(fs.stat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("rejects root owner metadata changed before a nested directory claim", async () => {
    const directory = await createTempDir();
    const claimPath = path.join(directory, ".crabline-private-mutation.claim");
    const nestedClaimPath = path.join(claimPath, ".next");
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
    const actualRename = fs.rename.bind(fs);
    let replacedOwner = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!replacedOwner && to === nestedClaimPath) {
        replacedOwner = true;
        await fs.writeFile(
          path.join(claimPath, "owner.json"),
          `${JSON.stringify({
            ownerId: "live-directory-owner",
            pid: 777_777,
            processIdentity: "live:directory-owner",
            processStartedAtMs: 300,
          })}\n`,
          { mode: 0o600 },
        );
      }
      await actualRename(from, to);
    });
    try {
      await fs.mkdir(claimPath, { mode: 0o700 });
      await fs.writeFile(
        path.join(claimPath, "owner.json"),
        `${JSON.stringify({
          ownerId: "stale-directory-owner",
          pid: 999_994,
          processIdentity: "dead:stale-directory-owner",
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
          claimRuntime: {
            getProcessIdentity: (pid) => (pid === 777_777 ? "live:directory-owner" : null),
            isProcessAlive: (pid) => pid === 777_777,
            ownerId: "replacement-owner",
            pid: process.pid,
            processIdentity: "test:replacement-owner",
            processStartedAtMs: 200,
          },
        }),
      ).rejects.toThrow("Private path mutation is already claimed.");

      expect(replacedOwner).toBe(true);
      await expect(fs.readdir(claimPath)).resolves.toEqual(["owner.json"]);
      await expect(fs.stat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("rolls back a directory claim when its first parent sync fails", async () => {
    const directory = await createTempDir();
    const claimPath = path.join(directory, ".crabline-private-mutation.claim");
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
    const actualOpen = fs.open.bind(fs);
    const actualRename = fs.rename.bind(fs);
    const syncFailure = new Error("directory claim parent sync failed");
    let claimInstalled = false;
    let syncFailed = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await actualRename(from, to);
      if (to === claimPath) {
        claimInstalled = true;
      }
    });
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openedPath, flags, mode) => {
      if (claimInstalled && !syncFailed && openedPath === directory && flags === "r") {
        syncFailed = true;
        throw syncFailure;
      }
      return mode === undefined
        ? await actualOpen(openedPath, flags)
        : await actualOpen(openedPath, flags, mode);
    });
    try {
      const filePath = path.join(directory, "manifest.json");

      await expect(publishPrivateFileAtomically(filePath, "first\n")).rejects.toBe(syncFailure);

      renameSpy.mockRestore();
      openSpy.mockRestore();
      linkSpy.mockRestore();
      await publishPrivateFileAtomically(filePath, "second\n");
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second\n");
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      openSpy.mockRestore();
      linkSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("removes a partially created directory claim candidate after setup failure", async () => {
    const directory = await createTempDir();
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));
    const actualOpen = fs.open.bind(fs);
    const setupFailure = new Error("directory claim metadata setup failed");
    let setupFailed = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openedPath, flags, mode) => {
      if (!setupFailed && path.basename(String(openedPath)) === "owner.json" && flags === "wx+") {
        setupFailed = true;
        throw setupFailure;
      }
      return mode === undefined
        ? await actualOpen(openedPath, flags)
        : await actualOpen(openedPath, flags, mode);
    });
    try {
      const filePath = path.join(directory, "manifest.json");

      await expect(publishPrivateFileAtomically(filePath, "first\n")).rejects.toBe(setupFailure);

      expect(
        (await fs.readdir(directory)).filter((entry) => entry.endsWith(".candidate-dir")),
      ).toEqual([]);
      openSpy.mockRestore();
      linkSpy.mockRestore();
      await publishPrivateFileAtomically(filePath, "second\n");
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second\n");
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("uses one parent-wide claim for filesystem-equivalent target names", async () => {
    const directory = await createTempDir();
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitReached!: () => void;
    const reachedCommit = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    try {
      const firstPublication = publishPrivateFileAtomically(
        path.join(directory, "manifest.json"),
        "first\n",
        {
          beforeCommitRename: async () => {
            commitReached();
            await commitReleased;
          },
        },
      );
      await reachedCommit;

      await expect(
        publishPrivateFileAtomically(path.join(directory, "MANIFEST.JSON"), "second\n"),
      ).rejects.toThrow("Private path mutation is already claimed.");

      releaseCommit();
      await firstPublication;
    } finally {
      releaseCommit();
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "serializes recursive removal across an owned legacy 0755 descendant",
    async () => {
      const directory = await createTempDir();
      let releaseCommit!: () => void;
      const commitReleased = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let commitReached!: () => void;
      const reachedCommit = new Promise<void>((resolve) => {
        commitReached = resolve;
      });
      let publication: Promise<void> | undefined;
      try {
        const generationPath = path.join(directory, "generation");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        const legacyPath = path.join(generationPath, "legacy");
        await fs.mkdir(legacyPath, { mode: 0o755 });
        await fs.chmod(legacyPath, 0o755);
        const filePath = path.join(legacyPath, "nested", "manifest.json");
        publication = publishPrivateFileAtomically(filePath, "private\n", {
          beforeCommitRename: async () => {
            commitReached();
            await commitReleased;
          },
        });
        await reachedCommit;

        await expect(
          removeSecuredPrivateDirectory(secured, undefined, undefined, {
            platform: "linux",
          }),
        ).rejects.toThrow("Private path mutation is already claimed.");

        releaseCommit();
        await publication;
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
      } finally {
        releaseCommit();
        await publication?.catch(() => undefined);
        await disposeTempDir(directory);
      }
    },
  );

  it("retries when an active claim disappears before its metadata is opened", async () => {
    const directory = await createTempDir();
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitReached!: () => void;
    const reachedCommit = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    let firstPublication: Promise<void> | undefined;
    let releasedDuringOpen = false;
    let openSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const filePath = path.join(directory, "manifest.json");
      firstPublication = publishPrivateFileAtomically(filePath, "first\n", {
        beforeCommitRename: async () => {
          commitReached();
          await commitReleased;
        },
      });
      await reachedCommit;

      const actualOpen = fs.open.bind(fs);
      openSpy = vi.spyOn(fs, "open").mockImplementation(async (openedPath, flags, mode) => {
        if (
          !releasedDuringOpen &&
          openedPath === path.join(directory, ".crabline-private-mutation.claim") &&
          (flags === "r" || typeof flags === "number")
        ) {
          releasedDuringOpen = true;
          releaseCommit();
          await firstPublication;
        }
        return mode === undefined
          ? await actualOpen(openedPath, flags)
          : await actualOpen(openedPath, flags, mode);
      });
      await publishPrivateFileAtomically(filePath, "second\n");

      expect(releasedDuringOpen).toBe(true);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second\n");
    } finally {
      releaseCommit();
      await firstPublication?.catch(() => undefined);
      openSpy?.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("retries the root claim when its owner releases after stale classification", async () => {
    const directory = await createTempDir();
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitReached!: () => void;
    const reachedCommit = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    let firstPublication: Promise<void> | undefined;
    try {
      const filePath = path.join(directory, "manifest.json");
      firstPublication = publishPrivateFileAtomically(filePath, "first\n", {
        beforeCommitRename: async () => {
          commitReached();
          await commitReleased;
        },
      });
      await reachedCommit;

      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      const actualOpen = fs.open.bind(fs);
      let claimReadCount = 0;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openedPath, flags, mode) => {
        if (openedPath === claimPath && (flags === "r" || typeof flags === "number")) {
          claimReadCount += 1;
          if (claimReadCount === 2) {
            releaseCommit();
            await firstPublication;
          }
        }
        return mode === undefined
          ? await actualOpen(openedPath, flags)
          : await actualOpen(openedPath, flags, mode);
      });
      try {
        await publishPrivateFileAtomically(filePath, "second\n", {
          claimRuntime: {
            getProcessIdentity: () => null,
            isProcessAlive: () => false,
            ownerId: "replacement-owner",
            pid: process.pid,
            processIdentity: "test:replacement-owner",
            processStartedAtMs: 200,
          },
        });
      } finally {
        openSpy.mockRestore();
      }

      expect(claimReadCount).toBeGreaterThanOrEqual(2);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second\n");
    } finally {
      releaseCommit();
      await firstPublication?.catch(() => undefined);
      await disposeTempDir(directory);
    }
  });

  it("rolls back a linked claim when its first parent sync fails", async () => {
    const directory = await createTempDir();
    const actualOpen = fs.open.bind(fs);
    const actualLink = fs.link.bind(fs);
    const syncFailure = new Error("claim parent sync failed");
    let claimLinked = false;
    let syncFailed = false;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
      await actualLink(...args);
      claimLinked = true;
    });
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (claimLinked && !syncFailed && filePath === directory && flags === "r") {
        syncFailed = true;
        throw syncFailure;
      }
      return mode === undefined
        ? await actualOpen(filePath, flags)
        : await actualOpen(filePath, flags, mode);
    });
    try {
      const filePath = path.join(directory, "manifest.json");

      await expect(publishPrivateFileAtomically(filePath, "first\n")).rejects.toBe(syncFailure);

      linkSpy.mockRestore();
      openSpy.mockRestore();
      await publishPrivateFileAtomically(filePath, "second\n");
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second\n");
    } finally {
      linkSpy.mockRestore();
      openSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it.each([".crabline-private-mutation.claim", ".CRABLINE-PRIVATE-MUTATION.claim"])(
    "rejects the reserved claim namespace before changing destination %s",
    async (fileName) => {
      const directory = await createTempDir();
      try {
        const filePath = path.join(directory, fileName);
        await fs.writeFile(filePath, "existing\n", { mode: 0o600 });

        await expect(publishPrivateFileAtomically(filePath, "replacement\n")).rejects.toThrow(
          "Private path uses Crabline's reserved mutation claim namespace.",
        );

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("existing\n");
        await expect(fs.readdir(directory)).resolves.toEqual([fileName]);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("rejects oversized mutation claim metadata without allocating from its contents", async () => {
    const directory = await createTempDir();
    try {
      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      await fs.writeFile(claimPath, "x".repeat(4097), { mode: 0o600 });
      await fs.chmod(claimPath, 0o600);

      const filePath = path.join(directory, "manifest.json");
      await expect(publishPrivateFileAtomically(filePath, "private\n")).rejects.toThrow(
        "Private path mutation claim metadata size is invalid.",
      );

      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(directory)).resolves.toEqual([".crabline-private-mutation.claim"]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a permissive live mutation claim instead of trusting its owner metadata",
    async () => {
      const directory = await createTempDir();
      try {
        const claimPath = path.join(directory, ".crabline-private-mutation.claim");
        await fs.writeFile(
          claimPath,
          `${JSON.stringify({
            ownerId: "planted-file-owner",
            pid: process.pid,
            processIdentity: "planted:file-owner",
            processStartedAtMs: 100,
          })}\n`,
          { mode: 0o666 },
        );
        await fs.chmod(claimPath, 0o666);

        await expect(
          publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n"),
        ).rejects.toThrow("Private mutation claim file must be owner-only.");

        await expect(fs.stat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO claim without waiting for a writer",
    async () => {
      const directory = await createTempDir();
      try {
        const claimPath = path.join(directory, ".crabline-private-mutation.claim");
        execFileSync("mkfifo", [claimPath]);

        await expect(
          publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n"),
        ).rejects.toThrow("Private path mutation claim metadata size is invalid.");
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("accepts valid claim metadata returned through short reads", async () => {
    const directory = await createTempDir();
    const claimPath = path.join(directory, ".crabline-private-mutation.claim");
    const contents = `${JSON.stringify({
      ownerId: "short-read-owner",
      pid: 999_996,
      processIdentity: "dead:short-read-owner",
      processStartedAtMs: 100,
    })}\n`;
    await fs.writeFile(claimPath, contents, { mode: 0o600 });
    const actualOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openedPath, flags, mode) => {
      const handle =
        mode === undefined
          ? await actualOpen(openedPath, flags)
          : await actualOpen(openedPath, flags, mode);
      if (openedPath === claimPath) {
        const actualRead = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(
          (async (buffer: Buffer, offset: number, length: number, position: number) =>
            await actualRead(buffer, offset, Math.min(length, 7), position)) as never,
        );
      }
      return handle;
    });
    try {
      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => false,
          ownerId: "replacement-owner",
          pid: process.pid,
          processIdentity: "test:replacement-owner",
          processStartedAtMs: 200,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
    } finally {
      openSpy.mockRestore();
      await disposeTempDir(directory);
    }
  });

  it("recovers a stale claim with a maximum-length replacement owner ID", async () => {
    const directory = await createTempDir();
    try {
      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      await fs.writeFile(
        claimPath,
        `${JSON.stringify({
          ownerId: "stale-owner",
          pid: 999_999,
          processIdentity: "dead:stale-owner",
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );
      await fs.chmod(claimPath, 0o600);

      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => false,
          ownerId: "r".repeat(128),
          pid: process.pid,
          processIdentity: "test:replacement-owner",
          processStartedAtMs: 200,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("recovers a stale claim when its PID belongs to a different process identity", async () => {
    const directory = await createTempDir();
    try {
      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      await fs.writeFile(
        claimPath,
        `${JSON.stringify({
          ownerId: "reused-pid-owner",
          pid: process.pid,
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );

      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => true,
          ownerId: "current-owner",
          pid: process.pid,
          processStartedAtMs: 200,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("does not let a delayed stale contender displace a live successor claim", async () => {
    const directory = await createTempDir();
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitReached!: () => void;
    const reachedCommit = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    try {
      await fs.writeFile(
        path.join(directory, ".crabline-private-mutation.claim"),
        `${JSON.stringify({
          ownerId: "stale-root-owner",
          pid: 999_997,
          processIdentity: "dead:stale-root-owner",
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );
      const firstPublication = publishPrivateFileAtomically(
        path.join(directory, "manifest.json"),
        "first\n",
        {
          beforeCommitRename: async () => {
            commitReached();
            await commitReleased;
          },
          claimRuntime: {
            getProcessIdentity: () => "test:first-owner",
            isProcessAlive: (pid) => pid === 111,
            ownerId: "first-owner",
            pid: 111,
            processIdentity: "test:first-owner",
            processStartedAtMs: 100,
          },
        },
      );
      await reachedCommit;

      await expect(
        publishPrivateFileAtomically(path.join(directory, "manifest.json"), "second\n", {
          claimRuntime: {
            getProcessIdentity: () => "test:first-owner",
            isProcessAlive: (pid) => pid === 111,
            ownerId: "second-owner",
            pid: 222,
            processIdentity: "test:second-owner",
            processStartedAtMs: 200,
          },
        }),
      ).rejects.toThrow("Private path mutation is already claimed.");

      releaseCommit();
      await firstPublication;
      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "first\n",
      );
    } finally {
      releaseCommit();
      await disposeTempDir(directory);
    }
  });

  it("recovers past a stale claim left with its candidate hard link", async () => {
    const directory = await createTempDir();
    try {
      const claimPath = path.join(directory, ".crabline-private-mutation.claim");
      const candidatePath = `${claimPath}.crashed.candidate`;
      await fs.writeFile(
        candidatePath,
        `${JSON.stringify({
          ownerId: "crashed-owner",
          pid: 999_998,
          processIdentity: "dead:crashed-owner",
          processStartedAtMs: 100,
        })}\n`,
        { mode: 0o600 },
      );
      await fs.link(candidatePath, claimPath);
      expect((await fs.stat(claimPath)).nlink).toBe(2);

      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => false,
          ownerId: "next-owner",
          pid: process.pid,
          processIdentity: "test:next-owner",
          processStartedAtMs: 200,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("recovers a root claim hard-linked to its deterministic successor", async () => {
    const directory = await createTempDir();
    try {
      const rootClaimPath = path.join(directory, ".crabline-private-mutation.claim");
      const contents = `${JSON.stringify({
        ownerId: "crashed-compactor",
        pid: 999_995,
        processIdentity: "dead:crashed-compactor",
        processStartedAtMs: 100,
      })}\n`;
      await fs.writeFile(rootClaimPath, contents, { mode: 0o600 });
      const successorPath = path.join(
        directory,
        `.crabline-private-mutation.${createHash("sha256").update(contents).digest("hex")}.claim`,
      );
      await fs.link(rootClaimPath, successorPath);

      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => false,
          ownerId: "replacement-owner",
          pid: process.pid,
          processIdentity: "test:replacement-owner",
          processStartedAtMs: 200,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("compacts more stale claims than the former fixed traversal limit", async () => {
    const directory = await createTempDir();
    try {
      let claimPath = path.join(directory, ".crabline-private-mutation.claim");
      for (let index = 0; index < 1025; index += 1) {
        const contents = `${JSON.stringify({
          ownerId: `stale-${index}`,
          pid: 900_000 + index,
          processIdentity: `dead:stale-${index}`,
          processStartedAtMs: index + 1,
        })}\n`;
        await fs.writeFile(claimPath, contents, { mode: 0o600 });
        claimPath = path.join(
          directory,
          `.crabline-private-mutation.${createHash("sha256").update(contents).digest("hex")}.claim`,
        );
      }

      await publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n", {
        claimRuntime: {
          getProcessIdentity: () => null,
          isProcessAlive: () => false,
          ownerId: "replacement-owner",
          pid: process.pid,
          processIdentity: "test:replacement-owner",
          processStartedAtMs: 2000,
        },
      });

      await expect(fs.readFile(path.join(directory, "manifest.json"), "utf8")).resolves.toBe(
        "private\n",
      );
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.startsWith(".crabline-private-mutation"),
        ),
      ).toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "migrates an owned permissive publication parent before writing",
    async () => {
      const directory = await createTempDir();
      try {
        await fs.chmod(directory, 0o755);

        const filePath = path.join(directory, "manifest.json");
        await publishPrivateFileAtomically(filePath, "private\n");

        expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rejects inherited macOS ACL risk without mutating the existing ancestor",
    async () => {
      const directory = await createTempDir();
      try {
        execFileSync(
          "/bin/chmod",
          ["+a", "everyone allow add_file,delete_child,file_inherit,directory_inherit", directory],
          { stdio: "ignore" },
        );
        const filePath = path.join(directory, "nested", "manifest.json");

        await expect(publishPrivateFileAtomically(filePath, "private\n")).rejects.toThrow(
          "Private directory must not have a macOS extended ACL.",
        );

        expect(
          execFileSync("/bin/ls", ["-lde", directory], { encoding: "utf8" })
            .trimStart()
            .split(/\s+/u, 1)[0],
        ).toContain("+");
        await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        execFileSync("/bin/chmod", ["-RN", directory], { stdio: "ignore" });
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "migrates an existing macOS publication parent with a legacy ACL",
    async () => {
      const directory = await createTempDir();
      try {
        execFileSync(
          "/bin/chmod",
          ["+a", "everyone allow add_file,delete_child,file_inherit,directory_inherit", directory],
          { stdio: "ignore" },
        );
        const filePath = path.join(directory, "manifest.json");

        await publishPrivateFileAtomically(filePath, "private\n");

        expect(
          execFileSync("/bin/ls", ["-lde", directory], { encoding: "utf8" })
            .trimStart()
            .split(/\s+/u, 1)[0],
        ).not.toContain("+");
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
      } finally {
        execFileSync("/bin/chmod", ["-RN", directory], { stdio: "ignore" });
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes a private directory beneath a sticky shared parent without chmodding it",
    async () => {
      const parent = await createTempDir();
      try {
        await fs.chmod(parent, 0o1777);
        const generationPath = path.join(parent, "generation");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        await fs.writeFile(path.join(generationPath, "private.json"), "private\n");

        await removeSecuredPrivateDirectory(secured, undefined, undefined, {
          platform: "linux",
        });

        expect((await fs.stat(parent)).mode & 0o7777).toBe(0o1777);
        await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.chmod(parent, 0o700);
        await disposeTempDir(parent);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes a secured directory whose basename uses the reserved claim prefix",
    async () => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, ".crabline-private-mutation.data");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        await fs.writeFile(path.join(generationPath, "private.json"), "private\n");

        await removeSecuredPrivateDirectory(secured, undefined, undefined, {
          platform: "linux",
        });

        await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "closes the leaf claim handle before recursively deleting its container",
    async () => {
      const directory = await createTempDir();
      const actualOpen = fs.open.bind(fs);
      let claimHandleClosed = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle =
          mode === undefined
            ? await actualOpen(filePath, flags)
            : await actualOpen(filePath, flags, mode);
        if (
          typeof filePath === "string" &&
          filePath.includes(".crabline-private-mutation.claim.") &&
          filePath.endsWith(".candidate")
        ) {
          const actualClose = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            claimHandleClosed = true;
            await actualClose();
          });
        }
        return handle;
      });
      try {
        const generationPath = path.join(directory, "generation");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        await fs.writeFile(path.join(generationPath, "private.json"), "private\n");

        await removeSecuredPrivateDirectory(secured, undefined, undefined, {
          platform: "linux",
          removeDirectory: async (quarantinePath) => {
            expect(claimHandleClosed).toBe(true);
            await fs.rm(quarantinePath, { force: true, recursive: true });
          },
        });
      } finally {
        openSpy.mockRestore();
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries ancestor claim release after the removed container is gone",
    async () => {
      const directory = await createTempDir();
      const actualRename = fs.rename.bind(fs);
      let ancestorReleaseAttempts = 0;
      try {
        await securePrivateDirectory(directory, { platform: "linux" });
        const generationPath = path.join(directory, "generation");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        await fs.writeFile(path.join(generationPath, "private.json"), "private\n");
        const ancestorClaimPath = path.join(directory, ".crabline-private-mutation.claim");
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
          if (
            oldPath === ancestorClaimPath &&
            typeof newPath === "string" &&
            newPath.endsWith(".release")
          ) {
            ancestorReleaseAttempts += 1;
            if (ancestorReleaseAttempts === 1) {
              throw new Error("injected ancestor release failure");
            }
          }
          await actualRename(oldPath, newPath);
        });
        try {
          await expect(
            removeSecuredPrivateDirectory(secured, undefined, undefined, {
              platform: "linux",
            }),
          ).rejects.toThrow("injected ancestor release failure");
        } finally {
          renameSpy.mockRestore();
        }

        expect(ancestorReleaseAttempts).toBe(2);
        await expect(fs.stat(ancestorClaimPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "releases the leaf claim when recursive removal leaves its container in place",
    async () => {
      const directory = await createTempDir();
      let quarantinePath: string | undefined;
      try {
        const generationPath = path.join(directory, "generation");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        await fs.writeFile(path.join(generationPath, "private.json"), "private\n");

        await expect(
          removeSecuredPrivateDirectory(secured, undefined, undefined, {
            platform: "linux",
            removeDirectory: async (candidatePath) => {
              quarantinePath = candidatePath;
            },
          }),
        ).rejects.toThrow("Private directory path still exists after recursive removal.");

        expect(quarantinePath).toBeDefined();
        await expect(fs.readdir(quarantinePath!)).resolves.toEqual(["private.json"]);
        expect(
          (await fs.readdir(directory)).filter((entry) =>
            entry.startsWith(".crabline-private-mutation"),
          ),
        ).toEqual([]);
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a substituted quarantine directory at the recursive removal boundary",
    async () => {
      const directory = await createTempDir();
      try {
        const generationPath = path.join(directory, "generation");
        const secured = await securePrivateDirectory(generationPath, { platform: "linux" });
        await fs.writeFile(path.join(generationPath, "private.json"), "private\n");
        let originalQuarantinePath: string | undefined;
        let substitutePath: string | undefined;

        const removalError = await removeSecuredPrivateDirectory(secured, undefined, undefined, {
          beforeRecursiveRemove: async (quarantinePath) => {
            originalQuarantinePath = `${quarantinePath}.original`;
            substitutePath = quarantinePath;
            await fs.rename(quarantinePath, originalQuarantinePath);
            await fs.mkdir(quarantinePath);
            await fs.writeFile(path.join(quarantinePath, "substitute.json"), "substitute\n");
          },
          platform: "linux",
        }).catch((error: unknown) => error);

        expect(removalError).toBeInstanceOf(AggregateError);
        expect((removalError as AggregateError).cause).toMatchObject({
          message: "Private directory path identity changed during publication.",
        });

        await expect(
          fs.readFile(path.join(originalQuarantinePath!, "private.json"), "utf8"),
        ).resolves.toBe("private\n");
        await expect(
          fs.readFile(path.join(substitutePath!, "substitute.json"), "utf8"),
        ).resolves.toBe("substitute\n");
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("stops safely at an inaccessible pre-existing ancestor after publication", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      const events: string[] = [];

      await publishPrivateFileAtomically(filePath, "private\n", {
        afterRename: async () => {
          events.push("afterRename");
        },
        syncParent: async (publishedPath) => {
          events.push(`sync:${publishedPath}`);
          if (publishedPath === directory) {
            throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
          }
        },
      });

      expect(events).toEqual([`sync:${filePath}`, `sync:${directory}`, "afterRename"]);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("fails publication when the immediate parent directory cannot be synced", async () => {
    const directory = await createTempDir();
    try {
      const filePath = path.join(directory, "manifest.json");
      const syncFailure = Object.assign(new Error("publication directory denied"), {
        code: "EACCES",
      });
      const afterRename = vi.fn<() => Promise<void>>();

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          afterRename,
          syncParent: async (publishedPath) => {
            expect(publishedPath).toBe(filePath);
            throw syncFailure;
          },
        }),
      ).rejects.toBe(syncFailure);

      expect(afterRename).not.toHaveBeenCalled();
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("fails publication when known newly created ancestry cannot be synced", async () => {
    const directory = await createTempDir();
    try {
      const firstParent = path.join(directory, "first");
      const finalParent = path.join(firstParent, "nested");
      const filePath = path.join(finalParent, "manifest.json");
      const syncFailure = Object.assign(new Error("created ancestry denied"), { code: "EPERM" });
      const syncedPaths: string[] = [];

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          syncParent: async (publishedPath) => {
            syncedPaths.push(publishedPath);
            if (publishedPath === firstParent) {
              throw syncFailure;
            }
          },
        }),
      ).rejects.toBe(syncFailure);

      expect(syncedPaths).toEqual([filePath, finalParent, firstParent]);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("syncs newly created ancestry through its existing parent", async () => {
    const directory = await createTempDir();
    try {
      const firstParent = path.join(directory, "first");
      const secondParent = path.join(firstParent, "second");
      const filePath = path.join(secondParent, "manifest.json");
      const syncedPaths: string[] = [];

      await publishPrivateFileAtomically(filePath, "private\n", {
        syncParent: async (publishedPath) => {
          syncedPaths.push(publishedPath);
        },
      });

      expect(syncedPaths).toEqual(expectedAncestrySyncPaths(filePath, firstParent));
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("publishes through a newly created descendant beginning with two dots", async () => {
    const directory = await createTempDir();
    try {
      const firstParent = path.join(directory, "first");
      const dottedParent = path.join(firstParent, "..cache");
      const finalParent = path.join(dottedParent, "nested");
      const filePath = path.join(finalParent, "manifest.json");
      const syncedPaths: string[] = [];

      await publishPrivateFileAtomically(filePath, "private\n", {
        syncParent: async (publishedPath) => {
          syncedPaths.push(publishedPath);
        },
      });

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
      await expect(fs.readdir(finalParent)).resolves.toEqual(["manifest.json"]);
      expect(syncedPaths).toEqual(expectedAncestrySyncPaths(filePath, firstParent));
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("resyncs pre-existing ancestry after an interrupted publication attempt", async () => {
    const directory = await createTempDir();
    const ancestrySyncFailure = new Error("simulated ancestry sync interruption");
    try {
      const filePath = path.join(directory, "first", "second", "manifest.json");
      const syncAttempts: string[][] = [[], []];
      let attempt = 0;
      const syncParent = async (publishedPath: string) => {
        syncAttempts[attempt]!.push(publishedPath);
        if (attempt === 0) {
          throw ancestrySyncFailure;
        }
        if (publishedPath === directory) {
          throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
        }
      };

      await expect(publishPrivateFileAtomically(filePath, "first\n", { syncParent })).rejects.toBe(
        ancestrySyncFailure,
      );
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("first\n");

      attempt = 1;
      await publishPrivateFileAtomically(filePath, "second\n", { syncParent });

      expect(syncAttempts[0]).toEqual([filePath]);
      expect(syncAttempts[1]).toEqual([
        filePath,
        path.dirname(filePath),
        path.dirname(path.dirname(filePath)),
        directory,
      ]);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second\n");
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("uses Windows PowerShell to atomically create and verify the current SID ACL", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "123:456";
    };
    const filePath = String.raw`C:\Temp\crabline-manifest.json`;

    await expect(
      createOwnerOnlyWindowsFile(filePath, run, String.raw`C:\Windows`),
    ).resolves.toEqual({
      device: 123n,
      inode: 456n,
    });

    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0]!;
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    const script = args.at(-1);
    expect(script).toContain("WindowsIdentity");
    expect(script).toContain("[System.IO.FileMode]::CreateNew");
    expect(script).toContain("[System.Security.AccessControl.FileSecurity]::new()");
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
    expect(script).toContain("$stream.GetAccessControl()");
    expect(script).toContain("NtQueryInformationFile");
    expect(script).toContain("FileInternalInformationClass = 6");
    expect(script).toContain("NtQueryVolumeInformationFile");
    expect(script).toContain("FileFsVolumeInformationClass = 1");
    expect(script).not.toContain("Set-Acl");
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("$rules.Count -ne 1");
    expect(options.env.CRABLINE_PRIVATE_FILE_PATH).toBe(path.resolve(filePath));
    expect(options.windowsHide).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "stops Windows claim ancestry before system-owned directories",
    async () => {
      const directory = await createTempDir();
      try {
        const filePath = path.join(directory, "manifest.json");

        await publishPrivateFileAtomically(filePath, "private\n");

        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("private\n");
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("uses an inheritable protected Windows ACL for generation directories", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };
    const directoryPath = String.raw`C:\Temp\crabline-generation`;

    await applyOwnerOnlyWindowsDirectoryAcl(directoryPath, run, String.raw`C:\Windows`);

    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0]!;
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    const script = args.at(-1);
    expect(script).toContain("ContainerInherit");
    expect(script).toContain("ObjectInherit");
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
    expect(script).toContain("owner-only inheritable full control");
    expect(options.env.CRABLINE_PRIVATE_DIRECTORY_PATH).toBe(path.resolve(directoryPath));
  });

  it("uses CreateDirectoryW with a protected ACL for every missing Windows ancestor", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return String.raw`C:\Temp\private`;
    };
    const directoryPath = String.raw`C:\Temp\private\nested`;

    await expect(
      createOwnerOnlyWindowsDirectoryAncestry(directoryPath, run, String.raw`C:\Windows`),
    ).resolves.toBe(String.raw`C:\Temp\private`);

    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0]!;
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    const script = args.at(-1);
    expect(script).toContain("CreateDirectory(");
    expect(script).toContain("SecurityAttributes");
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
    expect(script).toContain("New private directory was populated during creation.");
    expect(script).not.toContain("Set-Acl");
    expect(options.env.CRABLINE_PRIVATE_DIRECTORY_PATH).toBe(path.resolve(directoryPath));
  });

  it("fails closed when a Windows ancestry component wins the CreateNew race", async () => {
    const cause = Object.assign(new Error("already exists"), { code: 183 });

    await expect(
      createOwnerOnlyWindowsDirectoryAncestry(
        String.raw`C:\Temp\private\nested`,
        async () => {
          throw cause;
        },
        String.raw`C:\Windows`,
      ),
    ).rejects.toMatchObject({
      cause,
      message:
        "Could not atomically create and verify owner-only Windows private directory ancestry; Windows PowerShell security descriptor support is required.",
    });
  });

  it("verifies Windows mutation parents without changing their ACL", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };
    const directoryPath = String.raw`C:\Temp\private`;

    await verifyOwnerOnlyWindowsDirectoryAcl(directoryPath, run, String.raw`C:\Windows`);

    const [, args, options] = calls[0]!;
    const script = args.at(-1);
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("owner-only inheritable full control");
    expect(script).not.toContain("Set-Acl");
    expect(options.env.CRABLINE_PRIVATE_DIRECTORY_PATH).toBe(path.resolve(directoryPath));
  });

  it("verifies Windows mutation claim files without changing their ACL", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };
    const filePath = String.raw`C:\Temp\.crabline-private-mutation.claim`;

    await verifyOwnerOnlyWindowsFileAcl(filePath, run, String.raw`C:\Windows`);

    const [, args, options] = calls[0]!;
    const script = args.at(-1);
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("Private file DACL is not owner-only full control.");
    expect(script).not.toContain("Set-Acl");
    expect(options.env.CRABLINE_PRIVATE_FILE_PATH).toBe(path.resolve(filePath));
  });

  it.skipIf(process.platform !== "win32")(
    "rejects a Windows mutation claim writable by another principal",
    async () => {
      const directory = await createTempDir();
      try {
        const claimPath = path.join(directory, ".crabline-private-mutation.claim");
        await fs.writeFile(
          claimPath,
          `${JSON.stringify({
            ownerId: "planted-windows-owner",
            pid: process.pid,
            processIdentity: "planted:windows-owner",
            processStartedAtMs: 100,
          })}\n`,
        );
        execFileSync("icacls.exe", [claimPath, "/inheritance:r", "/grant", "*S-1-1-0:(F)"], {
          stdio: "ignore",
        });

        await expect(
          publishPrivateFileAtomically(path.join(directory, "manifest.json"), "private\n"),
        ).rejects.toThrow("Private mutation claim must have an owner-only protected Windows ACL.");

        await expect(fs.stat(path.join(directory, "manifest.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("checks generic Windows access masks when verifying mutation ancestry", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };

    await verifySafeWindowsDirectoryMutationBoundary(
      String.raw`C:\Temp`,
      run,
      String.raw`C:\Windows`,
    );

    const script = calls[0]![1].at(-1);
    expect(script).toContain("$genericMutationRights = [uint32]0x50000000");
    expect(script).toContain('"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"');
    expect(script).toContain("[BitConverter]::GetBytes([int32]$rule.FileSystemRights)");
    expect(script).toContain(
      "$ruleAccessMask -band ($mutationAccessMask -bor $genericMutationRights)",
    );
  });

  it("checks Windows delete-child rights when verifying mutation boundary ancestry", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };

    await verifySafeWindowsDirectoryEntryParent(String.raw`C:\Users`, run, String.raw`C:\Windows`);

    const script = calls[0]![1].at(-1);
    expect(script).toContain("DeleteSubdirectoriesAndFiles");
    expect(script).toContain("ChangePermissions");
    expect(script).toContain("TakeOwnership");
    expect(script).toContain("$ancestorReplacementMask");
    expect(script).toContain("$genericAll = [uint32]0x10000000");
    expect(script).toContain('"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"');
    expect(script).toContain("[BitConverter]::GetBytes([int32]$rule.FileSystemRights)");
    expect(script).toContain("$appliesToDirectory");
    expect(script).not.toContain("Set-Acl");
  });

  it.skipIf(process.platform !== "win32")(
    "rejects Windows mutation boundary ancestry with untrusted delete-child rights",
    async () => {
      const directory = await createTempDir();
      try {
        execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant", "*S-1-1-0:(F)"], {
          stdio: "ignore",
        });

        await expect(verifySafeWindowsDirectoryEntryParent(directory)).rejects.toThrow(
          "Private mutation boundary has a replaceable Windows ancestor.",
        );
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects generic write access granted to Everyone on Windows",
    async () => {
      const directory = await createTempDir();
      try {
        execFileSync(
          "icacls.exe",
          [directory, "/inheritance:r", "/grant", "*S-1-1-0:(OI)(CI)(GW)"],
          { stdio: "ignore" },
        );

        await expect(verifySafeWindowsDirectoryMutationBoundary(directory)).rejects.toThrow(
          "Private mutation ancestry has an unsafe Windows ACL.",
        );
      } finally {
        await disposeTempDir(directory);
      }
    },
  );

  it("reports Windows ACL tooling failures with their cause", async () => {
    const cause = new Error("powershell.exe missing");
    await expect(
      createOwnerOnlyWindowsFile(
        "manifest.json",
        async () => {
          throw cause;
        },
        String.raw`C:\Windows`,
      ),
    ).rejects.toMatchObject({
      cause,
      message:
        "Could not atomically create and verify an owner-only Windows private file; Windows PowerShell ACL support is required.",
    });
  });

  it.each(["", "not-an-identity", "123:0"])(
    "fails closed when Windows cannot prove the created file identity: %j",
    async (output) => {
      await expect(
        createOwnerOnlyWindowsFile("manifest.json", async () => output, String.raw`C:\Windows`),
      ).rejects.toThrow(
        "Could not atomically create and verify an owner-only Windows private file",
      );
    },
  );

  it("fails closed when SystemRoot is missing or non-local", async () => {
    const run = vi.fn<WindowsAclRunner>();

    await expect(createOwnerOnlyWindowsFile("manifest.json", run, null)).rejects.toThrow(
      "Could not atomically create and verify an owner-only Windows private file",
    );
    await expect(
      createOwnerOnlyWindowsFile("manifest.json", run, String.raw`\\server\windows`),
    ).rejects.toThrow("Could not atomically create and verify an owner-only Windows private file");
    expect(run).not.toHaveBeenCalled();
  });
});
