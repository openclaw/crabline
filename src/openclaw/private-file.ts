import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_CREATE_OWNER_ONLY_FILE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$filePath = $env:CRABLINE_PRIVATE_FILE_PATH
if ([string]::IsNullOrWhiteSpace($filePath)) {
  throw "CRABLINE_PRIVATE_FILE_PATH is required."
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CrablinePrivateFileIdentity
{
    private const int FileInternalInformationClass = 6;
    private const int FileFsVolumeInformationClass = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInternalInformation
    {
        public long IndexNumber;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationFile(
        SafeFileHandle file,
        out IoStatusBlock ioStatus,
        out FileInternalInformation fileInformation,
        uint length,
        int fileInformationClass
    );

    [DllImport("ntdll.dll")]
    private static extern int NtQueryVolumeInformationFile(
        SafeFileHandle file,
        out IoStatusBlock ioStatus,
        [Out] byte[] volumeInformation,
        uint length,
        int volumeInformationClass
    );

    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);

    private static void ThrowIfFailed(int status)
    {
        if (status != 0) {
            throw new Win32Exception(
                unchecked((int)RtlNtStatusToDosError(status))
            );
        }
    }

    public static string Read(SafeFileHandle file)
    {
        IoStatusBlock ioStatus;
        FileInternalInformation fileInfo;
        int status = NtQueryInformationFile(
            file,
            out ioStatus,
            out fileInfo,
            (uint)Marshal.SizeOf(typeof(FileInternalInformation)),
            FileInternalInformationClass
        );
        ThrowIfFailed(status);

        byte[] volumeInfo = new byte[1024];
        status = NtQueryVolumeInformationFile(
            file,
            out ioStatus,
            volumeInfo,
            (uint)volumeInfo.Length,
            FileFsVolumeInformationClass
        );
        ThrowIfFailed(status);

        uint device = BitConverter.ToUInt32(volumeInfo, 8);
        ulong inode = unchecked((ulong)fileInfo.IndexNumber);
        return device.ToString(
            System.Globalization.CultureInfo.InvariantCulture
        ) + ":" + inode.ToString(
            System.Globalization.CultureInfo.InvariantCulture
        );
    }
}
"@

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}

$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)

