import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

const WINDOWS_VERIFY_SAFE_DIRECTORY_MUTATION_BOUNDARY_SCRIPT = String.raw`
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

$trustedSids = @(
  $sid.Value,
  "S-1-5-18",
  "S-1-5-32-544"
)
$mutationRights = (
  [System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [System.Security.AccessControl.FileSystemRights]::AppendData -bor
  [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)

$actual = Get-Acl -LiteralPath $directoryPath
$ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($trustedSids -notcontains $ownerSid.Value) {
  throw "Directory owner is not trusted for private mutation ancestry."
}
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
foreach ($rule in $rules) {
  if (
    $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $trustedSids -notcontains $rule.IdentityReference.Value -and
    ($rule.FileSystemRights -band $mutationRights) -ne 0
  ) {
    throw "Directory grants mutation rights to an untrusted principal."
  }
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

async function verifySafeWindowsDirectoryMutationBoundary(
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
        WINDOWS_VERIFY_SAFE_DIRECTORY_MUTATION_BOUNDARY_SCRIPT,
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
    throw new Error("Private mutation ancestry has an unsafe Windows ACL.", {
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

async function darwinDirectoryHasExtendedAcl(directoryPath: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  let output: string;
  try {
    const result = await execFileAsync("/bin/ls", ["-lde", directoryPath], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 64 * 1024,
    });
    output = result.stdout;
  } catch (error) {
    throw new Error("Could not verify the private directory macOS ACL.", { cause: error });
  }
  const mode = output.trimStart().split(/\s+/u, 1)[0] ?? "";
  return mode.includes("+");
}

async function assertDarwinDirectoryHasNoExtendedAcl(directoryPath: string): Promise<void> {
  if (await darwinDirectoryHasExtendedAcl(directoryPath)) {
    throw new Error("Private directory must not have a macOS extended ACL.");
  }
}

async function removeDarwinExtendedAcl(directoryPath: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    await execFileAsync("/bin/chmod", ["-N", directoryPath], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw new Error("Could not remove the legacy private directory macOS ACL.", {
      cause: error,
    });
  }
}

async function nearestExistingDirectory(directoryPath: string): Promise<string> {
  let currentPath = path.resolve(directoryPath);
  for (;;) {
    try {
      const stats = await fs.lstat(currentPath);
      if (!stats.isDirectory()) {
        throw new Error("Private directory ancestry contains a non-directory entry.");
      }
      return currentPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error("Private directory ancestry has no existing parent.");
    }
    currentPath = parentPath;
  }
}

async function assertDarwinCreatedAncestryHasNoExtendedAcl(
  firstCreatedDirectory: string | undefined,
  finalDirectory: string,
): Promise<void> {
  if (process.platform !== "darwin" || firstCreatedDirectory === undefined) {
    return;
  }
  const firstCreatedPath = path.resolve(firstCreatedDirectory);
  let currentPath = path.resolve(finalDirectory);
  const createdPaths: string[] = [];
  for (;;) {
    createdPaths.push(currentPath);
    if (currentPath === firstCreatedPath) {
      break;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error("Private directory ancestry creation boundary is invalid.");
    }
    currentPath = parentPath;
  }
  for (const createdPath of createdPaths.reverse()) {
    await assertDarwinDirectoryHasNoExtendedAcl(createdPath);
  }
}

async function captureSafePrivateMutationBoundary(
  directoryPath: string,
  platform: NodeJS.Platform,
  stickyTargetOwnedByCurrentUser: boolean,
): Promise<SecuredPrivateDirectory> {
  if (platform === "win32" && process.platform === "win32") {
    await verifySafeWindowsDirectoryMutationBoundary(directoryPath);
    return await captureDirectoryIdentity(directoryPath);
  }

  const currentUserId = process.geteuid?.();
  if (currentUserId === undefined || !Number.isSafeInteger(currentUserId) || currentUserId < 0) {
    throw new Error("Could not resolve the current POSIX user for private mutation.");
  }
  const stats = await fs.lstat(directoryPath, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error("Private mutation boundary is not a directory.");
  }
  const writableByAnotherPrincipal = (stats.mode & 0o022n) !== 0n;
  const trustedOwner = stats.uid === BigInt(currentUserId) || stats.uid === 0n;
  const protectedByStickyOwnership =
    trustedOwner && (stats.mode & 0o1000n) !== 0n && stickyTargetOwnedByCurrentUser;
  if (writableByAnotherPrincipal && !protectedByStickyOwnership) {
    throw new Error("Private mutation boundary is writable by another POSIX principal.");
  }
  await assertDarwinDirectoryHasNoExtendedAcl(directoryPath);
  return await captureDirectoryIdentity(directoryPath);
}

async function captureSafePrivateDirectoryMutationParent(
  currentPath: string,
  platform: NodeJS.Platform,
): Promise<SecuredPrivateDirectory> {
  if (platform === "win32" && process.platform === "win32") {
    return await captureSafePrivateMutationBoundary(path.dirname(currentPath), platform, true);
  }
  const currentUserId = process.geteuid?.();
  const targetStats = await fs.lstat(currentPath, { bigint: true });
  return await captureSafePrivateMutationBoundary(
    path.dirname(currentPath),
    platform,
    currentUserId !== undefined &&
      targetStats.isDirectory() &&
      targetStats.uid === BigInt(currentUserId),
  );
}

export async function removeSecuredPrivateDirectory(
  secured: SecuredPrivateDirectory,
  currentPath = secured.directoryPath,
  quarantineBaseName = path.basename(currentPath),
  options: {
    beforeRecursiveRemove?: (quarantinePath: string) => Promise<void>;
    beforeRename?: (currentPath: string) => Promise<void>;
    claimRuntime?: PrivateMutationClaimRuntime;
    createWindowsFile?: (filePath: string) => Promise<FileIdentity>;
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
  const platform = options.platform ?? process.platform;
  const parent = await captureSafePrivateDirectoryMutationParent(currentPath, platform);
  const claimParent: SecuredPrivateDirectory = {
    assertIdentityAt: (candidatePath = currentPath) => secured.assertIdentityAt(candidatePath),
    directoryPath: currentPath,
  };
  const claim = await acquirePrivateMutationClaimChain(claimParent, {
    ...(options.claimRuntime ? { runtime: options.claimRuntime } : {}),
    ...(options.createWindowsFile ? { createWindowsFile: options.createWindowsFile } : {}),
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
    await secured.assertIdentityAt(quarantinePath);
    await claim.relocateParent(quarantinePath);
    await claim.assertOwned();
    const syncParent = options.syncParent ?? syncParentDirectory;
    await syncParent(quarantinePath, options.platform);
    await options.beforeRecursiveRemove?.(quarantinePath);
    await parent.assertIdentityAt();
    await claim.assertOwned();
    await secured.assertIdentityAt(quarantinePath);
    await claim.prepareContainerRemoval();
    await (
      options.removeDirectory ??
      ((candidatePath: string) => fs.rm(candidatePath, { force: true, recursive: true }))
    )(quarantinePath);
    await claim.completeContainerRemoval();
    await parent.assertIdentityAt();
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
    markMutationRoot?: boolean;
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
    let existed = false;
    try {
      await fs.lstat(directoryPath);
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (!existed) {
      await assertDarwinDirectoryHasNoExtendedAcl(path.dirname(directoryPath));
    }
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
      if (!created) {
        await removeDarwinExtendedAcl(directoryPath);
      }
      const currentStats = await handle.stat({ bigint: true });
      const mutationRootMode =
        options.markMutationRoot === false ? currentStats.mode & 0o1000n : 0o1000n;
      await handle.chmod(Number(0o700n | mutationRootMode));
      await assertDarwinDirectoryHasNoExtendedAcl(directoryPath);
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
  completeContainerRemoval(): Promise<void>;
  prepareContainerRemoval(): Promise<void>;
  relocateParent(directoryPath: string): Promise<void>;
  release(): Promise<void>;
};

export type PrivateMutationClaimRuntime = {
  getProcessIdentity(pid: number): string | null;
  isProcessAlive(pid: number): boolean;
  ownerId: string;
  pid: number;
  processIdentity?: string;
  processStartedAtMs: number;
};

type PrivateMutationClaimOwner = {
  ownerId: string;
  pid: number;
  processIdentity?: string;
  processStartedAtMs: number;
};

const PRIVATE_MUTATION_CLAIM_ROOT_FILE = ".crabline-private-mutation.claim";
const PRIVATE_MUTATION_CLAIM_OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRIVATE_MUTATION_CLAIM_METADATA_MAX_BYTES = 4096;
const PRIVATE_MUTATION_RESERVED_BASENAME_PATTERN = /^\.crabline-private-mutation(?:\.|$)/iu;

function assertNotReservedPrivateMutationPath(targetPath: string): void {
  if (PRIVATE_MUTATION_RESERVED_BASENAME_PATTERN.test(path.basename(targetPath))) {
    throw new Error("Private path uses Crabline's reserved mutation claim namespace.");
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processIdentityFromLinuxStat(value: string, bootId: string): string | null {
  const normalizedBootId = bootId.trim();
  if (!/^[0-9a-f-]{16,64}$/iu.test(normalizedBootId)) {
    return null;
  }
  const commandEnd = value.lastIndexOf(") ");
  if (commandEnd < 0) {
    return null;
  }
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  return startTicks && /^\d+$/u.test(startTicks) ? `linux:${normalizedBootId}:${startTicks}` : null;
}

function processIdentityFromDarwin(processDetails: string, bootTime: string): string | null {
  const bootMatch = /\bsec = (\d+), usec = (\d+)\b/u.exec(bootTime);
  const launchMatch =
    /^Launch Time:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3,6}) ([+-])(\d{2})(\d{2})$/mu.exec(
      processDetails,
    );
  if (!bootMatch || !launchMatch) {
    return null;
  }
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] =
    launchMatch as RegExpExecArray &
      [string, string, string, string, string, string, string, string, string, string, string];
  const offsetMs =
    (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000 * (sign === "+" ? 1 : -1);
  const fractionMicros = Number(fraction.padEnd(6, "0"));
  const utcMilliseconds =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Math.floor(fractionMicros / 1_000),
    ) - offsetMs;
  if (!Number.isSafeInteger(utcMilliseconds) || utcMilliseconds <= 0) {
    return null;
  }
  const startedAtMicros = BigInt(utcMilliseconds) * 1_000n + BigInt(fractionMicros % 1_000);
  return `darwin:${bootMatch[1]}.${bootMatch[2]}:us:${startedAtMicros}`;
}

function getProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      return processIdentityFromLinuxStat(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
      );
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const options = {
      encoding: "utf8" as const,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 512 * 1024,
      timeout: 3_000,
    };
    const bootTime = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], options);
    const processDetails = spawnSync("/usr/bin/vmmap", ["-summary", String(pid)], options);
    return bootTime.status === 0 && processDetails.status === 0
      ? processIdentityFromDarwin(processDetails.stdout, bootTime.stdout)
      : null;
  }
  if (process.platform !== "win32") {
    return null;
  }
  let powershellPath: string;
  try {
    powershellPath = resolveWindowsPowerShellPath(process.env.SystemRoot);
  } catch {
    return null;
  }
  const result = spawnSync(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`,
    ],
    { encoding: "utf8", timeout: 1_000, windowsHide: true },
  );
  const ticks = result.status === 0 ? result.stdout.trim() : "";
  return /^\d+$/u.test(ticks) ? `windows:${ticks}` : null;
}

