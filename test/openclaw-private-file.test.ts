import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyOwnerOnlyWindowsAcl,
  applyOwnerOnlyWindowsDirectoryAcl,
  publishPrivateFileAtomically,
  securePrivateDirectory,
  type WindowsAclRunner,
} from "../src/openclaw/private-file.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

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
  it("replaces permissive POSIX files with mode 0600", async () => {
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
  });

  it("secures POSIX generation directories with mode 0700", async () => {
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
  });

  it("resyncs an existing private directory after an interrupted creation", async () => {
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
  });

  it.each(["EACCES", "EPERM"] as const)(
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

  it.each(["EACCES", "EPERM"] as const)(
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
      const secureWindowsDirectory = vi.fn(async (securedPath: string) => {
        expect(securedPath).toBe(generationPath);
        expect(await fs.readdir(securedPath)).toEqual([]);
      });

      const secured = await securePrivateDirectory(generationPath, {
        platform: "win32",
        secureWindowsDirectory,
      });
      await secured.assertIdentityAt();
      await fs.writeFile(path.join(generationPath, "manifest.json"), "private\n");

      expect(secureWindowsDirectory).toHaveBeenCalledTimes(1);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("rejects a Windows generation directory path substitution before child creation", async () => {
    const directory = await createTempDir();
    try {
      const generationPath = path.join(directory, "generation");
      const originalPath = `${generationPath}.original`;

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

      await expect(
        publishPrivateFileAtomically(filePath, "private\n", {
          platform: "win32",
          secureWindowsFile: async (temporaryPath) => {
            originalTemporaryPath = `${temporaryPath}.original`;
            await fs.rename(temporaryPath, originalTemporaryPath);
            await fs.writeFile(temporaryPath, "substitute\n");
          },
        }),
      ).rejects.toThrow("Private file path identity changed during publication.");

      expect(await fs.readFile(filePath, "utf8")).toBe("stale\n");
      expect(originalTemporaryPath).toBeDefined();
      expect(await fs.readFile(originalTemporaryPath!, "utf8")).toBe("");
      expect((await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
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

  it("uses Windows PowerShell to set and verify the current SID ACL", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
    };
    const filePath = String.raw`C:\Temp\crabline-manifest.json`;

    await applyOwnerOnlyWindowsAcl(filePath, run, String.raw`C:\Windows`);

    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0]!;
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    const script = args.at(-1);
    expect(script).toContain("WindowsIdentity");
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
    expect(script).toContain("RemoveAccessRuleSpecific");
    expect(script).toContain("Set-Acl");
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("$rules.Count -ne 1");
    expect(options.env.CRABLINE_PRIVATE_FILE_PATH).toBe(path.resolve(filePath));
    expect(options.windowsHide).toBe(true);
  });

  it("uses an inheritable protected Windows ACL for generation directories", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
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

  it("reports Windows ACL tooling failures with their cause", async () => {
    const cause = new Error("powershell.exe missing");
    await expect(
      applyOwnerOnlyWindowsAcl(
        "manifest.json",
        async () => {
          throw cause;
        },
        String.raw`C:\Windows`,
      ),
    ).rejects.toMatchObject({
      cause,
      message:
        "Could not apply and verify an owner-only Windows ACL; powershell.exe with Set-Acl is required.",
    });
  });

  it("fails closed when SystemRoot is missing or non-local", async () => {
    const run = vi.fn<WindowsAclRunner>();

    await expect(applyOwnerOnlyWindowsAcl("manifest.json", run, null)).rejects.toThrow(
      "Could not apply and verify an owner-only Windows ACL",
    );
    await expect(
      applyOwnerOnlyWindowsAcl("manifest.json", run, String.raw`\\server\windows`),
    ).rejects.toThrow("Could not apply and verify an owner-only Windows ACL");
    expect(run).not.toHaveBeenCalled();
  });
});