$rights = (
  [System.Security.AccessControl.FileSystemRights]::Read -bor
  [System.Security.AccessControl.FileSystemRights]::Write -bor
  [System.Security.AccessControl.FileSystemRights]::ReadPermissions
)
$stream = [System.IO.FileStream]::new(
  $filePath,
  [System.IO.FileMode]::CreateNew,
  $rights,
  [System.IO.FileShare]::ReadWrite,
  4096,
  [System.IO.FileOptions]::None,
  $acl
)
try {
  $actual = $stream.GetAccessControl()
  $ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
  $rules = @($actual.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  if (-not $actual.AreAccessRulesProtected) {
    throw "Private file DACL still inherits permissions."
  }
  if ($ownerSid.Value -ne $sid.Value) {
    throw "Private file owner SID does not match the current user."
  }
  if ($rules.Count -ne 1) {
    throw "Private file DACL must contain exactly one access rule."
  }
  $actualRule = $rules[0]
  if (
    $actualRule.IsInherited -or
    $actualRule.IdentityReference.Value -ne $sid.Value -or
    $actualRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    (($actualRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl)
  ) {
    throw "Private file DACL is not owner-only full control."
  }
  [Console]::Out.Write(
    [CrablinePrivateFileIdentity]::Read($stream.SafeFileHandle)
  )
} finally {
  $stream.Dispose()
}
`;

const WINDOWS_OWNER_ONLY_DIRECTORY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}

$acl = Get-Acl -LiteralPath $directoryPath
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$existingRules = @($acl.GetAccessRules(
  $true,
  $false,
  [System.Security.Principal.SecurityIdentifier]
))
foreach ($existingRule in $existingRules) {
  [void]$acl.RemoveAccessRuleSpecific($existingRule)
}
$inheritance = (
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $directoryPath -AclObject $acl

$actual = Get-Acl -LiteralPath $directoryPath
$ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if (-not $actual.AreAccessRulesProtected) {
  throw "Private directory DACL still inherits permissions."
}
if ($ownerSid.Value -ne $sid.Value) {
  throw "Private directory owner SID does not match the current user."
}
if ($rules.Count -ne 1) {
  throw "Private directory DACL must contain exactly one access rule."
}
$actualRule = $rules[0]
$requiredInheritance = (
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
if (
  $actualRule.IsInherited -or
  $actualRule.IdentityReference.Value -ne $sid.Value -or
  $actualRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  (($actualRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) -or
  (($actualRule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance)
) {
  throw "Private directory DACL is not owner-only inheritable full control."
}
`;

const WINDOWS_CREATE_OWNER_ONLY_DIRECTORY_ANCESTRY_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CrablinePrivateDirectory
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool InheritHandle;
    }

    [DllImport(
        "kernel32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectory(
        string path,
        ref SecurityAttributes securityAttributes
    );

    public static void CreateNew(string path, byte[] securityDescriptor)
    {
        GCHandle descriptorHandle = GCHandle.Alloc(
            securityDescriptor,
            GCHandleType.Pinned
        );
        try {
            SecurityAttributes attributes = new SecurityAttributes {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                SecurityDescriptor = descriptorHandle.AddrOfPinnedObject(),
                InheritHandle = false
            };
            if (!CreateDirectory(path, ref attributes)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        } finally {
            descriptorHandle.Free();
        }
    }
}
"@

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}

$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = (
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
$descriptor = $acl.GetSecurityDescriptorBinaryForm()

$target = [System.IO.Path]::GetFullPath($directoryPath)
$missing = [System.Collections.Generic.List[string]]::new()
$current = $target
while (-not [System.IO.Directory]::Exists($current)) {
  if ([System.IO.File]::Exists($current)) {
    throw "Private directory ancestry contains a non-directory entry."
  }
  $missing.Add($current)
  $parent = [System.IO.Directory]::GetParent($current)
  if ($null -eq $parent) {
    throw "Private directory ancestry has no existing parent."
  }
  $current = $parent.FullName
}

$paths = $missing.ToArray()
[Array]::Reverse($paths)
$created = [System.Collections.Generic.List[string]]::new()
try {
  foreach ($candidate in $paths) {
    [CrablinePrivateDirectory]::CreateNew($candidate, $descriptor)
    $created.Add($candidate)

    $actual = [System.IO.DirectoryInfo]::new($candidate).GetAccessControl()
    $ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
    $rules = @($actual.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))
    if (-not $actual.AreAccessRulesProtected) {
      throw "Private directory DACL still inherits permissions."
    }
    if ($ownerSid.Value -ne $sid.Value) {
      throw "Private directory owner SID does not match the current user."
    }
    if ($rules.Count -ne 1) {
      throw "Private directory DACL must contain exactly one access rule."
    }
    $actualRule = $rules[0]
    if (
      $actualRule.IsInherited -or
      $actualRule.IdentityReference.Value -ne $sid.Value -or
      $actualRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      (($actualRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) -or
      (($actualRule.InheritanceFlags -band $inheritance) -ne $inheritance)
    ) {
      throw "Private directory DACL is not owner-only inheritable full control."
    }

    $entries = [System.IO.Directory]::EnumerateFileSystemEntries($candidate).GetEnumerator()
    try {
      if ($entries.MoveNext()) {
        throw "New private directory was populated during creation."
      }
    } finally {
      $entries.Dispose()
    }
  }
} catch {
  for ($index = $created.Count - 1; $index -ge 0; $index--) {
    try {
      [System.IO.Directory]::Delete($created[$index], $false)
    } catch {
    }
  }
  throw
}

if ($created.Count -gt 0) {
  [Console]::Out.Write($created[0])
}
`;

const WINDOWS_VERIFY_OWNER_ONLY_DIRECTORY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}

$actual = Get-Acl -LiteralPath $directoryPath
$ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
$requiredInheritance = (
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
if (-not $actual.AreAccessRulesProtected) {
  throw "Private directory DACL still inherits permissions."
}
if ($ownerSid.Value -ne $sid.Value) {
  throw "Private directory owner SID does not match the current user."
}
if ($rules.Count -ne 1) {
  throw "Private directory DACL must contain exactly one access rule."
}
$actualRule = $rules[0]
if (
  $actualRule.IsInherited -or
  $actualRule.IdentityReference.Value -ne $sid.Value -or
  $actualRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  (($actualRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) -or
  (($actualRule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance)
) {
  throw "Private directory DACL is not owner-only inheritable full control."
}
`;

export type WindowsAclRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => Promise<string>;

const runWindowsAclCommand: WindowsAclRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, { ...options, encoding: "utf8" });
  return result.stdout;
};