let cachedCurrentProcessIdentity: string | null | undefined;

function defaultPrivateMutationClaimRuntime(): PrivateMutationClaimRuntime {
  if (cachedCurrentProcessIdentity === undefined) {
    cachedCurrentProcessIdentity = getProcessIdentity(process.pid);
  }
  return {
    getProcessIdentity,
    isProcessAlive,
    ownerId: randomUUID(),
    pid: process.pid,
    ...(cachedCurrentProcessIdentity ? { processIdentity: cachedCurrentProcessIdentity } : {}),
    processStartedAtMs: Math.floor(performance.timeOrigin),
  };
}

function parsePrivateMutationClaimOwner(contents: string): PrivateMutationClaimOwner {
  let owner: Partial<PrivateMutationClaimOwner>;
  try {
    owner = JSON.parse(contents) as Partial<PrivateMutationClaimOwner>;
  } catch (error) {
    throw new Error("Private path mutation claim owner metadata is malformed.", { cause: error });
  }
  if (
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 ||
    typeof owner.ownerId !== "string" ||
    !PRIVATE_MUTATION_CLAIM_OWNER_ID_PATTERN.test(owner.ownerId) ||
    !Number.isSafeInteger(owner.processStartedAtMs) ||
    Number(owner.processStartedAtMs) <= 0 ||
    (owner.processIdentity !== undefined &&
      (typeof owner.processIdentity !== "string" ||
        owner.processIdentity.length === 0 ||
        owner.processIdentity.length > 256))
  ) {
    throw new Error("Private path mutation claim owner metadata is malformed.");
  }
  return owner as PrivateMutationClaimOwner;
}

