import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

const WINDOWS_CREATE_OWNER_ONLY_DIRECTORY_SCRIPT = String.raw`
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

# Apply the final security descriptor atomically for new directories, while
# migrating roots created by older Crabline versions before validation.
if ([System.IO.Directory]::Exists($directoryPath)) {
  $directory = [System.IO.DirectoryInfo]::new($directoryPath)
  if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Private directory must not be a reparse point."
  }
  $acl = $directory.GetAccessControl()
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
  $acl.SetAccessRule($rule)
  $directory.SetAccessControl($acl)
} else {
  $directory = [System.IO.Directory]::CreateDirectory($directoryPath, $acl)
}
$actual = $directory.GetAccessControl()
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
`;

const WINDOWS_DIRECTORY_SECURITY_DESCRIPTOR_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}

$acl = Get-Acl -LiteralPath $directoryPath
$descriptor = $acl.GetSecurityDescriptorBinaryForm()
[Convert]::ToBase64String($descriptor)
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
  if (!normalizedRoot || !/^[A-Za-z]:\\/u.test(normalizedRoot)) {
    throw new Error("SystemRoot must be an absolute local Windows path.");
  }
  return path.win32.join(normalizedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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

export async function createOwnerOnlyWindowsDirectory(
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
        WINDOWS_CREATE_OWNER_ONLY_DIRECTORY_SCRIPT,
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
      "Could not atomically create or verify an owner-only Windows directory; Windows PowerShell ACL support is required.",
      { cause: error },
    );
  }
}

export async function readWindowsDirectorySecurityDescriptor(
  directoryPath: string,
  run: WindowsAclRunner = runWindowsAclCommand,
  systemRoot: string | null | undefined = process.env.SystemRoot,
): Promise<string> {
  try {
    const powershellPath = resolveWindowsPowerShellPath(systemRoot);
    const descriptor = await run(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_DIRECTORY_SECURITY_DESCRIPTOR_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          CRABLINE_PRIVATE_DIRECTORY_PATH: path.resolve(directoryPath),
        },
        windowsHide: true,
      },
    );
    const normalized = descriptor.trim();
    if (!normalized) {
      throw new Error("Windows directory security descriptor was empty.");
    }
    return normalized;
  } catch (error) {
    throw new Error(
      "Could not read the Windows directory security descriptor; powershell.exe with Get-Acl is required.",
      { cause: error },
    );
  }
}