export function resolveWindowsPowerShellPath(systemRoot: string | null | undefined): string {
  const normalizedRoot = systemRoot?.trim() ? path.win32.normalize(systemRoot.trim()) : undefined;
  if (!normalizedRoot || !/^[A-Za-z]:\\/.test(normalizedRoot)) {
    throw new Error("SystemRoot must be an absolute local Windows path.");
  }
  return path.win32.join(normalizedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function createOwnerOnlyWindowsFile(
  filePath: string,
  run: WindowsAclRunner = runWindowsAclCommand,
  systemRoot: string | null | undefined = process.env.SystemRoot,
): Promise<FileIdentity> {
  try {
    const powershellPath = resolveWindowsPowerShellPath(systemRoot);
    const output = await run(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_CREATE_OWNER_ONLY_FILE_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          CRABLINE_PRIVATE_FILE_PATH: path.resolve(filePath),
        },
        windowsHide: true,
      },
    );
    const match = /^(\d+):(\d+)$/u.exec(output.trim());
    if (!match) {
      throw new Error("Windows did not return a stable private file identity.");
    }
    const identity = {
      device: BigInt(match[1]!),
      inode: BigInt(match[2]!),
    };
    if (identity.inode <= 0n) {
      throw new Error("Windows did not return a stable private file identity.");
    }
    return identity;
  } catch (error) {
    throw new Error(
      "Could not atomically create and verify an owner-only Windows private file; Windows PowerShell ACL support is required.",
      { cause: error },
    );
  }
}

export async function applyOwnerOnlyWindowsDirectoryAcl(
  directoryPath: string,
  run: WindowsAclRunner = runWindowsAclCommand,
  systemRoot: string | null | undefined = process.env.SystemRoot,
): Promise<void> {
  try {
    const powershellPath = resolveWindowsPowerShellPath(systemRoot);
    await run(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_OWNER_ONLY_DIRECTORY_ACL_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          CRABLINE_PRIVATE_DIRECTORY_PATH: path.resolve(directoryPath),
        },
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error(
      "Could not apply and verify an owner-only Windows directory ACL; powershell.exe with Set-Acl is required.",
      { cause: error },
    );
  }
}

export async function createOwnerOnlyWindowsDirectoryAncestry(
  directoryPath: string,
  run: WindowsAclRunner = runWindowsAclCommand,
  systemRoot: string | null | undefined = process.env.SystemRoot,
): Promise<string | undefined> {
  try {
    const powershellPath = resolveWindowsPowerShellPath(systemRoot);
    const output = await run(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_CREATE_OWNER_ONLY_DIRECTORY_ANCESTRY_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          CRABLINE_PRIVATE_DIRECTORY_PATH: path.resolve(directoryPath),
        },
        windowsHide: true,
      },
    );
    const firstCreatedDirectory = output.trim();
    return firstCreatedDirectory.length > 0 ? firstCreatedDirectory : undefined;
  } catch (error) {
    throw new Error(
      "Could not atomically create and verify owner-only Windows private directory ancestry; Windows PowerShell security descriptor support is required.",
      { cause: error },
    );
  }
}

export async function verifyOwnerOnlyWindowsDirectoryAcl(
  directoryPath: string,
  run: WindowsAclRunner = runWindowsAclCommand,
  systemRoot: string | null | undefined = process.env.SystemRoot,
): Promise<void> {
  try {
    const powershellPath = resolveWindowsPowerShellPath(systemRoot);
    await run(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_VERIFY_OWNER_ONLY_DIRECTORY_ACL_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          CRABLINE_PRIVATE_DIRECTORY_PATH: path.resolve(directoryPath),
        },
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error("Private mutation parent must have an owner-only protected Windows ACL.", {
      cause: error,
    });
  }
}

