import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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

export async function publishPrivateFileAtomically(
  filePath: string,
  contents: string,
  options: {
    platform?: NodeJS.Platform;
    secureWindowsFile?: (temporaryPath: string) => Promise<void>;
  } = {},
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if ((options.platform ?? process.platform) === "win32") {
      await (options.secureWindowsFile ?? applyOwnerOnlyWindowsAcl)(temporaryPath);
    } else {
      await fs.chmod(temporaryPath, 0o600);
    }

    const handle = await fs.open(temporaryPath, "r+");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
