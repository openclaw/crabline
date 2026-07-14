import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOwnerOnlyWindowsDirectoryAcl,
  createOwnerOnlyWindowsDirectory,
  readWindowsDirectoryNamespaceSecuritySnapshot,
  readWindowsDirectorySecurityDescriptor,
  readWindowsDirectorySecuritySnapshot,
  type WindowsAclRunner,
} from "../src/platform/windows-acl.js";
import { isManagedRecorderDirectory } from "../src/platform/recorder-directory.js";
import {
  appendRecordedInbound,
  appendRecordedInboundBatch,
  cloneRecordedInboundCursor,
  createRecordedInboundCursor,
  readRecordedInbound,
  secureProviderRecorderLockRoot,
  waitForRecordedInbound,
  watchRecordedInbound,
} from "../src/providers/recorder.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const directories: string[] = [];
const stableWindowsDirectoryIdentity = "10:00000000000000000000000000000014";
const readOwnerOnlyWindowsDirectorySecuritySnapshot = async (directoryPath: string) => {
  const stats = await lstat(directoryPath, { bigint: true });
  const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  return {
    identity,
    pathIdentity: identity,
    securityDescriptor: "owner-only",
  };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createRecorderPath(): Promise<string> {
  const directory = await createTempDir();
  directories.push(directory);
  return path.join(directory, "inbound.jsonl");
}

function runAfterDelay<T>(operation: () => Promise<T>, delayMs = 25): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      void operation().then(resolve, reject);
    }, delayMs);
  });
}

type RecorderFileHandlePrototype = {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ buffer: Uint8Array; bytesWritten: number }>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
};

function interceptRecorderWrites(
  prototype: RecorderFileHandlePrototype,
  intercept: (data: string, write: () => Promise<void>) => Promise<void>,
): () => void {
  const originalWrite = prototype.write;
  const originalWriteFile = prototype.writeFile;
  if (process.platform === "win32") {
    prototype.write = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) {
      let result: { buffer: Uint8Array; bytesWritten: number } | undefined;
      await intercept(
        Buffer.from(buffer)
          .subarray(offset, offset + length)
          .toString("utf8"),
        async () => {
          result = await originalWrite.call(this, buffer, offset, length, position);
        },
      );
      return result!;
    };
  } else {
    prototype.writeFile = async function (
      this: FileHandle,
      data: string,
      encoding: BufferEncoding,
    ) {
      await intercept(data, async () => {
        await originalWriteFile.call(this, data, encoding);
      });
    };
  }
  return () => {
    prototype.write = originalWrite;
    prototype.writeFile = originalWriteFile;
  };
}