type FileIdentity = {
  device: bigint;
  inode: bigint;
};

function assertSameFileIdentity(actual: FileIdentity, expected: FileIdentity): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("Private file path identity changed during publication.");
  }
}

async function readHandleIdentity(handle: FileHandle): Promise<FileIdentity> {
  const stats = await handle.stat({ bigint: true });
  if (stats.ino <= 0n) {
    throw new Error("The filesystem did not provide a stable private file identity.");
  }
  return {
    device: stats.dev,
    inode: stats.ino,
  };
}

async function assertPathIdentity(filePath: string, expected: FileIdentity): Promise<void> {
  try {
    const stats = await fs.lstat(filePath, { bigint: true });
    if (
      stats.isFile() &&
      stats.nlink === 1n &&
      stats.dev === expected.device &&
      stats.ino === expected.inode
    ) {
      return;
    }
  } catch (error) {
    throw new Error("Private file path identity changed during publication.", { cause: error });
  }
  throw new Error("Private file path identity changed during publication.");
}

type DirectoryIdentity = {
  device: bigint;
  inode: bigint;
  userId: bigint;
};

async function readDirectoryHandleIdentity(handle: FileHandle): Promise<DirectoryIdentity> {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isDirectory() || stats.ino <= 0n) {
    throw new Error("The filesystem did not provide a stable private directory identity.");
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    userId: stats.uid,
  };
}

async function assertDirectoryPathIdentity(
  directoryPath: string,
  expected: DirectoryIdentity,
): Promise<void> {
  try {
    const stats = await fs.lstat(directoryPath, { bigint: true });
    if (stats.isDirectory() && stats.dev === expected.device && stats.ino === expected.inode) {
      return;
    }
  } catch (error) {
    throw new Error("Private directory path identity changed during publication.", {
      cause: error,
    });
  }
  throw new Error("Private directory path identity changed during publication.");
}

export type SecuredPrivateDirectory = {
  assertIdentityAt(directoryPath?: string): Promise<void>;
  directoryPath: string;
};

export async function captureDirectoryIdentity(
  directoryPath: string,
): Promise<SecuredPrivateDirectory> {
  const handle = await fs.open(directoryPath, "r");
  try {
    const identity = await readDirectoryHandleIdentity(handle);
    const secured: SecuredPrivateDirectory = {
      async assertIdentityAt(currentPath = directoryPath) {
        await assertDirectoryPathIdentity(currentPath, identity);
      },
      directoryPath,
    };
    await secured.assertIdentityAt();
    return secured;
  } finally {
    await handle.close();
  }
}

export async function syncParentDirectory(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") {
    return;
  }
  const handle = await fs.open(path.dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentAtAccessibleBoundary(
  filePath: string,
  syncParent: (filePath: string, platform?: NodeJS.Platform) => Promise<void>,
  platform?: NodeJS.Platform,
): Promise<boolean> {
  try {
    await syncParent(filePath, platform);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return false;
    }
    throw error;
  }
}

async function syncPathAncestry(
  filePath: string,
  syncParent: (filePath: string, platform?: NodeJS.Platform) => Promise<void>,
  platform?: NodeJS.Platform,
  firstCreatedDirectory?: string,
): Promise<void> {
  const resolvedFilePath = path.resolve(filePath);
  let currentPath = resolvedFilePath;
  const syncThroughPath =
    firstCreatedDirectory === undefined ? undefined : path.resolve(firstCreatedDirectory);
  for (;;) {
    const mandatory = syncThroughPath !== undefined || currentPath === resolvedFilePath;
    if (mandatory) {
      await syncParent(currentPath, platform);
    } else if (!(await syncParentAtAccessibleBoundary(currentPath, syncParent, platform))) {
      return;
    }
    if (currentPath === syncThroughPath) {
      return;
    }
    const parentPath = path.dirname(currentPath);
    if (path.dirname(parentPath) === parentPath) {
      return;
    }
    currentPath = parentPath;
  }
}

