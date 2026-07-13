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

export function resolveWindowsPowerShellPath(systemRoot: string | null | undefined): string {
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
): Promise<void> {
  if (path.basename(quarantineBaseName) !== quarantineBaseName || quarantineBaseName.length === 0) {
    throw new Error("Private directory quarantine basename is malformed.");
  }
  const quarantinePath = path.join(
    path.dirname(currentPath),
    `.${quarantineBaseName}.${process.pid}.${randomUUID()}.remove`,
  );
  await secured.assertIdentityAt(currentPath);
  await fs.rename(currentPath, quarantinePath);
  await secured.assertIdentityAt(quarantinePath);
  await syncParentDirectory(quarantinePath);
  await fs.rm(quarantinePath, { force: true, recursive: true });
  await syncParentDirectory(quarantinePath);
}

export async function securePrivateDirectory(
  directoryPath: string,
  options: {
    currentUserId?: number;
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
    syncDirectory?: () => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
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
    if ((options.platform ?? process.platform) === "win32") {
      await (options.secureWindowsDirectory ?? applyOwnerOnlyWindowsDirectoryAcl)(directoryPath);
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

export async function publishPrivateFileAtomically(
  filePath: string,
  contents: string,
  options: {
    afterRename?: (filePath: string) => Promise<void>;
    beforeRename?: (temporaryPath: string) => Promise<void>;
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
  const firstCreatedDirectory = await fs.mkdir(parentDirectory, { recursive: true });
  let handle: FileHandle | undefined;
  let publicationFailed = false;
  let primaryError: unknown;
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
    await options.beforeRename?.(temporaryPath);
    await assertPathIdentity(temporaryPath, identity);
    await fs.rename(temporaryPath, filePath);
    await syncPathAncestry(
      filePath,
      options.syncParent ?? syncParentDirectory,
      options.platform,
      firstCreatedDirectory,
    );
    await options.afterRename?.(filePath);
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
