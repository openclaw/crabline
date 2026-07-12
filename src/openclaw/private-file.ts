import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_OWNER_ONLY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$filePath = $env:CRABLINE_PRIVATE_FILE_PATH
if ([string]::IsNullOrWhiteSpace($filePath)) {
  throw "CRABLINE_PRIVATE_FILE_PATH is required."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}

$acl = Get-Acl -LiteralPath $filePath
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
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $filePath -AclObject $acl

$actual = Get-Acl -LiteralPath $filePath
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

export type WindowsAclRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => Promise<void>;

const runWindowsAclCommand: WindowsAclRunner = async (command, args, options) => {
  await execFileAsync(command, args, options);
};

function resolveWindowsPowerShellPath(systemRoot: string | null | undefined): string {
  const normalizedRoot = systemRoot?.trim() ? path.win32.normalize(systemRoot.trim()) : undefined;
  if (!normalizedRoot || !/^[A-Za-z]:\\/.test(normalizedRoot)) {
    throw new Error("SystemRoot must be an absolute local Windows path.");
  }
  return path.win32.join(normalizedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function applyOwnerOnlyWindowsAcl(
  filePath: string,
  run: WindowsAclRunner = runWindowsAclCommand,
  systemRoot: string | null | undefined = process.env.SystemRoot,
): Promise<void> {
  try {
    const powershellPath = resolveWindowsPowerShellPath(systemRoot);
    await run(
      powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_OWNER_ONLY_ACL_SCRIPT],
      {
        env: {
          ...process.env,
          CRABLINE_PRIVATE_FILE_PATH: path.resolve(filePath),
        },
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error(
      "Could not apply and verify an owner-only Windows ACL; powershell.exe with Set-Acl is required.",
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

type FileIdentity = {
  device: bigint;
  inode: bigint;
};

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
};

async function readDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity> {
  const stats = await fs.lstat(directoryPath, { bigint: true });
  if (!stats.isDirectory() || stats.ino <= 0n) {
    throw new Error("The filesystem did not provide a stable private directory identity.");
  }
  return {
    device: stats.dev,
    inode: stats.ino,
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

export async function securePrivateDirectory(
  directoryPath: string,
  options: {
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
  } = {},
): Promise<SecuredPrivateDirectory> {
  let created = false;
  try {
    await fs.mkdir(directoryPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const identity = await readDirectoryIdentity(directoryPath);
  try {
    if ((options.platform ?? process.platform) === "win32") {
      await (options.secureWindowsDirectory ?? applyOwnerOnlyWindowsDirectoryAcl)(directoryPath);
    } else {
      await fs.chmod(directoryPath, 0o700);
    }
    await assertDirectoryPathIdentity(directoryPath, identity);
  } catch (error) {
    if (created) {
      await assertDirectoryPathIdentity(directoryPath, identity)
        .then(() => fs.rm(directoryPath, { force: true, recursive: true }))
        .catch(() => undefined);
    }
    throw error;
  }

  return {
    async assertIdentityAt(currentPath = directoryPath) {
      await assertDirectoryPathIdentity(currentPath, identity);
    },
    directoryPath,
  };
}

export async function publishPrivateFileAtomically(
  filePath: string,
  contents: string,
  options: {
    afterRename?: (filePath: string) => Promise<void>;
    platform?: NodeJS.Platform;
    secureWindowsFile?: (temporaryPath: string) => Promise<void>;
  } = {},
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx+", 0o600);
    const identity = await readHandleIdentity(handle);
    if ((options.platform ?? process.platform) === "win32") {
      await (options.secureWindowsFile ?? applyOwnerOnlyWindowsAcl)(temporaryPath);
    } else {
      await handle.chmod(0o600);
    }

    await assertPathIdentity(temporaryPath, identity);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await assertPathIdentity(temporaryPath, identity);
    await fs.rename(temporaryPath, filePath);
    await options.afterRename?.(filePath);
    await assertPathIdentity(filePath, identity);
  } finally {
    try {
      await handle?.close();
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