export async function removeSecuredPrivateDirectory(
  secured: SecuredPrivateDirectory,
  currentPath = secured.directoryPath,
  quarantineBaseName = path.basename(currentPath),
  options: {
    beforeRecursiveRemove?: (quarantinePath: string) => Promise<void>;
    beforeRename?: (currentPath: string) => Promise<void>;
    createWindowsDirectories?: (directoryPath: string) => Promise<string | undefined>;
    platform?: NodeJS.Platform;
    removeDirectory?: (quarantinePath: string) => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
  } = {},
): Promise<void> {
  if (path.basename(quarantineBaseName) !== quarantineBaseName || quarantineBaseName.length === 0) {
    throw new Error("Private directory quarantine basename is malformed.");
  }
  const quarantinePath = path.join(
    path.dirname(currentPath),
    `.${quarantineBaseName}.${process.pid}.${randomUUID()}.remove`,
  );
  const parent = await captureOwnerOnlyMutationParent(path.dirname(currentPath));
  const claim = await acquirePrivateMutationClaim(parent, quarantineBaseName, {
    ...(options.createWindowsDirectories
      ? { createWindowsDirectories: options.createWindowsDirectories }
      : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  let removalFailed = false;
  let primaryError: unknown;
  try {
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await secured.assertIdentityAt(currentPath);
    await options.beforeRename?.(currentPath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await secured.assertIdentityAt(currentPath);
    await fs.rename(currentPath, quarantinePath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await secured.assertIdentityAt(quarantinePath);
    const syncParent = options.syncParent ?? syncParentDirectory;
    await syncParent(quarantinePath, options.platform);
    await options.beforeRecursiveRemove?.(quarantinePath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await secured.assertIdentityAt(quarantinePath);
    await (
      options.removeDirectory ??
      ((candidatePath: string) => fs.rm(candidatePath, { force: true, recursive: true }))
    )(quarantinePath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await syncParent(quarantinePath, options.platform);
  } catch (error) {
    removalFailed = true;
    primaryError = error;
  }

  try {
    await claim.release();
  } catch (releaseError) {
    if (removalFailed) {
      const aggregateError = new AggregateError(
        [primaryError, releaseError],
        "Private directory removal failed and its mutation claim could not be released.",
      );
      aggregateError.cause = primaryError;
      throw aggregateError;
    }
    throw releaseError;
  }
  if (removalFailed) {
    throw primaryError;
  }
}

export async function securePrivateDirectory(
  directoryPath: string,
  options: {
    createWindowsDirectories?: (directoryPath: string) => Promise<string | undefined>;
    currentUserId?: number;
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
    syncDirectory?: () => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
  } = {},
): Promise<SecuredPrivateDirectory> {
  const platform = options.platform ?? process.platform;
  let created = false;
  let createdAtomically = false;
  if (platform === "win32") {
    try {
      await fs.lstat(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const createWindowsDirectories =
        options.createWindowsDirectories ??
        (process.platform === "win32" || options.secureWindowsDirectory === undefined
          ? createOwnerOnlyWindowsDirectoryAncestry
          : async (candidatePath: string) => {
              await fs.mkdir(candidatePath);
              return candidatePath;
            });
      const firstCreatedDirectory = await createWindowsDirectories(directoryPath);
      if (firstCreatedDirectory === undefined) {
        throw new Error("Windows private directory creation did not create the requested path.", {
          cause: error,
        });
      }
      created = true;
      createdAtomically =
        options.createWindowsDirectories !== undefined || process.platform === "win32";
    }
  } else {
    try {
      await fs.mkdir(directoryPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  const handle = await fs.open(directoryPath, "r");
  let handleOpen = true;
  const closeHandle = async () => {
    if (!handleOpen) {
      return;
    }
    handleOpen = false;
    await handle.close();
  };
  let identity: DirectoryIdentity;
  try {
    identity = await readDirectoryHandleIdentity(handle);
  } catch (error) {
    try {
      await closeHandle();
    } catch (closeError) {
      const aggregateError = new AggregateError(
        [error, closeError],
        "Private directory identity verification failed and its handle could not be closed.",
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  }
  const secured: SecuredPrivateDirectory = {
    async assertIdentityAt(currentPath = directoryPath) {
      await assertDirectoryPathIdentity(currentPath, identity);
    },
    directoryPath,
  };
  try {
    await secured.assertIdentityAt();
    if (platform === "win32") {
      if (!createdAtomically) {
        await (options.secureWindowsDirectory ?? applyOwnerOnlyWindowsDirectoryAcl)(directoryPath);
      }
      if (process.platform !== "win32") {
        await handle.chmod(0o700);
      }
    } else {
      const currentUserId = options.currentUserId ?? process.geteuid?.();
      if (
        currentUserId === undefined ||
        !Number.isSafeInteger(currentUserId) ||
        currentUserId < 0 ||
        identity.userId !== BigInt(currentUserId)
      ) {
        throw new Error("Private directory must be owned by the current POSIX user.");
      }
      await handle.chmod(0o700);
      await (options.syncDirectory ?? (() => handle.sync()))();
    }
    await secured.assertIdentityAt();
    const syncParent = options.syncParent ?? syncParentDirectory;
    if (created) {
      await syncParent(directoryPath, options.platform);
    } else {
      await syncParentAtAccessibleBoundary(directoryPath, syncParent, options.platform);
    }
  } catch (error) {
    let primaryError = error;
    try {
      await closeHandle();
    } catch (closeError) {
      const aggregateError = new AggregateError(
        [error, closeError],
        "Private directory securing failed and its verification handle could not be closed.",
      );
      aggregateError.cause = error;
      primaryError = aggregateError;
    }
    if (created) {
      try {
        await removeSecuredPrivateDirectory(secured);
      } catch (cleanupError) {
        const aggregateError = new AggregateError(
          [primaryError, cleanupError],
          `Private directory securing failed and rollback cleanup also failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        aggregateError.cause = primaryError;
        throw aggregateError;
      }
    }
    throw primaryError;
  } finally {
    await closeHandle();
  }

  return secured;
}

type PrivateMutationClaim = {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
};

function privateMutationClaimPath(parentDirectory: string, targetBaseName: string): string {
  const digest = createHash("sha256").update(targetBaseName).digest("hex").slice(0, 32);
  return path.join(parentDirectory, `.crabline-private-${digest}.claim`);
}

async function acquirePrivateMutationClaim(
  parent: SecuredPrivateDirectory,
  targetBaseName: string,
  options: {
    createWindowsDirectories?: (directoryPath: string) => Promise<string | undefined>;
    platform?: NodeJS.Platform;
  },
): Promise<PrivateMutationClaim> {
  const platform = options.platform ?? process.platform;
  const claimPath = privateMutationClaimPath(parent.directoryPath, targetBaseName);
  if (platform === "win32" && process.platform === "win32") {
    const firstCreatedDirectory = await (
      options.createWindowsDirectories ?? createOwnerOnlyWindowsDirectoryAncestry
    )(claimPath);
    if (firstCreatedDirectory === undefined) {
      throw new Error("Private path mutation is already claimed.");
    }
  } else {
    try {
      await fs.mkdir(claimPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Private path mutation is already claimed.", { cause: error });
      }
      throw error;
    }
  }

  const securedClaim = await captureDirectoryIdentity(claimPath);
  const assertOwned = async () => {
    await parent.assertIdentityAt();
    await securedClaim.assertIdentityAt();
    if ((await fs.readdir(claimPath)).length !== 0) {
      throw new Error("Private path mutation claim was modified.");
    }
  };
  try {
    await assertOwned();
    await syncParentDirectory(claimPath, options.platform);
  } catch (error) {
    try {
      await fs.rmdir(claimPath);
    } catch (cleanupError) {
      const aggregateError = new AggregateError(
        [error, cleanupError],
        "Private path mutation claim creation failed and cleanup also failed.",
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  }

  let released = false;
  return {
    assertOwned,
    async release() {
      if (released) {
        return;
      }
      await assertOwned();
      await fs.rmdir(claimPath);
      released = true;
      await parent.assertIdentityAt();
      await syncParentDirectory(claimPath, options.platform);
    },
  };
}

async function captureOwnerOnlyMutationParent(
  directoryPath: string,
): Promise<SecuredPrivateDirectory> {
  const secured = await captureDirectoryIdentity(directoryPath);
  if (process.platform === "win32") {
    await verifyOwnerOnlyWindowsDirectoryAcl(directoryPath);
  } else {
    const stats = await fs.lstat(directoryPath, { bigint: true });
    const currentUserId = process.geteuid?.();
    if (
      !stats.isDirectory() ||
      currentUserId === undefined ||
      stats.uid !== BigInt(currentUserId) ||
      (stats.mode & 0o077n) !== 0n
    ) {
      throw new Error("Private mutation parent must be owned by the current user and owner-only.");
    }
  }
  await secured.assertIdentityAt();
  return secured;
}

export async function publishPrivateFileAtomically(
  filePath: string,
  contents: string,
  options: {
    afterRename?: (filePath: string) => Promise<void>;
    beforeCommitRename?: (temporaryPath: string) => Promise<void>;
    beforeRename?: (temporaryPath: string) => Promise<void>;
    createWindowsFile?: (temporaryPath: string) => Promise<FileIdentity>;
    createWindowsDirectories?: (directoryPath: string) => Promise<string | undefined>;
    platform?: NodeJS.Platform;
    removeTemporaryFile?: (temporaryPath: string) => Promise<void>;
    secureWindowsFile?: (temporaryPath: string) => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
  } = {},
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const parentDirectory = path.resolve(path.dirname(filePath));
  const platform = options.platform ?? process.platform;
  const firstCreatedDirectory =
    platform === "win32"
      ? await (async () => {
          try {
            await fs.lstat(parentDirectory);
            return undefined;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            return await (
              options.createWindowsDirectories ?? createOwnerOnlyWindowsDirectoryAncestry
            )(parentDirectory);
          }
        })()
      : await fs.mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const parent = await captureOwnerOnlyMutationParent(parentDirectory);
  const claim = await acquirePrivateMutationClaim(parent, path.basename(filePath), {
    ...(options.createWindowsDirectories
      ? { createWindowsDirectories: options.createWindowsDirectories }
      : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  let handle: FileHandle | undefined;
  let publicationFailed = false;
  let primaryError: unknown;
  try {
    let identity: FileIdentity;
    if (platform === "win32" && options.secureWindowsFile === undefined) {
      const createdIdentity = await (options.createWindowsFile ?? createOwnerOnlyWindowsFile)(
        temporaryPath,
      );
      handle = await fs.open(temporaryPath, "r+");
      identity = await readHandleIdentity(handle);
      assertSameFileIdentity(identity, createdIdentity);
    } else {
      handle = await fs.open(temporaryPath, "wx+", 0o600);
      identity = await readHandleIdentity(handle);
      if (platform === "win32") {
        await options.secureWindowsFile!(temporaryPath);
      } else {
        await handle.chmod(0o600);
      }
    }

    await assertPathIdentity(temporaryPath, identity);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await assertPathIdentity(temporaryPath, identity);
    await options.beforeRename?.(temporaryPath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await assertPathIdentity(temporaryPath, identity);
    await options.beforeCommitRename?.(temporaryPath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await assertPathIdentity(temporaryPath, identity);
    // Node has no portable renameat API. The owner-only parent and target-specific claim fence
    // every supported same-user writer while these path identities are revalidated.
    await fs.rename(temporaryPath, filePath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await syncPathAncestry(
      filePath,
      options.syncParent ?? syncParentDirectory,
      options.platform,
      firstCreatedDirectory,
    );
    await options.afterRename?.(filePath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await assertPathIdentity(filePath, identity);
  } catch (error) {
    publicationFailed = true;
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await handle?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await claim.release();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await (
      options.removeTemporaryFile ??
      ((candidatePath: string) => fs.rm(candidatePath, { force: true }))
    )(temporaryPath);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (publicationFailed) {
    if (cleanupErrors.length > 0) {
      const primaryMessage =
        primaryError instanceof Error ? primaryError.message : String(primaryError);
      const aggregateError = new AggregateError(
        [primaryError, ...cleanupErrors],
        `${primaryMessage} Private temporary file cleanup also failed.`,
      );
      aggregateError.cause = primaryError;
      const primaryCode =
        typeof primaryError === "object" && primaryError !== null
          ? (primaryError as NodeJS.ErrnoException).code
          : undefined;
      if (primaryCode) {
        Object.assign(aggregateError, { code: primaryCode });
      }
      throw aggregateError;
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Private temporary file publication cleanup failed.");
  }
}
