import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_ACL_COMMAND_TIMEOUT_MS = 15_000;
const WINDOWS_DIRECTORY_HANDLE_HELPER = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CrablineWindowsDirectoryHandle
{
    private const uint FileReadAttributes = 0x00000080;
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint WriteOwner = 0x00080000;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint Synchronize = 0x00100000;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileCreate = 2;
    private const uint FileDirectoryFile = 0x00000001;
    private const uint FileSynchronousIoNonAlert = 0x00000020;
    private const uint FileOpenReparsePoint = 0x00200000;
    private const uint ObjectCaseInsensitive = 0x00000040;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint DirectoryAttribute = 0x00000010;
    private const uint ReparsePointAttribute = 0x00000400;
    private const int FileIdInfoClass = 18;
    private const uint OwnerSecurityInformation = 0x00000001;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint ProtectedDaclSecurityInformation = 0x80000000;
    private const int SeFileObject = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileId128
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] Identifier;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    {
        public ulong VolumeSerialNumber;
        public FileId128 FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [DllImport(
        "kernel32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
        out SafeFileHandle file,
        uint desiredAccess,
        ref ObjectAttributes objectAttributes,
        out IoStatusBlock ioStatus,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint eaLength
    );

    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FileIdInfo information,
        uint bufferSize
    );

    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(
        SafeFileHandle file,
        int objectType,
        uint securityInformation,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor
    );

    [DllImport("advapi32.dll")]
    private static extern uint SetSecurityInfo(
        SafeFileHandle file,
        int objectType,
        uint securityInformation,
        IntPtr owner,
        IntPtr group,
        IntPtr dacl,
        IntPtr sacl
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorOwner(
        IntPtr securityDescriptor,
        out IntPtr owner,
        [MarshalAs(UnmanagedType.Bool)] out bool ownerDefaulted
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr securityDescriptor,
        [MarshalAs(UnmanagedType.Bool)] out bool daclPresent,
        out IntPtr dacl,
        [MarshalAs(UnmanagedType.Bool)] out bool daclDefaulted
    );

    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(
        IntPtr securityDescriptor
    );

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(
        IntPtr memory
    );

    public static SafeFileHandle Open(string path, bool writable)
    {
        uint access = FileReadAttributes | ReadControl;
        if (writable) {
            access |= WriteDac | WriteOwner;
        }
        SafeFileHandle file = CreateFile(
            path,
            access,
            ShareRead | ShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero
        );
        if (file.IsInvalid) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            ReadIdentity(file);
            return file;
        } catch {
            file.Dispose();
            throw;
        }
    }

    public static SafeFileHandle Create(string path, byte[] securityDescriptor)
    {
        string fullPath = Path.GetFullPath(path);
        string nativePath;
        if (fullPath.StartsWith(@"\\?\", StringComparison.Ordinal)) {
            nativePath = @"\??\" + fullPath.Substring(4);
        } else if (fullPath.StartsWith(@"\\", StringComparison.Ordinal)) {
            nativePath = @"\??\UNC\" + fullPath.Substring(2);
        } else {
            nativePath = @"\??\" + fullPath;
        }
        int pathBytes = nativePath.Length * 2;
        if (pathBytes > UInt16.MaxValue - 2) {
            throw new PathTooLongException();
        }

        GCHandle descriptorHandle = GCHandle.Alloc(
            securityDescriptor,
            GCHandleType.Pinned
        );
        IntPtr pathBuffer = IntPtr.Zero;
        IntPtr objectNameBuffer = IntPtr.Zero;
        try {
            pathBuffer = Marshal.StringToHGlobalUni(nativePath);
            UnicodeString objectName = new UnicodeString {
                Length = (ushort)pathBytes,
                MaximumLength = (ushort)(pathBytes + 2),
                Buffer = pathBuffer
            };
            objectNameBuffer = Marshal.AllocHGlobal(
                Marshal.SizeOf(typeof(UnicodeString))
            );
            Marshal.StructureToPtr(objectName, objectNameBuffer, false);
            ObjectAttributes attributes = new ObjectAttributes {
                Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = IntPtr.Zero,
                ObjectName = objectNameBuffer,
                Attributes = ObjectCaseInsensitive,
                SecurityDescriptor = descriptorHandle.AddrOfPinnedObject(),
                SecurityQualityOfService = IntPtr.Zero
            };
            IoStatusBlock ioStatus;
            SafeFileHandle file;
            int status = NtCreateFile(
                out file,
                FileReadAttributes |
                    ReadControl |
                    WriteDac |
                    WriteOwner |
                    Synchronize,
                ref attributes,
                out ioStatus,
                IntPtr.Zero,
                FileAttributeNormal,
                ShareRead | ShareWrite,
                FileCreate,
                FileDirectoryFile |
                    FileSynchronousIoNonAlert |
                    FileOpenReparsePoint,
                IntPtr.Zero,
                0
            );
            if (status < 0) {
                throw new Win32Exception(
                    unchecked((int)RtlNtStatusToDosError(status))
                );
            }
            if (file == null || file.IsInvalid) {
                throw new InvalidOperationException(
                    "Windows did not return the created directory handle."
                );
            }
            try {
                ReadIdentity(file);
                return file;
            } catch {
                file.Dispose();
                throw;
            }
        } finally {
            if (objectNameBuffer != IntPtr.Zero) {
                Marshal.FreeHGlobal(objectNameBuffer);
            }
            if (pathBuffer != IntPtr.Zero) {
                Marshal.FreeHGlobal(pathBuffer);
            }
            descriptorHandle.Free();
        }
    }

    public static string ReadIdentity(SafeFileHandle file)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(file, out information)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if ((information.FileAttributes & ReparsePointAttribute) != 0) {
            throw new InvalidOperationException(
                "Private directory must not be a reparse point."
            );
        }
        if ((information.FileAttributes & DirectoryAttribute) == 0) {
            throw new InvalidOperationException(
                "Private directory handle does not reference a directory."
            );
        }
        FileIdInfo identity;
        uint identitySize = (uint)Marshal.SizeOf(typeof(FileIdInfo));
        if (!GetFileInformationByHandleEx(
            file,
            FileIdInfoClass,
            out identity,
            identitySize
        )) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        byte[] identifier = identity.FileId.Identifier;
        bool hasIdentity = identifier != null && identifier.Length == 16;
        if (hasIdentity) {
            hasIdentity = false;
            foreach (byte value in identifier) {
                if (value != 0) {
                    hasIdentity = true;
                    break;
                }
            }
        }
        if (!hasIdentity) {
            throw new InvalidOperationException(
                "Windows did not return a stable directory identity."
            );
        }
        return identity.VolumeSerialNumber.ToString(
            System.Globalization.CultureInfo.InvariantCulture
        ) + ":" + BitConverter.ToString(identifier).Replace("-", String.Empty);
    }

    public static byte[] ReadSecurityDescriptor(SafeFileHandle file)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr securityDescriptor;
        uint error = GetSecurityInfo(
            file,
            SeFileObject,
            OwnerSecurityInformation | DaclSecurityInformation,
            out owner,
            out group,
            out dacl,
            out sacl,
            out securityDescriptor
        );
        if (error != 0) {
            throw new Win32Exception((int)error);
        }
        try {
            uint length = GetSecurityDescriptorLength(securityDescriptor);
            if (length == 0 || length > Int32.MaxValue) {
                throw new InvalidOperationException(
                    "Windows returned an invalid directory security descriptor."
                );
            }
            byte[] descriptor = new byte[(int)length];
            Marshal.Copy(securityDescriptor, descriptor, 0, descriptor.Length);
            return descriptor;
        } finally {
            LocalFree(securityDescriptor);
        }
    }

    public static void WriteSecurityDescriptor(
        SafeFileHandle file,
        byte[] securityDescriptor
    )
    {
        GCHandle descriptorHandle = GCHandle.Alloc(
            securityDescriptor,
            GCHandleType.Pinned
        );
        try {
            IntPtr descriptor = descriptorHandle.AddrOfPinnedObject();
            IntPtr owner;
            bool ownerDefaulted;
            if (!GetSecurityDescriptorOwner(
                descriptor,
                out owner,
                out ownerDefaulted
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            bool daclPresent;
            IntPtr dacl;
            bool daclDefaulted;
            if (!GetSecurityDescriptorDacl(
                descriptor,
                out daclPresent,
                out dacl,
                out daclDefaulted
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!daclPresent) {
                throw new InvalidOperationException(
                    "Private directory security descriptor has no DACL."
                );
            }
            uint error = SetSecurityInfo(
                file,
                SeFileObject,
                OwnerSecurityInformation |
                    DaclSecurityInformation |
                    ProtectedDaclSecurityInformation,
                owner,
                IntPtr.Zero,
                dacl,
                IntPtr.Zero
            );
            if (error != 0) {
                throw new Win32Exception((int)error);
            }
        } finally {
            descriptorHandle.Free();
        }
    }

    public static void AssertSamePathIdentity(string path, string expected)
    {
        using (SafeFileHandle current = Open(path, false)) {
            if (!String.Equals(
                ReadIdentity(current),
                expected,
                StringComparison.Ordinal
            )) {
                throw new InvalidOperationException(
                    "Private directory identity changed during ACL mutation."
                );
            }
        }
    }
}
"@
`;

const WINDOWS_OWNER_ONLY_DIRECTORY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}
$directoryPath = [System.IO.Path]::GetFullPath($directoryPath)
$rootPath = [System.IO.Path]::GetPathRoot($directoryPath)
if ($directoryPath.Length -gt $rootPath.Length) {
  $directoryPath = $directoryPath.TrimEnd(
    [char[]]@(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
  )
}

${WINDOWS_DIRECTORY_HANDLE_HELPER}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}

$directory = [CrablineWindowsDirectoryHandle]::Open($directoryPath, $true)
try {
  $directoryIdentity = [CrablineWindowsDirectoryHandle]::ReadIdentity($directory)
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetSecurityDescriptorBinaryForm(
    [CrablineWindowsDirectoryHandle]::ReadSecurityDescriptor($directory)
  )
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
  [CrablineWindowsDirectoryHandle]::WriteSecurityDescriptor(
    $directory,
    $acl.GetSecurityDescriptorBinaryForm()
  )

  $actual = [System.Security.AccessControl.DirectorySecurity]::new()
  $actual.SetSecurityDescriptorBinaryForm(
    [CrablineWindowsDirectoryHandle]::ReadSecurityDescriptor($directory)
  )
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
  [CrablineWindowsDirectoryHandle]::AssertSamePathIdentity(
    $directoryPath,
    $directoryIdentity
  )
} finally {
  $directory.Dispose()
}
`;

const WINDOWS_CREATE_OWNER_ONLY_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}
$directoryPath = [System.IO.Path]::GetFullPath($directoryPath)
$rootPath = [System.IO.Path]::GetPathRoot($directoryPath)
if ($directoryPath.Length -gt $rootPath.Length) {
  $directoryPath = $directoryPath.TrimEnd(
    [char[]]@(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
  )
}

${WINDOWS_DIRECTORY_HANDLE_HELPER}

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

if ([System.IO.Directory]::Exists($directoryPath)) {
  $directory = [CrablineWindowsDirectoryHandle]::Open($directoryPath, $true)
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetSecurityDescriptorBinaryForm(
    [CrablineWindowsDirectoryHandle]::ReadSecurityDescriptor($directory)
  )
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
  [CrablineWindowsDirectoryHandle]::WriteSecurityDescriptor(
    $directory,
    $acl.GetSecurityDescriptorBinaryForm()
  )
} else {
  $parent = [System.IO.Directory]::GetParent(
    $directoryPath
  )
  if ($null -eq $parent) {
    throw "Private directory must have a parent."
  }
  [void][System.IO.Directory]::CreateDirectory($parent.FullName)
  $directory = [CrablineWindowsDirectoryHandle]::Create(
    $directoryPath,
    $acl.GetSecurityDescriptorBinaryForm()
  )
}
try {
  $directoryIdentity = [CrablineWindowsDirectoryHandle]::ReadIdentity($directory)
  $actual = [System.Security.AccessControl.DirectorySecurity]::new()
  $actual.SetSecurityDescriptorBinaryForm(
    [CrablineWindowsDirectoryHandle]::ReadSecurityDescriptor($directory)
  )
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
  [CrablineWindowsDirectoryHandle]::AssertSamePathIdentity(
    $directoryPath,
    $directoryIdentity
  )
} finally {
  $directory.Dispose()
}
`;

const WINDOWS_DIRECTORY_SECURITY_DESCRIPTOR_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directoryPath = $env:CRABLINE_PRIVATE_DIRECTORY_PATH
if ([string]::IsNullOrWhiteSpace($directoryPath)) {
  throw "CRABLINE_PRIVATE_DIRECTORY_PATH is required."
}

$acl = Get-Acl -LiteralPath $directoryPath
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($null -eq $sid) {
  throw "Could not resolve the current Windows user SID."
}
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
$requiredInheritance = (
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
if (
  -not $acl.AreAccessRulesProtected -or
  $ownerSid.Value -ne $sid.Value -or
  $rules.Count -ne 1
) {
  throw "Windows directory security descriptor is not owner-only."
}
$rule = $rules[0]
if (
  $rule.IsInherited -or
  $rule.IdentityReference.Value -ne $sid.Value -or
  $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) -or
  (($rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance)
) {
  throw "Windows directory security descriptor is not owner-only."
}
$descriptor = $acl.GetSecurityDescriptorBinaryForm()
[Convert]::ToBase64String($descriptor)
`;

export type WindowsAclRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    killSignal: NodeJS.Signals;
    timeout: number;
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
        killSignal: "SIGKILL",
        timeout: WINDOWS_ACL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error(
      "Could not apply and verify an owner-only Windows directory ACL; Windows PowerShell ACL support is required.",
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
        killSignal: "SIGKILL",
        timeout: WINDOWS_ACL_COMMAND_TIMEOUT_MS,
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
        killSignal: "SIGKILL",
        timeout: WINDOWS_ACL_COMMAND_TIMEOUT_MS,
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