async function assertClaimPathIdentity(
  claimPath: string,
  expected: FileIdentity,
  expectedLinkCount?: bigint,
): Promise<void> {
  try {
    const stats = await fs.lstat(claimPath, { bigint: true });
    if (
      stats.isFile() &&
      (expectedLinkCount === undefined ? stats.nlink >= 1n : stats.nlink === expectedLinkCount) &&
      stats.dev === expected.device &&
      stats.ino === expected.inode
    ) {
      return;
    }
  } catch (error) {
    throw new Error("Private path mutation claim identity changed.", { cause: error });
  }
  throw new Error("Private path mutation claim identity changed.");
}

type PrivateMutationClaimRecord = {
  contents: string;
  identity: FileIdentity;
  owner: PrivateMutationClaimOwner;
};

async function readPrivateMutationClaim(
  claimPath: string,
): Promise<PrivateMutationClaimRecord | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      claimPath,
      process.platform === "win32"
        ? "r"
        : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      stats.ino <= 0n ||
      stats.size <= 0n ||
      stats.size > BigInt(PRIVATE_MUTATION_CLAIM_METADATA_MAX_BYTES)
    ) {
      throw new Error("Private path mutation claim metadata size is invalid.");
    }
    const identity = { device: stats.dev, inode: stats.ino };
    const buffer = Buffer.alloc(Number(stats.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error("Private path mutation claim metadata was truncated while reading.");
      }
      offset += bytesRead;
    }
    const finalStats = await handle.stat({ bigint: true });
    if (
      !finalStats.isFile() ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino ||
      finalStats.size !== stats.size
    ) {
      throw new Error("Private path mutation claim metadata changed while reading.");
    }
    const contents = buffer.toString("utf8");
    const owner = parsePrivateMutationClaimOwner(contents);
    await assertClaimPathIdentity(claimPath, identity);
    return { contents, identity, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function nextPrivateMutationClaimPath(parentDirectory: string, ownerContents: string): string {
  const digest = createHash("sha256").update(ownerContents).digest("hex");
  return path.join(parentDirectory, `.crabline-private-mutation.${digest}.claim`);
}

async function removeStalePrivateMutationClaimAliases(
  parentDirectory: string,
  staleClaims: Array<PrivateMutationClaimRecord & { claimPath: string }>,
  currentClaimPath: string,
): Promise<void> {
  const staleIdentities = new Set(
    staleClaims.map(({ identity }) => `${identity.device}:${identity.inode}`),
  );
  for (const entry of await fs.readdir(parentDirectory)) {
    if (!PRIVATE_MUTATION_RESERVED_BASENAME_PATTERN.test(entry)) {
      continue;
    }
    const entryPath = path.join(parentDirectory, entry);
    if (entryPath === currentClaimPath) {
      continue;
    }
    let stats;
    try {
      stats = await fs.lstat(entryPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (stats.isFile() && staleIdentities.has(`${stats.dev}:${stats.ino}`)) {
      await fs.unlink(entryPath);
    }
  }
}

class UnsupportedPrivateMutationHardLinkError extends Error {
  constructor(cause: unknown) {
    super("Private mutation claims require a non-hard-link fallback.", { cause });
  }
}

function isUnsupportedHardLinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS";
}

async function acquireHardLinkPrivateMutationClaim(
  parent: SecuredPrivateDirectory,
  options: {
    createWindowsFile?: (filePath: string) => Promise<FileIdentity>;
    platform?: NodeJS.Platform;
    runtime?: PrivateMutationClaimRuntime;
  },
): Promise<PrivateMutationClaim> {
  const platform = options.platform ?? process.platform;
  const runtime = options.runtime ?? defaultPrivateMutationClaimRuntime();
  if (
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid <= 0 ||
    !PRIVATE_MUTATION_CLAIM_OWNER_ID_PATTERN.test(runtime.ownerId) ||
    !Number.isSafeInteger(runtime.processStartedAtMs) ||
    runtime.processStartedAtMs <= 0 ||
    (runtime.processIdentity !== undefined &&
      (runtime.processIdentity.length === 0 || runtime.processIdentity.length > 256))
  ) {
    throw new Error("Private path mutation claim runtime is invalid.");
  }
  if (
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid <= 0 ||
    !PRIVATE_MUTATION_CLAIM_OWNER_ID_PATTERN.test(runtime.ownerId) ||
    !Number.isSafeInteger(runtime.processStartedAtMs) ||
    runtime.processStartedAtMs <= 0 ||
    (runtime.processIdentity !== undefined &&
      (runtime.processIdentity.length === 0 || runtime.processIdentity.length > 256))
  ) {
    throw new Error("Private path mutation claim runtime is invalid.");
  }
  const ownerContents = `${JSON.stringify({
    ownerId: runtime.ownerId,
    pid: runtime.pid,
    ...(runtime.processIdentity ? { processIdentity: runtime.processIdentity } : {}),
    processStartedAtMs: runtime.processStartedAtMs,
  } satisfies PrivateMutationClaimOwner)}\n`;
  const rootClaimPath = path.join(parent.directoryPath, PRIVATE_MUTATION_CLAIM_ROOT_FILE);
  const candidatePath = `${rootClaimPath}.${runtime.pid}.${randomUUID()}.candidate`;
  let handle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  const linkedClaimPaths = new Set<string>();
  try {
    if (platform === "win32" && process.platform === "win32") {
      const createdIdentity = await (options.createWindowsFile ?? createOwnerOnlyWindowsFile)(
        candidatePath,
      );
      handle = await fs.open(candidatePath, "r+");
      identity = await readHandleIdentity(handle);
      assertSameFileIdentity(identity, createdIdentity);
    } else {
      handle = await fs.open(candidatePath, "wx+", 0o600);
      identity = await readHandleIdentity(handle);
      await handle.chmod(0o600);
    }
    await handle.writeFile(ownerContents, "utf8");
    await handle.sync();
    await assertClaimPathIdentity(candidatePath, identity, 1n);

    let claimPath = rootClaimPath;
    const visitedClaimPaths = new Set<string>();
    const staleClaims: Array<PrivateMutationClaimRecord & { claimPath: string }> = [];
    for (;;) {
      if (visitedClaimPaths.has(claimPath)) {
        throw new Error("Private path mutation claim chain contains a cycle.");
      }
      visitedClaimPaths.add(claimPath);
      try {
        await fs.link(candidatePath, claimPath);
        linkedClaimPaths.add(claimPath);
      } catch (error) {
        if (isUnsupportedHardLinkError(error)) {
          throw new UnsupportedPrivateMutationHardLinkError(error);
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        await parent.assertIdentityAt();
        const observed = await readPrivateMutationClaim(claimPath);
        if (observed === null) {
          claimPath = rootClaimPath;
          visitedClaimPaths.clear();
          staleClaims.length = 0;
          continue;
        }
        if (runtime.isProcessAlive(observed.owner.pid)) {
          if (
            observed.owner.pid === runtime.pid &&
            observed.owner.processStartedAtMs === runtime.processStartedAtMs
          ) {
            throw new Error("Private path mutation is already claimed.", { cause: error });
          } else if (observed.owner.pid !== runtime.pid) {
            if (observed.owner.processIdentity === undefined) {
              throw new Error("Private path mutation is already claimed.", { cause: error });
            }
            const actualIdentity = runtime.getProcessIdentity(observed.owner.pid);
            if (actualIdentity === null || actualIdentity === observed.owner.processIdentity) {
              throw new Error("Private path mutation is already claimed.", { cause: error });
            }
          }
        }
        const revalidated = await readPrivateMutationClaim(claimPath);
        if (
          revalidated === null ||
          revalidated.identity.device !== observed.identity.device ||
          revalidated.identity.inode !== observed.identity.inode ||
          revalidated.contents !== observed.contents
        ) {
          claimPath = rootClaimPath;
          visitedClaimPaths.clear();
          staleClaims.length = 0;
          continue;
        }
        const duplicateIdentity = staleClaims.find(
          ({ identity: staleIdentity }) =>
            staleIdentity.device === revalidated.identity.device &&
            staleIdentity.inode === revalidated.identity.inode,
        );
        if (duplicateIdentity !== undefined) {
          await parent.assertIdentityAt();
          await assertClaimPathIdentity(claimPath, revalidated.identity);
          await fs.unlink(claimPath);
          await syncParentDirectory(claimPath, options.platform);
          claimPath = rootClaimPath;
          visitedClaimPaths.clear();
          staleClaims.length = 0;
          continue;
        }
        staleClaims.push({ claimPath, ...revalidated });
        claimPath = nextPrivateMutationClaimPath(parent.directoryPath, revalidated.contents);
        continue;
      }

      await assertClaimPathIdentity(candidatePath, identity, 2n);
      await assertClaimPathIdentity(claimPath, identity, 2n);
      if (staleClaims.length > 0) {
        const staleRoot = await readPrivateMutationClaim(rootClaimPath);
        const expectedRoot = staleClaims[0]!;
        if (
          staleRoot === null ||
          staleRoot.identity.device !== expectedRoot.identity.device ||
          staleRoot.identity.inode !== expectedRoot.identity.inode ||
          staleRoot.contents !== expectedRoot.contents
        ) {
          throw new Error("Private path mutation claim root changed during recovery.");
        }
        await fs.rename(candidatePath, rootClaimPath);
        linkedClaimPaths.add(rootClaimPath);
        await assertClaimPathIdentity(rootClaimPath, identity, 2n);
        await assertClaimPathIdentity(claimPath, identity, 2n);
        await fs.unlink(claimPath);
        linkedClaimPaths.delete(claimPath);
        claimPath = rootClaimPath;
        await assertClaimPathIdentity(claimPath, identity, 1n);
        await removeStalePrivateMutationClaimAliases(parent.directoryPath, staleClaims, claimPath);
      } else {
        await fs.unlink(candidatePath);
      }
      await assertClaimPathIdentity(claimPath, identity, 1n);
      await parent.assertIdentityAt();
      await syncParentDirectory(claimPath, options.platform);
      linkedClaimPaths.clear();

      let released = false;
      const claimHandle = handle;
      let claimHandleOpen = true;
      let ownedClaimPath = claimPath;
      let ownedParentPath = parent.directoryPath;
      const claimIdentity = identity;
      const closeClaimHandle = async () => {
        if (!claimHandleOpen) {
          return;
        }
        claimHandleOpen = false;
        await claimHandle.close();
      };
      const assertOwned = async () => {
        await parent.assertIdentityAt(ownedParentPath);
        await assertClaimPathIdentity(ownedClaimPath, claimIdentity, 1n);
        const observed = await readPrivateMutationClaim(ownedClaimPath);
        if (
          observed === null ||
          observed.identity.device !== claimIdentity.device ||
          observed.identity.inode !== claimIdentity.inode ||
          observed.contents !== ownerContents
        ) {
          throw new Error("Private path mutation claim owner metadata changed.");
        }
      };
      return {
        assertOwned,
        async completeContainerRemoval() {
          if (released) {
            return;
          }
          let completionError: unknown;
          try {
            await fs.lstat(ownedParentPath);
            completionError = new Error(
              "Private directory path still exists after recursive removal.",
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              completionError = error;
            }
          }
          try {
            await closeClaimHandle();
          } catch (closeError) {
            if (completionError !== undefined) {
              const aggregateError = new AggregateError(
                [completionError, closeError],
                "Private directory removal verification failed and its claim handle could not be closed.",
              );
              aggregateError.cause = completionError;
              throw aggregateError;
            }
            throw closeError;
          }
          released = true;
          if (completionError !== undefined) {
            throw completionError;
          }
        },
        async prepareContainerRemoval() {
          if (released) {
            throw new Error("Private path mutation claim has already been released.");
          }
          await assertOwned();
          await closeClaimHandle();
          await assertOwned();
        },
        async relocateParent(directoryPath: string) {
          if (released) {
            throw new Error("Private path mutation claim has already been released.");
          }
          const relocatedClaimPath = path.join(directoryPath, path.basename(ownedClaimPath));
          await parent.assertIdentityAt(directoryPath);
          const observed = await readPrivateMutationClaim(relocatedClaimPath);
          if (
            observed === null ||
            observed.identity.device !== claimIdentity.device ||
            observed.identity.inode !== claimIdentity.inode ||
            observed.contents !== ownerContents
          ) {
            throw new Error("Private path mutation claim identity changed during relocation.");
          }
          ownedParentPath = directoryPath;
          ownedClaimPath = relocatedClaimPath;
        },
        async release() {
          if (released) {
            return;
          }
          const releasePath = `${ownedClaimPath}.${randomUUID()}.release`;
          let releaseError: unknown;
          try {
            await assertOwned();
            await fs.rename(ownedClaimPath, releasePath);
            await assertClaimPathIdentity(releasePath, claimIdentity, 1n);
            if ((await fs.readFile(releasePath, "utf8")) !== ownerContents) {
              throw new Error("Private path mutation claim owner metadata changed.");
            }
            await fs.unlink(releasePath);
            released = true;
            await parent.assertIdentityAt(ownedParentPath);
            await syncParentDirectory(ownedClaimPath, options.platform);
          } catch (error) {
            releaseError = error;
          }
          try {
            await closeClaimHandle();
          } catch (closeError) {
            if (releaseError !== undefined) {
              const aggregateError = new AggregateError(
                [releaseError, closeError],
                "Private path mutation claim release failed and its handle could not be closed.",
              );
              aggregateError.cause = releaseError;
              throw aggregateError;
            }
            throw closeError;
          }
          if (releaseError !== undefined) {
            throw releaseError;
          }
        },
      };
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (identity !== undefined) {
      for (const linkedClaimPath of linkedClaimPaths) {
        try {
          await assertClaimPathIdentity(linkedClaimPath, identity);
          await fs.unlink(linkedClaimPath);
          await syncParentDirectory(linkedClaimPath, options.platform);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    try {
      await handle?.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    try {
      await fs.rm(candidatePath, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      const aggregateError = new AggregateError(
        [error, ...cleanupErrors],
        "Private path mutation claim acquisition failed and rollback cleanup also failed.",
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  }
}

const PRIVATE_MUTATION_DIRECTORY_OWNER_FILE = "owner.json";

async function readPrivateMutationDirectoryClaim(claimPath: string): Promise<{
  identity: FileIdentity;
  metadata: PrivateMutationClaimRecord;
} | null> {
  let stats;
  try {
    stats = await fs.lstat(claimPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.ino <= 0n) {
    throw new Error("Private mutation directory claim is malformed.");
  }
  const metadata = await readPrivateMutationClaim(
    path.join(claimPath, PRIVATE_MUTATION_DIRECTORY_OWNER_FILE),
  );
  if (metadata === null) {
    throw new Error("Private mutation directory claim is missing owner metadata.");
  }
  const finalStats = await fs.lstat(claimPath, { bigint: true });
  if (!finalStats.isDirectory() || finalStats.dev !== stats.dev || finalStats.ino !== stats.ino) {
    throw new Error("Private mutation directory claim identity changed.");
  }
  return {
    identity: { device: stats.dev, inode: stats.ino },
    metadata,
  };
}

function privateMutationClaimOwnerIsActive(
  owner: PrivateMutationClaimOwner,
  runtime: PrivateMutationClaimRuntime,
): boolean {
  if (!runtime.isProcessAlive(owner.pid)) {
    return false;
  }
  if (owner.pid === runtime.pid && owner.processStartedAtMs === runtime.processStartedAtMs) {
    return true;
  }
  if (owner.pid === runtime.pid) {
    return false;
  }
  if (owner.processIdentity === undefined) {
    return true;
  }
  const actualIdentity = runtime.getProcessIdentity(owner.pid);
  return actualIdentity === null || actualIdentity === owner.processIdentity;
}

async function createPrivateMutationClaimDirectory(
  directoryPath: string,
  ownerContents: string,
  options: {
    createWindowsFile?: (filePath: string) => Promise<FileIdentity>;
    platform: NodeJS.Platform;
  },
): Promise<void> {
  if (options.platform === "win32" && process.platform === "win32") {
    const firstCreated = await createOwnerOnlyWindowsDirectoryAncestry(directoryPath);
    if (firstCreated === undefined) {
      throw new Error("Windows mutation claim directory creation did not create its path.");
    }
  } else {
    await fs.mkdir(directoryPath, { mode: 0o700 });
    await fs.chmod(directoryPath, 0o700);
  }
  const metadataPath = path.join(directoryPath, PRIVATE_MUTATION_DIRECTORY_OWNER_FILE);
  let handle: FileHandle | undefined;
  try {
    if (options.platform === "win32" && process.platform === "win32") {
      await (options.createWindowsFile ?? createOwnerOnlyWindowsFile)(metadataPath);
      handle = await fs.open(metadataPath, "r+");
    } else {
      handle = await fs.open(metadataPath, "wx+", 0o600);
      await handle.chmod(0o600);
    }
    await handle.writeFile(ownerContents, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await syncParentDirectory(metadataPath, options.platform);
}

async function acquireDirectoryPrivateMutationClaim(
  parent: SecuredPrivateDirectory,
  options: {
    createWindowsFile?: (filePath: string) => Promise<FileIdentity>;
    platform?: NodeJS.Platform;
    runtime?: PrivateMutationClaimRuntime;
  },
): Promise<PrivateMutationClaim> {
  const platform = options.platform ?? process.platform;
  const runtime = options.runtime ?? defaultPrivateMutationClaimRuntime();
  const ownerContents = `${JSON.stringify({
    ownerId: runtime.ownerId,
    pid: runtime.pid,
    ...(runtime.processIdentity ? { processIdentity: runtime.processIdentity } : {}),
    processStartedAtMs: runtime.processStartedAtMs,
  } satisfies PrivateMutationClaimOwner)}\n`;
  parsePrivateMutationClaimOwner(ownerContents);
  const rootClaimPath = path.join(parent.directoryPath, PRIVATE_MUTATION_CLAIM_ROOT_FILE);
  const candidatePath = `${rootClaimPath}.${runtime.pid}.${randomUUID()}.candidate-dir`;
  await createPrivateMutationClaimDirectory(candidatePath, ownerContents, {
    ...(options.createWindowsFile ? { createWindowsFile: options.createWindowsFile } : {}),
    platform,
  });

  let claimPath = rootClaimPath;
  try {
    for (;;) {
      try {
        await fs.rename(candidatePath, claimPath);
      } catch (error) {
        const observed = await readPrivateMutationDirectoryClaim(claimPath);
        if (observed === null) {
          throw error;
        }
        if (privateMutationClaimOwnerIsActive(observed.metadata.owner, runtime)) {
          throw new Error("Private path mutation is already claimed.", { cause: error });
        }
        await parent.assertIdentityAt();
        const revalidated = await readPrivateMutationDirectoryClaim(claimPath);
        if (
          revalidated === null ||
          revalidated.identity.device !== observed.identity.device ||
          revalidated.identity.inode !== observed.identity.inode ||
          revalidated.metadata.contents !== observed.metadata.contents
        ) {
          continue;
        }
        claimPath = path.join(claimPath, ".next");
        continue;
      }
      break;
    }

    const [rootClaim, claimed] = await Promise.all([
      readPrivateMutationDirectoryClaim(rootClaimPath),
      readPrivateMutationDirectoryClaim(claimPath),
    ]);
    if (rootClaim === null) {
      throw new Error("Private mutation directory claim root disappeared.");
    }
    if (claimed === null || claimed.metadata.contents !== ownerContents) {
      throw new Error("Private mutation directory claim ownership could not be verified.");
    }
    const terminalRelativePath = path.relative(rootClaimPath, claimPath);
    await parent.assertIdentityAt();
    await syncParentDirectory(claimPath, platform);

    let released = false;
    let claimedParentPath = parent.directoryPath;
    let ownedRootClaimPath = rootClaimPath;
    let ownedClaimPath = claimPath;
    const assertOwned = async () => {
      await parent.assertIdentityAt(claimedParentPath);
      const [observedRoot, observed] = await Promise.all([
        readPrivateMutationDirectoryClaim(ownedRootClaimPath),
        readPrivateMutationDirectoryClaim(ownedClaimPath),
      ]);
      if (
        observedRoot === null ||
        observedRoot.identity.device !== rootClaim.identity.device ||
        observedRoot.identity.inode !== rootClaim.identity.inode ||
        observed === null ||
        observed.identity.device !== claimed.identity.device ||
        observed.identity.inode !== claimed.identity.inode ||
        observed.metadata.contents !== ownerContents
      ) {
        throw new Error("Private mutation directory claim owner changed.");
      }
    };
    return {
      assertOwned,
      async completeContainerRemoval() {
        if (released) {
          return;
        }
        try {
          await fs.lstat(claimedParentPath);
          throw new Error("Private directory path still exists after recursive removal.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        released = true;
      },
      async prepareContainerRemoval() {
        await assertOwned();
      },
      async relocateParent(directoryPath: string) {
        const relocatedRootClaimPath = path.join(directoryPath, path.basename(ownedRootClaimPath));
        const relocatedClaimPath = path.join(relocatedRootClaimPath, terminalRelativePath);
        await parent.assertIdentityAt(directoryPath);
        const [observedRoot, observed] = await Promise.all([
          readPrivateMutationDirectoryClaim(relocatedRootClaimPath),
          readPrivateMutationDirectoryClaim(relocatedClaimPath),
        ]);
        if (
          observedRoot === null ||
          observedRoot.identity.device !== rootClaim.identity.device ||
          observedRoot.identity.inode !== rootClaim.identity.inode ||
          observed === null ||
          observed.identity.device !== claimed.identity.device ||
          observed.identity.inode !== claimed.identity.inode ||
          observed.metadata.contents !== ownerContents
        ) {
          throw new Error("Private mutation directory claim changed during relocation.");
        }
        claimedParentPath = directoryPath;
        ownedRootClaimPath = relocatedRootClaimPath;
        ownedClaimPath = relocatedClaimPath;
      },
      async release() {
        if (released) {
          return;
        }
        await assertOwned();
        const releasePath = `${ownedRootClaimPath}.${randomUUID()}.release-dir`;
        await fs.rename(ownedRootClaimPath, releasePath);
        const [movedRoot, moved] = await Promise.all([
          readPrivateMutationDirectoryClaim(releasePath),
          readPrivateMutationDirectoryClaim(path.join(releasePath, terminalRelativePath)),
        ]);
        if (
          movedRoot === null ||
          movedRoot.identity.device !== rootClaim.identity.device ||
          movedRoot.identity.inode !== rootClaim.identity.inode ||
          moved === null ||
          moved.identity.device !== claimed.identity.device ||
          moved.identity.inode !== claimed.identity.inode ||
          moved.metadata.contents !== ownerContents
        ) {
          throw new Error("Private mutation directory claim changed during release.");
        }
        await fs.rm(releasePath, { force: true, recursive: true });
        released = true;
        await parent.assertIdentityAt(claimedParentPath);
        await syncParentDirectory(ownedRootClaimPath, platform);
      },
    };
  } finally {
    await fs.rm(candidatePath, { force: true, recursive: true });
  }
}

async function acquirePrivateMutationClaim(
  parent: SecuredPrivateDirectory,
  options: {
    createWindowsFile?: (filePath: string) => Promise<FileIdentity>;
    platform?: NodeJS.Platform;
    runtime?: PrivateMutationClaimRuntime;
  },
): Promise<PrivateMutationClaim> {
  const rootClaimPath = path.join(parent.directoryPath, PRIVATE_MUTATION_CLAIM_ROOT_FILE);
  try {
    const stats = await fs.lstat(rootClaimPath);
    if (stats.isDirectory()) {
      return await acquireDirectoryPrivateMutationClaim(parent, options);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    return await acquireHardLinkPrivateMutationClaim(parent, options);
  } catch (error) {
    let directoryClaimExists = false;
    try {
      directoryClaimExists = (await fs.lstat(rootClaimPath)).isDirectory();
    } catch {}
    if (!(error instanceof UnsupportedPrivateMutationHardLinkError) && !directoryClaimExists) {
      throw error;
    }
    return await acquireDirectoryPrivateMutationClaim(parent, options);
  }
}

async function captureOwnerOnlyPrivateClaimAncestor(
  directoryPath: string,
  platform: NodeJS.Platform,
): Promise<{ directory: SecuredPrivateDirectory; mutationRoot: boolean } | null> {
  if (platform === "win32" && process.platform === "win32") {
    try {
      await verifySafeWindowsDirectoryMutationBoundary(directoryPath);
    } catch {
      return null;
    }
    return {
      directory: await captureDirectoryIdentity(directoryPath),
      mutationRoot: false,
    };
  }

  const currentUserId = process.geteuid?.();
  if (currentUserId === undefined || !Number.isSafeInteger(currentUserId) || currentUserId < 0) {
    throw new Error("Could not resolve the current POSIX user for private mutation claims.");
  }
  const stats = await fs.lstat(directoryPath, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error("Private mutation claim ancestry contains a non-directory entry.");
  }
  if (
    stats.uid !== BigInt(currentUserId) ||
    (stats.mode & 0o022n) !== 0n ||
    (await darwinDirectoryHasExtendedAcl(directoryPath))
  ) {
    return null;
  }
  return {
    directory: await captureDirectoryIdentity(directoryPath),
    mutationRoot: (stats.mode & 0o1000n) !== 0n,
  };
}

async function ownerOnlyPrivateClaimAncestry(
  leaf: SecuredPrivateDirectory,
  platform: NodeJS.Platform,
): Promise<SecuredPrivateDirectory[]> {
  const ancestry = [leaf];
  let highestMutationRootIndex =
    platform !== "win32" &&
    process.platform !== "win32" &&
    ((await fs.lstat(leaf.directoryPath, { bigint: true })).mode & 0o1000n) !== 0n
      ? 0
      : -1;
  let directoryPath = path.dirname(leaf.directoryPath);
  while (directoryPath !== path.dirname(directoryPath)) {
    const ancestor = await captureOwnerOnlyPrivateClaimAncestor(directoryPath, platform);
    if (ancestor === null) {
      break;
    }
    ancestry.push(ancestor.directory);
    if (ancestor.mutationRoot) {
      highestMutationRootIndex = ancestry.length - 1;
    }
    directoryPath = path.dirname(directoryPath);
  }
  if (platform !== "win32" && process.platform !== "win32") {
    return highestMutationRootIndex < 0 ? [leaf] : ancestry.slice(0, highestMutationRootIndex + 1);
  }
  return ancestry;
}

async function acquirePrivateMutationClaimChain(
  leaf: SecuredPrivateDirectory,
  options: {
    createWindowsFile?: (filePath: string) => Promise<FileIdentity>;
    platform?: NodeJS.Platform;
    runtime?: PrivateMutationClaimRuntime;
  },
): Promise<PrivateMutationClaim> {
  const platform = options.platform ?? process.platform;
  const ancestry = await ownerOnlyPrivateClaimAncestry(leaf, platform);
  const highestClaimDirectory = ancestry.at(-1)!;
  const outerBoundary = await captureSafePrivateDirectoryMutationParent(
    highestClaimDirectory.directoryPath,
    platform,
  );
  const claims: PrivateMutationClaim[] = [];
  let leafClaim: PrivateMutationClaim | undefined;
  try {
    for (const directory of ancestry) {
      const claim = await acquirePrivateMutationClaim(directory, options);
      claims.push(claim);
      if (directory === leaf) {
        leafClaim = claim;
      }
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const claim of claims.reverse()) {
      try {
        await claim.release();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      const aggregateError = new AggregateError(
        [error, ...cleanupErrors],
        "Private mutation claim-chain acquisition failed and rollback cleanup also failed.",
      );
      aggregateError.cause = error;
      throw aggregateError;
    }
    throw error;
  }

  let released = false;
  let leafRemoved = false;
  const releaseClaims = async (claimsToRelease: PrivateMutationClaim[]) => {
    const releaseErrors: unknown[] = [];
    for (const claim of claimsToRelease) {
      try {
        await claim.release();
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    if (releaseErrors.length === 1) {
      throw releaseErrors[0];
    }
    if (releaseErrors.length > 1) {
      throw new AggregateError(releaseErrors, "Private mutation claim-chain release failed.");
    }
  };
  return {
    async assertOwned() {
      await outerBoundary.assertIdentityAt();
      for (const claim of claims) {
        await claim.assertOwned();
      }
    },
    async completeContainerRemoval() {
      if (released) {
        return;
      }
      if (leafClaim === undefined) {
        throw new Error("Private directory removal did not acquire its leaf mutation claim.");
      }
      let primaryError: unknown;
      try {
        await leafClaim.completeContainerRemoval();
        leafRemoved = true;
      } catch (error) {
        primaryError = error;
      }
      try {
        await releaseClaims(claims.slice(1).reverse());
      } catch (releaseError) {
        if (primaryError !== undefined) {
          const aggregateError = new AggregateError(
            [primaryError, releaseError],
            "Private directory removal completion and ancestor claim release both failed.",
          );
          aggregateError.cause = primaryError;
          throw aggregateError;
        }
        throw releaseError;
      }
      released = true;
      if (primaryError !== undefined) {
        throw primaryError;
      }
    },
    async prepareContainerRemoval() {
      if (leafClaim === undefined) {
        throw new Error("Private directory removal did not acquire its leaf mutation claim.");
      }
      await leafClaim.prepareContainerRemoval();
    },
    async relocateParent(directoryPath: string) {
      if (leafClaim === undefined) {
        throw new Error("Private directory removal did not acquire its leaf mutation claim.");
      }
      await leafClaim.relocateParent(directoryPath);
    },
    async release() {
      if (released) {
        return;
      }
      await releaseClaims(leafRemoved ? claims.slice(1).reverse() : [...claims].reverse());
      released = true;
    },
  };
}

async function secureOwnerOnlyMutationParent(
  directoryPath: string,
): Promise<SecuredPrivateDirectory> {
  return await securePrivateDirectory(directoryPath, {
    markMutationRoot: false,
    platform: process.platform,
  });
}

export async function publishPrivateFileAtomically(
  filePath: string,
  contents: string,
  options: {
    afterRename?: (filePath: string) => Promise<void>;
    beforeCommitRename?: (temporaryPath: string) => Promise<void>;
    beforeRename?: (temporaryPath: string) => Promise<void>;
    claimRuntime?: PrivateMutationClaimRuntime;
    createWindowsFile?: (temporaryPath: string) => Promise<FileIdentity>;
    createWindowsDirectories?: (directoryPath: string) => Promise<string | undefined>;
    platform?: NodeJS.Platform;
    removeTemporaryFile?: (temporaryPath: string) => Promise<void>;
    secureWindowsFile?: (temporaryPath: string) => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
  } = {},
): Promise<void> {
  assertNotReservedPrivateMutationPath(filePath);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const parentDirectory = path.resolve(path.dirname(filePath));
  const platform = options.platform ?? process.platform;
  let parentExists = false;
  try {
    const parentStats = await fs.lstat(parentDirectory);
    if (!parentStats.isDirectory()) {
      throw new Error("Private publication parent is not a directory.");
    }
    parentExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const creationBoundary = parentExists
    ? undefined
    : await captureSafePrivateMutationBoundary(
        await nearestExistingDirectory(parentDirectory),
        platform,
        true,
      );
  const firstCreatedDirectory =
    platform === "win32"
      ? parentExists
        ? undefined
        : await (options.createWindowsDirectories ?? createOwnerOnlyWindowsDirectoryAncestry)(
            parentDirectory,
          )
      : await fs.mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  await creationBoundary?.assertIdentityAt();
  await assertDarwinCreatedAncestryHasNoExtendedAcl(firstCreatedDirectory, parentDirectory);
  if (firstCreatedDirectory !== undefined && platform !== "win32") {
    await securePrivateDirectory(firstCreatedDirectory, {
      markMutationRoot: true,
      platform,
    });
  }
  const parent = await secureOwnerOnlyMutationParent(parentDirectory);
  const claim = await acquirePrivateMutationClaimChain(parent, {
    ...(options.claimRuntime ? { runtime: options.claimRuntime } : {}),
    ...(options.createWindowsFile ? { createWindowsFile: options.createWindowsFile } : {}),
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
    // Node has no portable renameat API. The owner-only parent and parent-wide claim chain fence
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