describe("recorder", () => {
  it("returns an empty list for a missing recorder file", async () => {
    const filePath = await createRecorderPath();
    await expect(readRecordedInbound(filePath)).resolves.toEqual([]);
  });

  it("does not create a recorder for an empty batch", async () => {
    const filePath = await createRecorderPath();
    await expect(appendRecordedInboundBatch(filePath, [])).resolves.toEqual([]);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends and reads recorded inbound events", async () => {
    const filePath = await createRecorderPath();

    await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "evt-1",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "hello",
      threadId: "slack:C123",
    });

    const events = await readRecordedInbound(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]?.recordedAt).toBeTypeOf("string");
    expect(events[0]?.text).toBe("hello");
  });

  it.skipIf(process.platform === "win32")(
    "creates owner-only recorder files without changing existing permissions",
    async () => {
      const filePath = await createRecorderPath();
      const event = {
        author: "assistant" as const,
        id: "private-recorder",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "private",
        threadId: "slack:C123",
      };

      await appendRecordedInbound(filePath, event);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);

      await chmod(filePath, 0o640);
      await appendRecordedInbound(filePath, { ...event, id: "preserve-mode" });
      expect((await stat(filePath)).mode & 0o777).toBe(0o640);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts trusted private and sticky shared lock-root parents",
    async () => {
      const currentUserId = process.geteuid?.();
      if (currentUserId === undefined) {
        throw new Error("Expected a current user id on Unix.");
      }
      for (const mode of [0o700, 0o1777]) {
        const directory = await realpath(await createTempDir());
        directories.push(directory);
        const parent = path.join(directory, `parent-${mode.toString(8)}`);
        const lockRoot = path.join(parent, "locks");
        await mkdir(parent, { mode });
        await chmod(parent, mode);

        const secured = await secureProviderRecorderLockRoot(lockRoot, currentUserId);
        expect(secured).toBe(await realpath(lockRoot));
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a peer-writable non-sticky lock-root parent",
    async () => {
      const currentUserId = process.geteuid?.();
      if (currentUserId === undefined) {
        throw new Error("Expected a current user id on Unix.");
      }
      const directory = await realpath(await createTempDir());
      directories.push(directory);
      const parent = path.join(directory, "untrusted-parent");
      const lockRoot = path.join(parent, "locks");
      await mkdir(parent, { mode: 0o777 });
      await chmod(parent, 0o777);

      await expect(secureProviderRecorderLockRoot(lockRoot, currentUserId)).rejects.toThrow(
        "Provider recorder lock directory parent namespace is not trusted.",
      );
      await expect(stat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates and validates missing private lock-root ancestry",
    async () => {
      const currentUserId = process.geteuid?.();
      if (currentUserId === undefined) {
        throw new Error("Expected a current user id on Unix.");
      }
      const directory = await realpath(await createTempDir());
      directories.push(directory);
      const lockRoot = path.join(directory, "missing", "private", "locks");

      const secured = await secureProviderRecorderLockRoot(lockRoot, currentUserId);
      expect(secured).toBe(await realpath(lockRoot));
    },
  );

  it.skipIf(process.platform === "win32")(
    "revalidates trust after the lock-root parent is replaced",
    async () => {
      const currentUserId = process.geteuid?.();
      if (currentUserId === undefined) {
        throw new Error("Expected a current user id on Unix.");
      }
      const directory = await realpath(await createTempDir());
      directories.push(directory);
      const namespace = path.join(directory, "replaceable-namespace");
      const displaced = `${namespace}.displaced`;
      const parent = path.join(namespace, "private-parent");
      const lockRoot = path.join(parent, "locks");
      await mkdir(parent, { mode: 0o700, recursive: true });
      const secured = await secureProviderRecorderLockRoot(lockRoot, currentUserId);
      expect(secured).toBe(await realpath(lockRoot));

      await rename(namespace, displaced);
      await mkdir(lockRoot, { mode: 0o700, recursive: true });
      await chmod(namespace, 0o777);

      await expect(secureProviderRecorderLockRoot(lockRoot, currentUserId)).rejects.toThrow(
        "Provider recorder lock directory parent namespace is not trusted.",
      );
    },
  );

  it("secures Windows recorder lock roots before use", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "locks");
    const secured: string[] = [];

    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        platform: "win32",
        createWindowsDirectory: async (directoryPath) => {
          await expect(stat(directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
          await mkdir(directoryPath);
          secured.push(directoryPath);
        },
        readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);
    await mkdir(path.join(lockRoot, "active-lock"));
    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        platform: "win32",
        createWindowsDirectory: async () => {
          throw new Error("cached Windows lock root was re-secured");
        },
        readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);

    expect(secured).toEqual([lockRoot]);
  });

  it("recreates a cached Windows recorder lock root after deletion", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "recreated-locks");
    const createWindowsDirectory = async (directoryPath: string) => {
      await mkdir(directoryPath);
    };

    await secureProviderRecorderLockRoot(lockRoot, undefined, {
      createWindowsDirectory,
      platform: "win32",
      readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
    });
    await rm(lockRoot, { force: true, recursive: true });
    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);
    await expect(stat(lockRoot)).resolves.toBeDefined();
  });

  it("retries Windows recorder lock-root creation after a cached promise rejects", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "retried-locks");
    const timeout = Object.assign(new Error("PowerShell ACL command timed out"), {
      code: "ETIMEDOUT",
      killed: true,
      signal: "SIGKILL",
    });
    let createCount = 0;
    const createWindowsDirectory = async (directoryPath: string) => {
      createCount += 1;
      if (createCount === 1) {
        throw timeout;
      }
      await mkdir(directoryPath);
    };
    const options = {
      createWindowsDirectory,
      platform: "win32" as const,
      readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
    };

    await expect(secureProviderRecorderLockRoot(lockRoot, undefined, options)).rejects.toBe(
      timeout,
    );
    await expect(secureProviderRecorderLockRoot(lockRoot, undefined, options)).resolves.toBe(
      lockRoot,
    );

    expect(createCount).toBe(2);
  });

  it("deduplicates concurrent Windows recorder lock-root replacement recovery", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "concurrent-recreated-locks");
    let createCount = 0;
    const createWindowsDirectory = async (directoryPath: string) => {
      createCount += 1;
      await mkdir(directoryPath, { recursive: true });
    };

    await secureProviderRecorderLockRoot(lockRoot, undefined, {
      createWindowsDirectory,
      platform: "win32",
      readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
    });
    await rm(lockRoot, { force: true, recursive: true });
    await mkdir(lockRoot);
    await Promise.all([
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
      }),
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
      }),
    ]);

    expect(createCount).toBe(2);
  });

  it("rejects non-directory Windows recorder lock roots returned by the atomic creator", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "locks");

    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        platform: "win32",
        createWindowsDirectory: async (directoryPath) => {
          await writeFile(directoryPath, "not a directory");
        },
        readWindowsDirectorySecuritySnapshot: readOwnerOnlyWindowsDirectorySecuritySnapshot,
      }),
    ).rejects.toThrow("Provider recorder lock directory is not a private directory.");
  });

  it("re-secures a cached Windows recorder lock root after its ACL changes", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "acl-replaced-locks");
    let createCount = 0;
    let securityDescriptor = "owner-only";
    const createWindowsDirectory = async (directoryPath: string) => {
      createCount += 1;
      await mkdir(directoryPath, { recursive: true });
      securityDescriptor = "owner-only";
    };
    const readSecuritySnapshot = async () => ({
      identity: stableWindowsDirectoryIdentity,
      pathIdentity: stableWindowsDirectoryIdentity,
      securityDescriptor,
    });

    await secureProviderRecorderLockRoot(lockRoot, undefined, {
      createWindowsDirectory,
      platform: "win32",
      readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
    });
    await mkdir(path.join(lockRoot, "acl-change-trigger"));
    securityDescriptor = "unsafe";

    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);

    expect(createCount).toBe(2);
  });

  it("re-secures a cached Windows recorder lock root when its handle identity changes", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "handle-replaced-locks");
    let createCount = 0;
    let handleIdentity = stableWindowsDirectoryIdentity;
    const createWindowsDirectory = async (directoryPath: string) => {
      createCount += 1;
      await mkdir(directoryPath, { recursive: true });
      handleIdentity = stableWindowsDirectoryIdentity;
    };
    const readSecuritySnapshot = async () => ({
      identity: handleIdentity,
      pathIdentity: handleIdentity,
      securityDescriptor: "owner-only",
    });

    await secureProviderRecorderLockRoot(lockRoot, undefined, {
      createWindowsDirectory,
      platform: "win32",
      readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
    });
    handleIdentity = "10:00000000000000000000000000000015";

    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);

    expect(createCount).toBe(2);
  });

  it("does not reject Windows recorder lock-root child churn during ACL inspection", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "active-locks");
    let descriptorReads = 0;
    const readSecuritySnapshot = async () => {
      descriptorReads += 1;
      if (descriptorReads === 2) {
        await mkdir(path.join(lockRoot, "concurrent-lock"));
      }
      return {
        identity: stableWindowsDirectoryIdentity,
        pathIdentity: stableWindowsDirectoryIdentity,
        securityDescriptor: "owner-only",
      };
    };
    const createWindowsDirectory = async (directoryPath: string) => {
      await mkdir(directoryPath, { recursive: true });
    };

    await secureProviderRecorderLockRoot(lockRoot, undefined, {
      createWindowsDirectory,
      platform: "win32",
      readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
    });
    await mkdir(path.join(lockRoot, "acl-check-trigger"));

    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);

    expect(descriptorReads).toBe(3);
  });

  it("recovers when a Windows recorder lock root disappears during ACL inspection", async () => {
    const directory = await createTempDir();
    directories.push(directory);
    const lockRoot = path.join(directory, "disappearing-locks");
    let createCount = 0;
    let descriptorReads = 0;
    const createWindowsDirectory = async (directoryPath: string) => {
      createCount += 1;
      await mkdir(directoryPath, { recursive: true });
    };
    const readSecuritySnapshot = async () => {
      descriptorReads += 1;
      if (descriptorReads === 3) {
        await rm(lockRoot, { force: true, recursive: true });
        throw Object.assign(new Error("lock root removed during Get-Acl"), { code: "ENOENT" });
      }
      return {
        identity: stableWindowsDirectoryIdentity,
        pathIdentity: stableWindowsDirectoryIdentity,
        securityDescriptor: "owner-only",
      };
    };

    await secureProviderRecorderLockRoot(lockRoot, undefined, {
      createWindowsDirectory,
      platform: "win32",
      readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
    });
    await mkdir(path.join(lockRoot, "acl-check-trigger"));

    await expect(
      secureProviderRecorderLockRoot(lockRoot, undefined, {
        createWindowsDirectory,
        platform: "win32",
        readWindowsDirectorySecuritySnapshot: readSecuritySnapshot,
      }),
    ).resolves.toBe(lockRoot);

    expect(createCount).toBe(2);
    expect(descriptorReads).toBe(5);
  });

  it("creates Windows recorder lock roots with their final ACL atomically", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };
    const directoryPath = String.raw`C:\Temp\crabline-recorder-locks`;

    await createOwnerOnlyWindowsDirectory(directoryPath, run, String.raw`C:\Windows`);

    expect(calls).toHaveLength(1);
    const [, args, options] = calls[0]!;
    const script = args.at(-1)!;
    expect(script).toContain("[System.Security.AccessControl.DirectorySecurity]::new()");
    expect(script).toContain("[System.IO.Directory]::Exists($current)");
    expect(script).toContain("$directoryPath.TrimEnd(");
    expect(script).toContain("NtCreateFile(");
    expect(script).toContain("FileCreate");
    expect(script).toContain("FileDirectoryFile");
    expect(script).toContain("FileOpenReparsePoint");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::Create(");
    expect(script.indexOf('StartsWith(@"\\\\?\\",')).toBeLessThan(
      script.indexOf('StartsWith(@"\\\\",'),
    );
    expect(script).toContain("FileFlagOpenReparsePoint");
    expect(script).toContain("DirectoryAttribute");
    expect(script).toContain("ReparsePointAttribute");
    expect(script).toContain("GetFileInformationByHandleEx(");
    expect(script).toContain("FileIdInfoClass");
    expect(script).toContain("GetSecurityInfo(");
    expect(script).toContain("SetSecurityInfo(");
    expect(script).toContain("Assert-SafeParentNamespace");
    expect(script).toContain("RawSecurityDescriptor");
    expect(script).toContain("DiscretionaryAclPresent");
    expect(script).toContain("Private directory parent namespace has a null DACL.");
    expect(script).toContain("CreateDirectories");
    expect(script).toContain(
      "$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly",
    );
    expect(script).toContain("(($parentRule.PropagationFlags -band $inheritOnly) -ne 0)");
    expect(script).not.toContain("-not $rejectChildCreation -and");
    expect(script).toContain(
      "if (([int64]$parentRule.FileSystemRights -band $unsafeRights) -ne 0)",
    );
    expect(script).toContain("WriteData");
    expect(script).toContain("WriteAttributes");
    expect(script).toContain("[int64]0x40000000");
    expect(script).toContain("DeleteSubdirectoriesAndFiles");
    expect(script).toContain("Assert-SafeNamespaceChain $current ($missing.Count -gt 0)");
    expect(script).toContain("Private directory parent namespace permits untrusted replacement.");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::Create(");
    expect(script).toContain("catch [System.ComponentModel.Win32Exception]");
    expect(script).toContain("$_.Exception.NativeErrorCode -ne 80");
    expect(script).toContain("$_.Exception.NativeErrorCode -ne 183");
    expect(script).toContain(
      "[void][CrablineWindowsDirectoryHandle]::ReadIdentity($createdDirectory)",
    );
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::WriteSecurityDescriptor(");
    expect(script).toContain("AssertSamePathIdentity");
    expect(script).not.toContain("[System.IO.Directory]::CreateDirectory(");
    expect(script).not.toContain("$directory.SetAccessControl($acl)");
    expect(options.env.CRABLINE_PRIVATE_DIRECTORY_PATH).toBe(path.resolve(directoryPath));
    expect(options.killSignal).toBe("SIGKILL");
    expect(options.timeout).toBe(15_000);
  });

  it("applies Windows recorder ACLs through a no-follow identity-bound handle", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return "";
    };
    const directoryPath = String.raw`C:\Temp\crabline-recorder-locks`;

    await applyOwnerOnlyWindowsDirectoryAcl(directoryPath, run, String.raw`C:\Windows`);

    const [, args, options] = calls[0]!;
    const script = args.at(-1);
    expect(script).toContain("FileFlagOpenReparsePoint");
    expect(script).toContain("DirectoryAttribute");
    expect(script).toContain("GetFileInformationByHandleEx(");
    expect(script).toContain("FileIdInfoClass");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::Open($directoryPath, $true)");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::WriteSecurityDescriptor(");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::AssertSamePathIdentity(");
    expect(script).not.toContain("Set-Acl");
    expect(options.killSignal).toBe("SIGKILL");
    expect(options.timeout).toBe(15_000);
  });

  it("reads Windows directory identity and ACL from one no-follow handle", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return `${stableWindowsDirectoryIdentity}\r\n${stableWindowsDirectoryIdentity}\r\ndescriptor-base64`;
    };
    const directoryPath = String.raw`C:\Temp\crabline-recorder-locks`;

    await expect(
      readWindowsDirectorySecuritySnapshot(directoryPath, run, String.raw`C:\Windows`),
    ).resolves.toEqual({
      identity: stableWindowsDirectoryIdentity,
      pathIdentity: stableWindowsDirectoryIdentity,
      securityDescriptor: "descriptor-base64",
    });

    const [, args, options] = calls[0]!;
    const script = args.at(-1);
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("$rules.Count -ne 1");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::Open($directoryPath, $false)");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::ReadIdentity($directory)");
    expect(script).toContain(
      "[CrablineWindowsDirectoryHandle]::ReadSecurityDescriptor($directory)",
    );
    expect(script).toContain(
      "$pathIdentity = [CrablineWindowsDirectoryHandle]::ReadPathIdentity($directoryPath)",
    );
    expect(script).toContain("$pathIdentity -ne $directoryIdentity");
    expect(script).toContain("[Convert]::ToBase64String($descriptor)");
    expect(script).toContain("Assert-SafeNamespaceChain $parent.FullName $false");
    expect(script).toContain("RawSecurityDescriptor");
    expect(script).toContain("Private directory must not be a reparse point.");
    expect(script).toContain("Private directory parent namespace has a null DACL.");
    expect(script).toContain("$rejectChildCreationAtCandidate = $false");
    expect(script).toContain("Private directory parent namespace permits untrusted replacement.");
    expect(script).not.toContain("Get-Acl");
    expect(options.env.CRABLINE_PRIVATE_DIRECTORY_PATH).toBe(path.resolve(directoryPath));
    expect(options.killSignal).toBe("SIGKILL");
    expect(options.timeout).toBe(15_000);
  });

  it("validates a Windows directory namespace without requiring an owner-only ACL", async () => {
    const calls: Parameters<WindowsAclRunner>[] = [];
    const run: WindowsAclRunner = async (...args) => {
      calls.push(args);
      return `${stableWindowsDirectoryIdentity}\r\n${stableWindowsDirectoryIdentity}\r\ndescriptor-base64`;
    };
    const directoryPath = String.raw`C:\Temp\custom-recorder`;

    await expect(
      readWindowsDirectoryNamespaceSecuritySnapshot(directoryPath, run, String.raw`C:\Windows`),
    ).resolves.toEqual({
      identity: stableWindowsDirectoryIdentity,
      pathIdentity: stableWindowsDirectoryIdentity,
      securityDescriptor: "descriptor-base64",
    });

    const [, args, options] = calls[0]!;
    const script = args.at(-1);
    expect(script).toContain("Assert-SafeNamespaceChain $directoryPath $true");
    expect(script).toContain("[CrablineWindowsDirectoryHandle]::Open($directoryPath, $false)");
    expect(script).toContain(
      "$pathIdentity = [CrablineWindowsDirectoryHandle]::ReadPathIdentity($directoryPath)",
    );
    expect(script).toContain("$pathIdentity -ne $directoryIdentity");
    expect(script).not.toContain("[CrablineWindowsDirectoryHandle]::WriteSecurityDescriptor(");
    expect(options.env.CRABLINE_PRIVATE_DIRECTORY_PATH).toBe(path.resolve(directoryPath));
  });

  it("rejects Windows security snapshots whose outer path resolves to another handle", async () => {
    const replacementIdentity = "10:00000000000000000000000000000015";

    await expect(
      readWindowsDirectorySecuritySnapshot(
        String.raw`C:\Temp\crabline-recorder-locks`,
        async () =>
          `${stableWindowsDirectoryIdentity}\r\n${replacementIdentity}\r\ndescriptor-base64`,
        String.raw`C:\Windows`,
      ),
    ).rejects.toThrow(
      "Could not read the Windows directory security descriptor through a stable no-follow handle",
    );
  });

  it("matches managed Windows recorder directories case-insensitively", () => {
    expect(isManagedRecorderDirectory(path.resolve("ARTIFACTS", "CRABLINE"), "win32")).toBe(true);
    expect(isManagedRecorderDirectory(path.resolve(".CRABLINE", "SERVERS"), "win32")).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "creates missing Windows recorder lock roots with an identity-bound handle",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const lockRoot = path.join(directory, "new-lock-root");

      await expect(createOwnerOnlyWindowsDirectory(lockRoot)).resolves.toBeUndefined();
      await expect(stat(lockRoot)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "handles concurrent Windows recorder lock-root creation",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const lockRoot = path.join(directory, "concurrent-lock-root");

      await expect(
        Promise.all([
          createOwnerOnlyWindowsDirectory(lockRoot),
          createOwnerOnlyWindowsDirectory(lockRoot),
        ]),
      ).resolves.toEqual([undefined, undefined]);
      await expect(stat(lockRoot)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "creates missing Windows recorder lock roots through extended-length paths",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const lockRoot = path.join(directory, "extended-lock-root");

      await expect(
        createOwnerOnlyWindowsDirectory(path.toNamespacedPath(lockRoot)),
      ).resolves.toBeUndefined();
      await expect(stat(lockRoot)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "creates missing Windows recorder lock roots with trailing separators",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const lockRoot = path.join(directory, "trailing-separator-lock-root");

      await expect(
        createOwnerOnlyWindowsDirectory(`${lockRoot}${path.sep}`),
      ).resolves.toBeUndefined();
      await expect(stat(lockRoot)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "migrates existing Windows recorder lock roots to owner-only ACLs",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const lockRoot = path.join(directory, "existing-lock-root");
      await mkdir(lockRoot);

      await expect(createOwnerOnlyWindowsDirectory(lockRoot)).resolves.toBeUndefined();
      await expect(stat(lockRoot)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects regular files before applying a Windows directory ACL",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const filePath = path.join(directory, "not-a-directory");
      await writeFile(filePath, "contents", "utf8");

      await expect(applyOwnerOnlyWindowsDirectoryAcl(filePath)).rejects.toThrow(
        "Could not apply and verify an owner-only Windows directory ACL",
      );
      await expect(readFile(filePath, "utf8")).resolves.toBe("contents");
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects Windows recorder lock-root junctions without following their targets",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const target = path.join(directory, "target");
      const junction = path.join(directory, "junction");
      await mkdir(target);
      await symlink(target, junction, "junction");

      await expect(createOwnerOnlyWindowsDirectory(junction)).rejects.toThrow(
        "Could not atomically create or verify an owner-only Windows directory",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "does not create through dangling Windows recorder lock-root junctions",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const missingTarget = path.join(directory, "missing-target");
      const junction = path.join(directory, "dangling-junction");
      await symlink(missingTarget, junction, "junction");

      await expect(createOwnerOnlyWindowsDirectory(junction)).rejects.toThrow(
        "Could not atomically create or verify an owner-only Windows directory",
      );
      await expect(stat(missingTarget)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "does not create Windows recorder lock roots through intermediate junctions",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const target = path.join(directory, "target");
      const junction = path.join(directory, "junction");
      const lockRoot = path.join(junction, "lock-root");
      await mkdir(target);
      await symlink(target, junction, "junction");

      await expect(createOwnerOnlyWindowsDirectory(lockRoot)).rejects.toThrow(
        "Could not atomically create or verify an owner-only Windows directory",
      );
      await expect(stat(path.join(target, "lock-root"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects Windows recorder lock roots beneath a null-DACL parent",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const parent = path.join(directory, "null-dacl-parent");
      const lockRoot = path.join(parent, "lock-root");
      await mkdir(parent);

      const powershellPath = path.join(
        process.env.SystemRoot ?? String.raw`C:\Windows`,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      execFileSync(
        powershellPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$acl = Get-Acl -LiteralPath $env:CRABLINE_TEST_NULL_DACL",
            [
              '$acl.SetSecurityDescriptorSddlForm("D:NO_ACCESS_CONTROL",',
              "[System.Security.AccessControl.AccessControlSections]::Access)",
            ].join(" "),
            "Set-Acl -LiteralPath $env:CRABLINE_TEST_NULL_DACL -AclObject $acl",
          ].join("; "),
        ],
        {
          env: {
            ...process.env,
            CRABLINE_TEST_NULL_DACL: parent,
          },
          windowsHide: true,
        },
      );

      await expect(createOwnerOnlyWindowsDirectory(lockRoot)).rejects.toThrow(
        "Could not atomically create or verify an owner-only Windows directory",
      );
      await expect(stat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "repairs a cached Windows recorder lock root after its ACL is downgraded",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const lockRoot = path.join(directory, "downgraded-lock-root");

      await secureProviderRecorderLockRoot(lockRoot, undefined);
      execFileSync("icacls.exe", [lockRoot, "/inheritance:r", "/grant", "*S-1-1-0:(F)"], {
        windowsHide: true,
      });
      await expect(readWindowsDirectorySecurityDescriptor(lockRoot)).rejects.toThrow(
        "Could not read the Windows directory security descriptor",
      );

      await expect(secureProviderRecorderLockRoot(lockRoot, undefined)).resolves.toBe(lockRoot);
      await expect(readWindowsDirectorySecurityDescriptor(lockRoot)).resolves.toEqual(
        expect.any(String),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects cached Windows recorder lock roots after their parent becomes replaceable",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const parent = path.join(directory, "replaceable-parent");
      const lockRoot = path.join(parent, "lock-root");
      await mkdir(parent);

      await expect(secureProviderRecorderLockRoot(lockRoot, undefined)).resolves.toBe(lockRoot);
      execFileSync("icacls.exe", [parent, "/grant", "*S-1-1-0:(OI)(CI)(F)"], { windowsHide: true });

      try {
        await expect(secureProviderRecorderLockRoot(lockRoot, undefined)).rejects.toThrow(
          "Could not atomically create or verify an owner-only Windows directory",
        );
      } finally {
        execFileSync("icacls.exe", [parent, "/remove:g", "*S-1-1-0"], {
          windowsHide: true,
        });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects Windows recorder lock-root parents with untrusted child-creation rights",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const parent = path.join(directory, "creatable-parent");
      const lockRoot = path.join(parent, "lock-root");
      await mkdir(parent);
      execFileSync("icacls.exe", [parent, "/grant", "*S-1-1-0:(AD)"], {
        windowsHide: true,
      });

      try {
        await expect(createOwnerOnlyWindowsDirectory(lockRoot)).rejects.toThrow(
          "Could not atomically create or verify an owner-only Windows directory",
        );
        await expect(stat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        execFileSync("icacls.exe", [parent, "/remove:g", "*S-1-1-0"], {
          windowsHide: true,
        });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "allows inherit-only child-creation rights on Windows recorder lock-root parents",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const parent = path.join(directory, "inherit-only-creatable-parent");
      const lockRoot = path.join(parent, "lock-root");
      await mkdir(parent);
      execFileSync("icacls.exe", [parent, "/grant", "*S-1-1-0:(CI)(IO)(AD)"], {
        windowsHide: true,
      });

      try {
        await expect(createOwnerOnlyWindowsDirectory(lockRoot)).resolves.toBeUndefined();
        await expect(stat(lockRoot)).resolves.toMatchObject({
          isDirectory: expect.any(Function),
        });
      } finally {
        execFileSync("icacls.exe", [parent, "/remove:g", "*S-1-1-0"], {
          windowsHide: true,
        });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects Windows recorder lock-root parents with untrusted reparse mutation rights",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      for (const [name, rights] of [
        ["specific", "WD,WA"],
        ["generic", "GW"],
      ] as const) {
        const parent = path.join(directory, `${name}-mutable-parent`);
        const lockRoot = path.join(parent, "lock-root");
        await mkdir(parent);
        execFileSync("icacls.exe", [parent, "/grant", `*S-1-1-0:(${rights})`], {
          windowsHide: true,
        });

        try {
          await expect(createOwnerOnlyWindowsDirectory(lockRoot)).rejects.toThrow(
            "Could not atomically create or verify an owner-only Windows directory",
          );
          await expect(stat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          execFileSync("icacls.exe", [parent, "/remove:g", "*S-1-1-0"], {
            windowsHide: true,
          });
        }
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects unsafe Windows provider recorder parents without changing their ACLs",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const filePath = path.join(directory, "provider.jsonl");
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)(F)"], {
        windowsHide: true,
      });
      const before = execFileSync("icacls.exe", [directory], {
        encoding: "utf8",
        windowsHide: true,
      });

      await expect(
        appendRecordedInbound(filePath, {
          author: "assistant",
          id: "unsafe-parent",
          provider: "slack",
          sentAt: new Date().toISOString(),
          text: "private",
          threadId: "slack:C123",
        }),
      ).rejects.toThrow("Could not validate the Windows directory namespace");

      const after = execFileSync("icacls.exe", [directory], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(after).toBe(before);
      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects child-inheritable Windows recorder ACLs without changing them",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const filePath = path.join(directory, "provider.jsonl");
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(IO)(M)"], {
        windowsHide: true,
      });
      const before = execFileSync("icacls.exe", [directory], {
        encoding: "utf8",
        windowsHide: true,
      });

      await expect(
        appendRecordedInbound(filePath, {
          author: "assistant",
          id: "inherited-unsafe-parent",
          provider: "slack",
          sentAt: new Date().toISOString(),
          text: "private",
          threadId: "slack:C123",
        }),
      ).rejects.toThrow("Could not validate the Windows directory namespace");

      const after = execFileSync("icacls.exe", [directory], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(after).toBe(before);
      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "creates missing Windows provider recorder parents with owner-only ACLs",
    async () => {
      const directory = await createTempDir();
      directories.push(directory);
      const parent = path.join(directory, "private-recorder");
      const filePath = path.join(parent, "provider.jsonl");

      await appendRecordedInbound(filePath, {
        author: "assistant",
        id: "private-parent",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "private",
        threadId: "slack:C123",
      });

      await expect(readWindowsDirectorySecurityDescriptor(parent)).resolves.toEqual(
        expect.any(String),
      );
    },
  );

  it("round-trips empty message text", async () => {
    const filePath = await createRecorderPath();
    const recorded = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "empty-text",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "",
      threadId: "slack:C123",
    });

    await expect(readRecordedInbound(filePath)).resolves.toEqual([recorded]);
  });

  it("rejects an oversized single append before it reaches the recorder", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "assistant" as const,
      id: "oversized-single",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "x".repeat(4 * 1024 * 1024),
      threadId: "slack:C123",
    };

    await expect(appendRecordedInbound(filePath, event)).rejects.toThrow(
      "Recorder record exceeded",
    );
    await expect(
      appendRecordedInbound(filePath, { ...event, id: "after-oversized", text: "small" }),
    ).resolves.toMatchObject({ id: "after-oversized" });
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "after-oversized" }),
    ]);
  });

  it("deduplicates inbound and outbound directions independently", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const sentAt = new Date().toISOString();
    const base = {
      id: "same-id",
      provider: "slack",
      sentAt,
      threadId: "slack:C123",
    };
    const outbound = await appendRecordedInbound(filePath, {
      ...base,
      author: "user",
      recordedDirection: "outbound",
      text: "outbound",
    });
    const inbound = await appendRecordedInbound(filePath, {
      ...base,
      author: "assistant",
      recordedDirection: "inbound",
      text: "inbound",
    });

    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(outbound);
    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(inbound);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => true,
        recordedDirection: "inbound",
        timeoutMs: 30,
      }),
    ).resolves.toEqual(inbound);
  });

  it("clears cursor deduplication when the recorder generation changes", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const event = {
      author: "assistant" as const,
      id: "reused-after-rotation",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first generation",
      threadId: "slack:C123",
    };
    await appendRecordedInbound(filePath, event);
    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toMatchObject({ text: "first generation" });

    await rename(filePath, `${filePath}.old`);
    await appendRecordedInbound(filePath, { ...event, text: "second generation" });

    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toMatchObject({ text: "second generation" });
  });

  it("runtime-validates parsed recorder envelopes", async () => {
    const filePath = await createRecorderPath();
    await writeFile(
      filePath,
      `${JSON.stringify({
        author: "assistant",
        id: "invalid-envelope",
        provider: "slack",
        recordedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        text: 42,
        threadId: "slack:C123",
      })}\n`,
      "utf8",
    );

    await expect(readRecordedInbound(filePath)).rejects.toThrow(/envelope text must be a string/u);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/envelope text must be a string/u);
  });

  it("appends retry-idempotent batches without partial duplicates", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const batch = [
      {
        author: "user" as const,
        id: "evt-batch-1",
        provider: "whatsapp",
        sentAt,
        text: "first",
        threadId: "15551234567",
      },
      {
        author: "user" as const,
        id: "evt-batch-2",
        provider: "whatsapp",
        sentAt,
        text: "second",
        threadId: "15551234567",
      },
    ];

    const results = await Promise.all([
      appendRecordedInboundBatch(filePath, batch),
      appendRecordedInboundBatch(filePath, batch),
    ]);
    expect(results.map((result) => result.length).toSorted()).toEqual([0, 2]);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "evt-batch-1" }),
      expect.objectContaining({ id: "evt-batch-2" }),
    ]);
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      events: [{ id: "evt-batch-1" }, { id: "evt-batch-2" }],
      recordType: "crabline.recorder.batch",
      recorderBatchVersion: 1,
    });
  });

  it("deduplicates a valid recorder tail that is missing its final newline", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = {
      author: "user" as const,
      id: "unterminated-retry",
      provider: "whatsapp",
      sentAt,
      text: "retry",
      threadId: "15551234567",
    };
    await writeFile(
      filePath,
      JSON.stringify({
        ...event,
        recordedAt: sentAt,
      }),
      "utf8",
    );

    await expect(appendRecordedInboundBatch(filePath, [event])).resolves.toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(
      `${JSON.stringify({ ...event, recordedAt: sentAt })}\n`,
    );
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "unterminated-retry" }),
    ]);
  });

  it("rejects a complete invalid recorder tail instead of sealing it", async () => {
    const filePath = await createRecorderPath();
    const invalidTail = JSON.stringify({
      author: "assistant",
      id: "invalid-tail",
      provider: "slack",
      recordedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      text: 42,
      threadId: "slack:C123",
    });
    await writeFile(filePath, invalidTail, "utf8");

    await expect(
      appendRecordedInbound(filePath, {
        author: "assistant",
        id: "after-invalid-tail",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "must not append",
        threadId: "slack:C123",
      }),
    ).rejects.toThrow(/envelope text must be a string/u);
    expect(await readFile(filePath, "utf8")).toBe(invalidTail);
  });

  it("rejects a batch record larger than the incremental reader limit", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "user" as const,
      id: "oversized-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "x".repeat(4 * 1024 * 1024),
      threadId: "15551234567",
    };

    await expect(appendRecordedInboundBatch(filePath, [event])).rejects.toThrow(
      "Recorder record exceeded",
    );
    await expect(
      appendRecordedInboundBatch(filePath, [{ ...event, id: "after-oversized", text: "small" }]),
    ).resolves.toEqual([expect.objectContaining({ id: "after-oversized" })]);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "after-oversized" }),
    ]);
  });

  it("hides partial batch appends before retrying", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: id,
      threadId: "15551234567",
    });
    await appendRecordedInboundBatch(filePath, [event("existing")]);

    const probeHandle = await open(filePath, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      write(
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): Promise<{ buffer: Uint8Array; bytesWritten: number }>;
      writeFile(data: string, encoding: BufferEncoding): Promise<void>;
    };
    await probeHandle.close();
    const originalWrite = fileHandlePrototype.write;
    const originalWriteFile = fileHandlePrototype.writeFile;
    const appendPosition = (await stat(filePath)).size;
    const partialAppendError = Object.assign(new Error("simulated partial append"), {
      code: "ENOSPC",
    });
    let failNextWrite = true;
    let partialWritePosition: number | undefined;
    let releasePartialWrite!: () => void;
    let reportPartialWrite!: () => void;
    const partialWriteReported = new Promise<void>((resolve) => {
      reportPartialWrite = resolve;
    });
    const partialWriteReleased = new Promise<void>((resolve) => {
      releasePartialWrite = resolve;
    });
    if (process.platform === "win32") {
      fileHandlePrototype.write = async function (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        if (failNextWrite) {
          failNextWrite = false;
          partialWritePosition = position;
          await originalWrite.call(this, buffer, offset, Math.ceil(length / 2), position);
          reportPartialWrite();
          await partialWriteReleased;
          throw partialAppendError;
        }
        return originalWrite.call(this, buffer, offset, length, position);
      };
    } else {
      fileHandlePrototype.writeFile = async function (
        this: FileHandle,
        data: string,
        encoding: BufferEncoding,
      ) {
        if (failNextWrite) {
          failNextWrite = false;
          await originalWriteFile.call(this, data.slice(0, Math.ceil(data.length / 2)), encoding);
          reportPartialWrite();
          await partialWriteReleased;
          throw partialAppendError;
        }
        await originalWriteFile.call(this, data, encoding);
      };
    }

    const batch = [event("retry-1"), event("retry-2")];
    const failedAppend = appendRecordedInboundBatch(filePath, batch);
    try {
      await partialWriteReported;
      await expect(readRecordedInbound(filePath)).resolves.toEqual([
        expect.objectContaining({ id: "existing" }),
      ]);
      releasePartialWrite();
      await expect(failedAppend).rejects.toMatchObject({
        cause: partialAppendError,
        committed: true,
        indeterminate: true,
        name: "ProviderRecorderCommittedError",
      });
      expect(partialWritePosition).toBe(process.platform === "win32" ? appendPosition : undefined);
    } finally {
      releasePartialWrite();
      fileHandlePrototype.write = originalWrite;
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    await expect(appendRecordedInboundBatch(filePath, batch)).resolves.toEqual([
      expect.objectContaining({ id: "retry-1" }),
      expect.objectContaining({ id: "retry-2" }),
    ]);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "existing" }),
      expect.objectContaining({ id: "retry-1" }),
      expect.objectContaining({ id: "retry-2" }),
    ]);
  });

  it("retries a batch against a recorder rotated during append", async () => {
    const filePath = await createRecorderPath();
    const rotatedPath = `${filePath}.rotated`;
    const event = {
      author: "user" as const,
      id: "rotated-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "preserve both generations",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [{ ...event, id: "existing", text: "existing" }]);

    const probeHandle = await open(filePath, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as RecorderFileHandlePrototype;
    await probeHandle.close();
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptBatch = true;
    const restoreWrites = interceptRecorderWrites(fileHandlePrototype, async (data, write) => {
      await write();
      if (interceptBatch && data.includes('"recorderBatchVersion"')) {
        interceptBatch = false;
        reportWrite();
        await writeReleased;
      }
    });

    const append = appendRecordedInboundBatch(filePath, [event]);
    try {
      await writeReported;
      await rename(filePath, rotatedPath);
      await writeFile(filePath, "", "utf8");
      releaseWrite();
      await expect(append).resolves.toEqual([expect.objectContaining({ id: "rotated-batch" })]);
    } finally {
      releaseWrite();
      restoreWrites();
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "rotated-batch" }),
    ]);
    await expect(readRecordedInbound(rotatedPath)).resolves.toEqual([
      expect.objectContaining({ id: "existing" }),
      expect.objectContaining({ id: "rotated-batch" }),
    ]);
  });

  it("retries a single append against a recorder rotated during append", async () => {
    const filePath = await createRecorderPath();
    const rotatedPath = `${filePath}.rotated`;
    const event = {
      author: "assistant" as const,
      id: "rotated-single",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "preserve both generations",
      threadId: "slack:C123",
    };

    const probeHandle = await open(filePath, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as RecorderFileHandlePrototype;
    await probeHandle.close();
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptAppend = true;
    const restoreWrites = interceptRecorderWrites(fileHandlePrototype, async (data, write) => {
      await write();
      if (interceptAppend && data.includes('"id":"rotated-single"')) {
        interceptAppend = false;
        reportWrite();
        await writeReleased;
      }
    });

    const append = appendRecordedInbound(filePath, event);
    try {
      await writeReported;
      await rename(filePath, rotatedPath);
      await writeFile(filePath, "", "utf8");
      releaseWrite();
      await expect(append).resolves.toMatchObject({ id: event.id });
    } finally {
      releaseWrite();
      restoreWrites();
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
    await expect(readRecordedInbound(rotatedPath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("retries against a symlinked recorder retargeted during append", async () => {
    const filePath = await createRecorderPath();
    const firstTarget = path.join(path.dirname(filePath), "first-target.jsonl");
    const secondTarget = path.join(path.dirname(filePath), "second-target.jsonl");
    await writeFile(firstTarget, "", "utf8");
    await writeFile(secondTarget, "", "utf8");
    await symlink(firstTarget, filePath, "file");
    const event = {
      author: "user" as const,
      id: "symlink-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "detect retargeting",
      threadId: "15551234567",
    };

    const probeHandle = await open(firstTarget, "a+");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as RecorderFileHandlePrototype;
    await probeHandle.close();
    let releaseWrite!: () => void;
    let reportWrite!: () => void;
    const writeReported = new Promise<void>((resolve) => {
      reportWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let interceptBatch = true;
    const restoreWrites = interceptRecorderWrites(fileHandlePrototype, async (data, write) => {
      await write();
      if (interceptBatch && data.includes('"recorderBatchVersion"')) {
        interceptBatch = false;
        reportWrite();
        await writeReleased;
      }
    });

    const append = appendRecordedInboundBatch(filePath, [event]);
    try {
      await writeReported;
      await rm(filePath);
      await symlink(secondTarget, filePath, "file");
      releaseWrite();
      await expect(append).resolves.toEqual([expect.objectContaining({ id: "symlink-batch" })]);
    } finally {
      releaseWrite();
      restoreWrites();
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "symlink-batch" }),
    ]);
    await expect(readRecordedInbound(firstTarget)).resolves.toEqual([
      expect.objectContaining({ id: "symlink-batch" }),
    ]);
  });

  it("serializes the first batch through a dangling recorder symlink", async () => {
    const filePath = await createRecorderPath();
    const targetPath = path.join(path.dirname(filePath), "dangling-target.jsonl");
    await symlink(targetPath, filePath, "file");
    const event = {
      author: "user" as const,
      id: "dangling-symlink-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "deduplicate the first concurrent append",
      threadId: "15551234567",
    };

    const probeHandle = await open(path.dirname(filePath), "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as RecorderFileHandlePrototype;
    await probeHandle.close();
    let releaseFirstWrite!: () => void;
    let reportFirstWrite!: () => void;
    const firstWriteReported = new Promise<void>((resolve) => {
      reportFirstWrite = resolve;
    });
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let pauseFirstBatch = true;
    const restoreWrites = interceptRecorderWrites(fileHandlePrototype, async (data, write) => {
      if (pauseFirstBatch && data.includes('"recorderBatchVersion"')) {
        pauseFirstBatch = false;
        reportFirstWrite();
        await firstWriteReleased;
      }
      await write();
    });

    const first = appendRecordedInboundBatch(filePath, [event]);
    try {
      await firstWriteReported;
      const second = appendRecordedInboundBatch(filePath, [event]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseFirstWrite();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.length).toSorted()).toEqual([0, 1]);
    } finally {
      releaseFirstWrite();
      restoreWrites();
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("deduplicates concurrent batches through real and symlink aliases", async () => {
    const filePath = await createRecorderPath();
    const aliasPath = `${filePath}.alias`;
    await writeFile(filePath, "", "utf8");
    await symlink(filePath, aliasPath, "file");
    const event = {
      author: "user" as const,
      id: "alias-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "one logical recorder",
      threadId: "15551234567",
    };

    const results = await Promise.all([
      appendRecordedInboundBatch(filePath, [event]),
      appendRecordedInboundBatch(aliasPath, [event]),
    ]);

    expect(results.flat()).toHaveLength(1);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("deduplicates concurrent batches through hardlink aliases", async () => {
    const filePath = await createRecorderPath();
    const aliasPath = `${filePath}.alias`;
    await writeFile(filePath, "", "utf8");
    await link(filePath, aliasPath);
    const event = {
      author: "user" as const,
      id: "hardlink-alias-batch",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "one recorder inode",
      threadId: "15551234567",
    };

    const results = await Promise.all([
      appendRecordedInboundBatch(filePath, [event]),
      appendRecordedInboundBatch(aliasPath, [event]),
    ]);

    expect(results.flat()).toHaveLength(1);
    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("repairs an interrupted recorder tail before publishing a batch", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: id,
      threadId: "15551234567",
    });
    await appendRecordedInboundBatch(filePath, [event("existing")]);
    await appendFile(filePath, '{"id":"interrupted"', "utf8");

    await appendRecordedInboundBatch(filePath, [event("after-recovery")]);

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: "existing" }),
      expect.objectContaining({ id: "after-recovery" }),
    ]);
  });

  it("bounds batch identity memory to a recent retry window", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: id,
      threadId: "15551234567",
    });
    const history = Array.from({ length: 4097 }, (_, index) => event(`history-${index}`));

    await expect(appendRecordedInboundBatch(filePath, history)).resolves.toHaveLength(
      history.length,
    );
    await expect(appendRecordedInboundBatch(filePath, [history[0]!])).resolves.toHaveLength(1);
    await expect(appendRecordedInboundBatch(filePath, [history.at(-1)!])).resolves.toEqual([]);
  });

  it("indexes batch identities without rescanning completed recorder history", async () => {
    const filePath = await createRecorderPath();
    const sentAt = new Date().toISOString();
    const event = (id: string) => ({
      author: "user" as const,
      id,
      provider: "whatsapp",
      sentAt,
      text: "x".repeat(128),
      threadId: "15551234567",
    });
    await appendRecordedInboundBatch(
      filePath,
      Array.from({ length: 64 }, (_, index) => event(`history-${index}`)),
    );
    await appendRecordedInboundBatch(filePath, [event("tail-1")]);

    const handle = await open(filePath, "r+");
    try {
      await handle.write("!", 0, "utf8");
    } finally {
      await handle.close();
    }

    await expect(appendRecordedInboundBatch(filePath, [event("tail-2")])).resolves.toEqual([
      expect.objectContaining({ id: "tail-2" }),
    ]);
    expect(await readFile(filePath, "utf8")).toContain('"id":"tail-2"');
  });

  it("resets batch identities when the recorder is replaced", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "user" as const,
      id: "reused-after-rotation",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "accepted in each recorder generation",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [event]);
    await rename(filePath, `${filePath}.old`);
    await writeFile(filePath, "", "utf8");

    await expect(appendRecordedInboundBatch(filePath, [event])).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("rebuilds batch identities when a replacement preserves the consumed prefix", async () => {
    const filePath = await createRecorderPath();
    const replacementPath = `${filePath}.replacement`;
    const event = {
      author: "user" as const,
      id: "same-prefix-replacement",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "deduplicate after inode replacement",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [event]);
    const contents = await readFile(filePath, "utf8");
    await writeFile(replacementPath, contents, "utf8");
    await rename(replacementPath, filePath);

    await expect(appendRecordedInboundBatch(filePath, [event])).resolves.toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(contents);
  });

  it("retries duplicate suppression when the recorder rotates during indexing", async () => {
    const filePath = await createRecorderPath();
    const rotatedPath = `${filePath}.old`;
    const event = {
      author: "user" as const,
      id: "duplicate-during-rotation",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "preserve the acknowledged event",
      threadId: "15551234567",
    };
    await appendRecordedInboundBatch(filePath, [event]);

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      stat(...args: unknown[]): Promise<unknown>;
    };
    await probeHandle.close();
    const originalStat = fileHandlePrototype.stat;
    let statCalls = 0;
    let releaseIndexStat!: () => void;
    let reportIndexStat!: () => void;
    const indexStatReported = new Promise<void>((resolve) => {
      reportIndexStat = resolve;
    });
    const indexStatReleased = new Promise<void>((resolve) => {
      releaseIndexStat = resolve;
    });
    fileHandlePrototype.stat = async function (...args: unknown[]) {
      const stats = await Reflect.apply(originalStat, this, args);
      if (++statCalls === 3) {
        reportIndexStat();
        await indexStatReleased;
      }
      return stats;
    };

    const append = appendRecordedInboundBatch(filePath, [event]);
    try {
      await indexStatReported;
      await rename(filePath, rotatedPath);
      await writeFile(filePath, "", "utf8");
      releaseIndexStat();
      await expect(append).resolves.toEqual([expect.objectContaining({ id: event.id })]);
    } finally {
      releaseIndexStat();
      fileHandlePrototype.stat = originalStat;
    }

    await expect(readRecordedInbound(filePath)).resolves.toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it("keeps valid events when the final record is truncated", async () => {
    const filePath = await createRecorderPath();
    const recorded = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "evt-valid",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "keep me",
      threadId: "slack:C123",
    });
    await appendFile(filePath, '{"id":"evt-truncated"', "utf8");

    await expect(readRecordedInbound(filePath)).resolves.toEqual([recorded]);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: (event) => event.id === "evt-valid",
        timeoutMs: 30,
      }),
    ).resolves.toEqual(recorded);

    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.id === "evt-valid",
      pollMs: 10,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: recorded,
    });
  });

  it("reads a valid final record without a trailing newline", async () => {
    const filePath = await createRecorderPath();
    const event = {
      author: "assistant",
      id: "evt-final",
      provider: "slack",
      recordedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      text: "complete",
      threadId: "slack:C123",
    } as const;
    await writeFile(filePath, JSON.stringify(event), "utf8");

    await expect(readRecordedInbound(filePath)).resolves.toEqual([event]);
  });

  it("rejects a malformed final record once it is newline terminated", async () => {
    const filePath = await createRecorderPath();
    await appendFile(filePath, '{"id":"malformed"} trailing\n', "utf8");

    await expect(readRecordedInbound(filePath)).rejects.toThrow(SyntaxError);
    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(SyntaxError);

    const iterator = watchRecordedInbound({
      filePath,
      matches: () => true,
      pollMs: 10,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(SyntaxError);
  });

  it("does not hide a completed malformed record behind a blank tail", async () => {
    const filePath = await createRecorderPath();
    await appendFile(filePath, '{"id":"malformed"} trailing\n   ', "utf8");

    await expect(readRecordedInbound(filePath)).rejects.toThrow(SyntaxError);
  });

  it("does not advance an incremental cursor past a malformed completed partial record", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const partial = '{"author":"assistant"';
    await writeFile(filePath, partial, "utf8");

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => false,
        pollMs: 5,
        timeoutMs: 15,
      }),
    ).resolves.toBeNull();
    const beforeFailure = cloneRecordedInboundCursor(cursor);

    const recovered = {
      author: "assistant",
      id: "recovered-after-malformed",
      provider: "slack",
      recordedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      text: "recover me",
      threadId: "slack:C123",
    } as const;
    await appendFile(filePath, ` trailing\n${JSON.stringify(recovered)}\n`, "utf8");

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(SyntaxError);
    expect(cursor).toEqual(beforeFailure);

    await writeFile(filePath, `${JSON.stringify(recovered)}\n`, "utf8");
    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).resolves.toEqual(recovered);
  });

  it("waits for a matching inbound event", async () => {
    const filePath = await createRecorderPath();
    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.threadId === "slack:C123",
      timeoutMs: 500,
    });

    const append = runAfterDelay(() =>
      appendRecordedInbound(filePath, {
        author: "assistant",
        id: "evt-2",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "match me",
        threadId: "slack:C123",
      }),
    );

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-2",
      text: "match me",
    });
    await append;
  });

  it("retains unread events when a cursor returns an earlier match", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const first = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "first",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "slack:C123",
    });
    const second = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "second",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "slack:C123",
    });

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).resolves.toEqual(first);
    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: () => true,
        timeoutMs: 30,
      }),
    ).resolves.toEqual(second);
  });

  it("deduplicates recent appended retries without rescanning consumed records", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const duplicate = {
      author: "assistant" as const,
      id: "duplicate",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "duplicate",
      threadId: "slack:C123",
    };
    const first = await appendRecordedInbound(filePath, duplicate);
    await appendRecordedInbound(filePath, duplicate);
    const next = await appendRecordedInbound(filePath, { ...duplicate, id: "next", text: "next" });

    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(first);
    await expect(
      waitForRecordedInbound({ cursor, filePath, matches: () => true, timeoutMs: 30 }),
    ).resolves.toEqual(next);
  });

  it("retains incremental wait progress across large recorder histories", async () => {
    const filePath = await createRecorderPath();
    const cursor = createRecordedInboundCursor();
    const now = new Date().toISOString();
    const eventCount = 4100;
    await writeFile(
      filePath,
      Array.from(
        { length: eventCount },
        (_, index) =>
          `${JSON.stringify({
            author: "assistant",
            id: `bounded-${index}`,
            provider: "slack",
            recordedAt: now,
            sentAt: now,
            text: "bounded",
            threadId: "slack:C123",
          })}\n`,
      ).join(""),
      "utf8",
    );

    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: (event) => event.id === `bounded-${eventCount - 1}`,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ id: `bounded-${eventCount - 1}` });
    await expect(
      waitForRecordedInbound({
        cursor,
        filePath,
        matches: (event) => event.id === `bounded-${eventCount - 1}`,
        timeoutMs: 30,
      }),
    ).resolves.toBeNull();
  });

  it("does not collapse distinct records whose fields contain delimiters", async () => {
    const filePath = await createRecorderPath();
    await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "c",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "a:b",
    });
    const expected = await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "b:c",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "a",
    });

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: (event) => event.text === "second",
        timeoutMs: 30,
      }),
    ).resolves.toEqual(expected);
  });

  it("times out when no matching event arrives", async () => {
    const filePath = await createRecorderPath();

    await appendRecordedInbound(filePath, {
      author: "assistant",
      id: "evt-old",
      provider: "slack",
      sentAt: new Date(Date.now() - 10_000).toISOString(),
      text: "too old",
      threadId: "slack:C123",
    });

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: (event) => event.threadId === "slack:C123",
        since: new Date().toISOString(),
        timeoutMs: 30,
      }),
    ).resolves.toBeNull();
  });

  it("does not sleep past the polling timeout", async () => {
    const filePath = await createRecorderPath();
    const startedAt = Date.now();

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => false,
        pollMs: 1000,
        timeoutMs: 40,
      }),
    ).resolves.toBeNull();

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("reads only appended bytes while waiting and preserves a partial record", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    const history = Array.from(
      { length: 1000 },
      (_, index) =>
        `${JSON.stringify({
          author: "user",
          id: `history-${index}`,
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "history",
          threadId: "slack:C999",
        })}\n`,
    ).join("");
    const tail = JSON.stringify({
      author: "assistant",
      id: "evt-tail",
      provider: "slack",
      recordedAt: now,
      sentAt: now,
      text: "completed tail",
      threadId: "slack:C123",
    });
    const splitAt = Math.floor(tail.length / 2);
    await appendFile(filePath, history + tail.slice(0, splitAt), "utf8");

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let bytesRead = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };

    try {
      const waitPromise = waitForRecordedInbound({
        filePath,
        matches: (event) => event.id === "evt-tail",
        pollMs: 10,
        timeoutMs: 500,
      });

      const append = runAfterDelay(() => appendFile(filePath, `${tail.slice(splitAt)}\n`, "utf8"));

      await expect(waitPromise).resolves.toMatchObject({
        id: "evt-tail",
        text: "completed tail",
      });
      await append;
      const fileSize = Buffer.byteLength(`${history}${tail}\n`);
      expect(bytesRead).toBeGreaterThanOrEqual(fileSize);
      expect(bytesRead).toBeLessThan(fileSize * 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });

  it("bounds unread recorder batches before returning an early match", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    const contents = Array.from(
      { length: 20_000 },
      (_, index) =>
        `${JSON.stringify({
          author: "assistant",
          id: `event-${index}`,
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "x".repeat(64),
          threadId: "slack:C123",
        })}\n`,
    ).join("");
    await writeFile(filePath, contents, "utf8");

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let bytesRead = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };

    try {
      await expect(
        waitForRecordedInbound({
          filePath,
          matches: (event) => event.id === "event-0",
          timeoutMs: 30,
        }),
      ).resolves.toMatchObject({ id: "event-0" });
      expect(bytesRead).toBeLessThan(Buffer.byteLength(contents) / 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });

  it("bounds unterminated recorder records", async () => {
    const filePath = await createRecorderPath();
    await writeFile(filePath, "x".repeat(4 * 1024 * 1024 + 1), "utf8");

    await expect(
      waitForRecordedInbound({
        filePath,
        matches: () => false,
        pollMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/exceeded 4194304 bytes without a newline/u);
  });

  it("resets incremental reads when the recorder is atomically replaced", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    await writeFile(
      filePath,
      `${JSON.stringify({
        author: "user",
        id: "before-replacement",
        provider: "slack",
        recordedAt: now,
        sentAt: now,
        text: "old recorder",
        threadId: "slack:C999",
      })}\n`,
      "utf8",
    );

    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.id === "after-replacement",
      pollMs: 10,
      timeoutMs: 500,
    });

    const replace = runAfterDelay(async () => {
      const replacementPath = `${filePath}.replacement`;
      await writeFile(
        replacementPath,
        `${JSON.stringify({
          author: "assistant",
          id: "after-replacement",
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "new recorder".repeat(20),
          threadId: "slack:C123",
        })}\n`,
        "utf8",
      );
      await rename(replacementPath, filePath);
    });

    await expect(waitPromise).resolves.toMatchObject({
      id: "after-replacement",
      threadId: "slack:C123",
    });
    await replace;
  });

  it("preserves the offset when atomic replacement retains recorder history", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    const history = Array.from(
      { length: 4097 },
      (_, index) =>
        `${JSON.stringify({
          author: "assistant",
          id: `history-${index}`,
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "history",
          threadId: "slack:C123",
        })}\n`,
    ).join("");
    await writeFile(filePath, history, "utf8");

    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.id === "history-4096" || event.id === "after-history-replacement",
      pollMs: 10,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: "history-4096" },
    });

    const replacementPath = `${filePath}.replacement`;
    await writeFile(
      replacementPath,
      `${history}${JSON.stringify({
        author: "assistant",
        id: "after-history-replacement",
        provider: "slack",
        recordedAt: now,
        sentAt: now,
        text: "new tail",
        threadId: "slack:C123",
      })}\n`,
      "utf8",
    );
    await rename(replacementPath, filePath);

    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: "after-history-replacement" },
    });
    await iterator.return?.();
  });

  it("resets partial state when a recorder is truncated and regrown past the offset", async () => {
    const filePath = await createRecorderPath();
    const now = new Date().toISOString();
    await writeFile(
      filePath,
      `${JSON.stringify({
        author: "user",
        id: "before-truncate",
        provider: "slack",
        recordedAt: now,
        sentAt: now,
        text: "old recorder",
        threadId: "slack:C999",
      })}\n{"id":"stale-partial"`,
      "utf8",
    );

    const waitPromise = waitForRecordedInbound({
      filePath,
      matches: (event) => event.id === "after-truncate",
      pollMs: 10,
      timeoutMs: 500,
    });

    const truncate = runAfterDelay(() =>
      writeFile(
        filePath,
        `${JSON.stringify({
          author: "assistant",
          id: "after-truncate",
          provider: "slack",
          recordedAt: now,
          sentAt: now,
          text: "regrown recorder".repeat(20),
          threadId: "slack:C123",
        })}\n`,
        "utf8",
      ),
    );

    await expect(waitPromise).resolves.toMatchObject({
      id: "after-truncate",
      threadId: "slack:C123",
    });
    await truncate;
  });

  it("streams new inbound events", async () => {
    const filePath = await createRecorderPath();
    const iterator = watchRecordedInbound({
      filePath,
      matches: (event) => event.provider === "slack",
      pollMs: 10,
    })[Symbol.asyncIterator]();

    const append = runAfterDelay(() =>
      appendRecordedInbound(filePath, {
        author: "user",
        id: "evt-3",
        provider: "slack",
        sentAt: new Date().toISOString(),
        text: "tail me",
        threadId: "slack:C999",
      }),
    );

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value?.id).toBe("evt-3");
    await append;
  });

  it("stops before yielding buffered events after abort", async () => {
    const filePath = await createRecorderPath();
    await appendRecordedInbound(filePath, {
      author: "user",
      id: "evt-buffered-1",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "slack:C999",
    });
    await appendRecordedInbound(filePath, {
      author: "user",
      id: "evt-buffered-2",
      provider: "slack",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "slack:C999",
    });
    const controller = new AbortController();
    const iterator = watchRecordedInbound({
      filePath,
      matches: () => true,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "evt-buffered-1" },
    });
    controller.abort();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("reads only appended records while watching a large recorder", async () => {
    const filePath = await createRecorderPath();
    const history = Array.from(
      { length: 1000 },
      (_, index) =>
        `${JSON.stringify({
          author: "user",
          id: `history-${index}`,
          provider: "slack",
          recordedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          text: "history",
          threadId: "slack:C999",
        })}\n`,
    ).join("");
    await appendFile(filePath, history, "utf8");

    const probeHandle = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
    await probeHandle.close();
    const originalRead = fileHandlePrototype.read;
    let bytesRead = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };

    try {
      const iterator = watchRecordedInbound({
        filePath,
        matches: (event) => event.id === "evt-tail",
        pollMs: 10,
      })[Symbol.asyncIterator]();

      const append = runAfterDelay(() =>
        appendRecordedInbound(filePath, {
          author: "user",
          id: "evt-tail",
          provider: "slack",
          sentAt: new Date().toISOString(),
          text: "tail me",
          threadId: "slack:C999",
        }),
      );

      const next = await iterator.next();
      expect(next.value?.id).toBe("evt-tail");
      await append;
      expect(bytesRead).toBeGreaterThanOrEqual(Buffer.byteLength(history));
      expect(bytesRead).toBeLessThan(Buffer.byteLength(history) * 2);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  });
});
