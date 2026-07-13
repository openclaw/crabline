import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import type {
  InboundEnvelope,
  ProviderAdapter,
  ProviderContext,
  SendContext,
  WaitContext,
  WatchContext,
} from "../types.js";

const MAX_SCRIPT_OUTPUT_BYTES = 1024 * 1024;
const SCRIPT_WAIT_EXIT_GRACE_MS = 250;
const CHILD_CLOSE_TIMEOUT_MS = 1_000;
const WINDOWS_TERMINATION_COMMAND_TIMEOUT_MS = 2_500;
const WINDOWS_JOB_COMMAND_ENV = "CRABLINE_INTERNAL_SCRIPT_JOB_COMMAND";
const WINDOWS_JOB_SHELL_ENV = "CRABLINE_INTERNAL_SCRIPT_JOB_SHELL";
const WINDOWS_JOB_HELPER_SOURCE_ENV = "CRABLINE_INTERNAL_SCRIPT_JOB_HELPER_SOURCE";
const WINDOWS_JOB_HELPER_OUTPUT_ENV = "CRABLINE_INTERNAL_SCRIPT_JOB_HELPER_OUTPUT";
const WINDOWS_JOB_HELPER_SOURCE = [
  "using System;",
  "using System.ComponentModel;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public static class CrablineScriptJob{",
  "private const uint CreateSuspended=0x00000004;",
  "private const uint ExtendedStartupInfoPresent=0x00080000;",
  "private const uint Infinite=0xffffffff;",
  "private const uint JobObjectLimitKillOnJobClose=0x00002000;",
  "private const int ProcThreadAttributeJobList=0x0002000d;",
  "private const uint StartfUseStdHandles=0x00000100;",
  "private const uint DuplicateSameAccess=0x00000002;",
  "private const uint ResumeThreadFailed=0xffffffff;",
  "private const int JobObjectExtendedLimitInformationClass=9;",
  "private const int StdInputHandle=-10;",
  "private const int StdOutputHandle=-11;",
  "private const int StdErrorHandle=-12;",
  "[StructLayout(LayoutKind.Sequential)]",
  "private struct ProcessInformation{",
  "public IntPtr Process;",
  "public IntPtr Thread;",
  "public uint ProcessId;",
  "public uint ThreadId;",
  "}",
  "[StructLayout(LayoutKind.Sequential)]",
  "private struct StartupInfo{",
  "public int Size;",
  "public IntPtr Reserved;",
  "public IntPtr Desktop;",
  "public IntPtr Title;",
  "public int X;",
  "public int Y;",
  "public int XSize;",
  "public int YSize;",
  "public int XCountChars;",
  "public int YCountChars;",
  "public int FillAttribute;",
  "public uint Flags;",
  "public short ShowWindow;",
  "public short Reserved2Size;",
  "public IntPtr Reserved2;",
  "public IntPtr StandardInput;",
  "public IntPtr StandardOutput;",
  "public IntPtr StandardError;",
  "}",
  "[StructLayout(LayoutKind.Sequential)]",
  "private struct StartupInfoEx{",
  "public StartupInfo StartupInfo;",
  "public IntPtr AttributeList;",
  "}",
  "[StructLayout(LayoutKind.Sequential)]",
  "private struct JobObjectBasicLimitInformation{",
  "public long PerProcessUserTimeLimit;",
  "public long PerJobUserTimeLimit;",
  "public uint LimitFlags;",
  "public UIntPtr MinimumWorkingSetSize;",
  "public UIntPtr MaximumWorkingSetSize;",
  "public uint ActiveProcessLimit;",
  "public IntPtr Affinity;",
  "public uint PriorityClass;",
  "public uint SchedulingClass;",
  "}",
  "[StructLayout(LayoutKind.Sequential)]",
  "private struct IoCounters{",
  "public ulong ReadOperationCount;",
  "public ulong WriteOperationCount;",
  "public ulong OtherOperationCount;",
  "public ulong ReadTransferCount;",
  "public ulong WriteTransferCount;",
  "public ulong OtherTransferCount;",
  "}",
  "[StructLayout(LayoutKind.Sequential)]",
  "private struct JobObjectExtendedLimitInformation{",
  "public JobObjectBasicLimitInformation BasicLimitInformation;",
  "public IoCounters IoInfo;",
  "public UIntPtr ProcessMemoryLimit;",
  "public UIntPtr JobMemoryLimit;",
  "public UIntPtr PeakProcessMemoryUsed;",
  "public UIntPtr PeakJobMemoryUsed;",
  "}",
  '[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool CreateProcess(string applicationName,StringBuilder commandLine,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint creationFlags,IntPtr environment,string currentDirectory,ref StartupInfoEx startupInfo,out ProcessInformation processInformation);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "private static extern IntPtr CreateJobObject(IntPtr jobAttributes,string name);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool SetInformationJobObject(IntPtr job,int informationClass,ref JobObjectExtendedLimitInformation information,uint informationLength);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList,int attributeCount,int flags,ref IntPtr size);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool UpdateProcThreadAttribute(IntPtr attributeList,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previousValue,IntPtr returnSize);",
  '[DllImport("kernel32.dll")]',
  "private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr sourceHandle,IntPtr targetProcess,out IntPtr targetHandle,uint desiredAccess,bool inheritHandle,uint options);",
  '[DllImport("kernel32.dll")]',
  "private static extern IntPtr GetCurrentProcess();",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "private static extern IntPtr GetStdHandle(int standardHandle);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "private static extern uint ResumeThread(IntPtr thread);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool TerminateProcess(IntPtr process,uint exitCode);",
  '[DllImport("kernel32.dll")]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool CloseHandle(IntPtr handle);",
  "private static void ThrowLastError(string operation){throw new Win32Exception(Marshal.GetLastWin32Error(),operation);}",
  "private static IntPtr DuplicateStandardHandle(int standardHandle){",
  "IntPtr source=GetStdHandle(standardHandle);",
  "IntPtr duplicate=IntPtr.Zero;",
  "IntPtr process=GetCurrentProcess();",
  'if(source==IntPtr.Zero||source==new IntPtr(-1)||!DuplicateHandle(process,source,process,out duplicate,0,true,DuplicateSameAccess)){ThrowLastError("Could not duplicate a script standard handle.");}',
  "return duplicate;",
  "}",
  "private static int Run(string applicationName,string commandLine){",
  "IntPtr job=IntPtr.Zero;",
  "IntPtr attributeList=IntPtr.Zero;",
  "IntPtr jobList=IntPtr.Zero;",
  "IntPtr standardInput=IntPtr.Zero;",
  "IntPtr standardOutput=IntPtr.Zero;",
  "IntPtr standardError=IntPtr.Zero;",
  "ProcessInformation processInformation=new ProcessInformation();",
  "bool processCreated=false;",
  "try{",
  "job=CreateJobObject(IntPtr.Zero,null);",
  'if(job==IntPtr.Zero){ThrowLastError("Could not create the script job object.");}',
  "JobObjectExtendedLimitInformation limits=new JobObjectExtendedLimitInformation();",
  "limits.BasicLimitInformation.LimitFlags=JobObjectLimitKillOnJobClose;",
  'if(!SetInformationJobObject(job,JobObjectExtendedLimitInformationClass,ref limits,(uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation)))){ThrowLastError("Could not configure the script job object.");}',
  "IntPtr attributeListSize=IntPtr.Zero;",
  "InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeListSize);",
  "attributeList=Marshal.AllocHGlobal(attributeListSize);",
  'if(!InitializeProcThreadAttributeList(attributeList,1,0,ref attributeListSize)){ThrowLastError("Could not initialize the script job attribute list.");}',
  "jobList=Marshal.AllocHGlobal(IntPtr.Size);",
  "Marshal.WriteIntPtr(jobList,job);",
  'if(!UpdateProcThreadAttribute(attributeList,0,new IntPtr(ProcThreadAttributeJobList),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)){ThrowLastError("Could not bind the script process to its job object.");}',
  "standardInput=DuplicateStandardHandle(StdInputHandle);",
  "standardOutput=DuplicateStandardHandle(StdOutputHandle);",
  "standardError=DuplicateStandardHandle(StdErrorHandle);",
  "StartupInfoEx startupInfo=new StartupInfoEx();",
  "startupInfo.StartupInfo.Size=Marshal.SizeOf(typeof(StartupInfoEx));",
  "startupInfo.StartupInfo.Flags=StartfUseStdHandles;",
  "startupInfo.StartupInfo.StandardInput=standardInput;",
  "startupInfo.StartupInfo.StandardOutput=standardOutput;",
  "startupInfo.StartupInfo.StandardError=standardError;",
  "startupInfo.AttributeList=attributeList;",
  'if(!CreateProcess(applicationName,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,true,CreateSuspended|ExtendedStartupInfoPresent,IntPtr.Zero,Environment.CurrentDirectory,ref startupInfo,out processInformation)){ThrowLastError("Could not start the script command.");}',
  "processCreated=true;",
  'if(ResumeThread(processInformation.Thread)==ResumeThreadFailed){ThrowLastError("Could not resume the script command.");}',
  'if(WaitForSingleObject(processInformation.Process,Infinite)==Infinite){ThrowLastError("Could not wait for the script command.");}',
  "uint exitCode;",
  'if(!GetExitCodeProcess(processInformation.Process,out exitCode)){ThrowLastError("Could not read the script exit code.");}',
  "return unchecked((int)exitCode);",
  "}finally{",
  "if(processCreated&&processInformation.Process!=IntPtr.Zero){TerminateProcess(processInformation.Process,1);}",
  "if(processInformation.Thread!=IntPtr.Zero){CloseHandle(processInformation.Thread);}",
  "if(processInformation.Process!=IntPtr.Zero){CloseHandle(processInformation.Process);}",
  "if(standardInput!=IntPtr.Zero){CloseHandle(standardInput);}",
  "if(standardOutput!=IntPtr.Zero){CloseHandle(standardOutput);}",
  "if(standardError!=IntPtr.Zero){CloseHandle(standardError);}",
  "if(attributeList!=IntPtr.Zero){DeleteProcThreadAttributeList(attributeList);Marshal.FreeHGlobal(attributeList);}",
  "if(jobList!=IntPtr.Zero){Marshal.FreeHGlobal(jobList);}",
  "if(job!=IntPtr.Zero){CloseHandle(job);}",
  "}",
  "}",
  "public static int Main(string[] arguments){",
  "try{",
  'if(arguments.Length==1&&arguments[0]=="--probe"){return 0;}',
  `string shellValue=Environment.GetEnvironmentVariable("${WINDOWS_JOB_SHELL_ENV}");`,
  `string commandValue=Environment.GetEnvironmentVariable("${WINDOWS_JOB_COMMAND_ENV}");`,
  `Environment.SetEnvironmentVariable("${WINDOWS_JOB_SHELL_ENV}",null);`,
  `Environment.SetEnvironmentVariable("${WINDOWS_JOB_COMMAND_ENV}",null);`,
  'if(String.IsNullOrEmpty(shellValue)||String.IsNullOrEmpty(commandValue)){throw new InvalidOperationException("Missing script job configuration.");}',
  "string shell=Encoding.UTF8.GetString(Convert.FromBase64String(shellValue));",
  "string commandLine=Encoding.UTF8.GetString(Convert.FromBase64String(commandValue));",
  "return Run(shell,commandLine);",
  "}catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}",
  "}",
  "}",
].join("");
const WINDOWS_PROCESS_TERMINATOR_SOURCE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class CrablineProcessTerminator{",
  "private const uint ProcessTerminate=0x0001;",
  "private const uint ProcessQueryLimitedInformation=0x1000;",
  "private const uint Synchronize=0x00100000;",
  "private const uint WaitObject0=0;",
  "private const uint WaitTimeout=258;",
  "private const int ErrorInvalidParameter=87;",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "private static extern IntPtr OpenProcess(uint access,bool inheritHandle,int processId);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool GetProcessTimes(IntPtr process,out long creationTime,out long exitTime,out long kernelTime,out long userTime);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool TerminateProcess(IntPtr process,uint exitCode);",
  '[DllImport("kernel32.dll",SetLastError=true)]',
  "private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);",
  '[DllImport("kernel32.dll")]',
  "[return:MarshalAs(UnmanagedType.Bool)]",
  "private static extern bool CloseHandle(IntPtr handle);",
  "public static bool TerminateVerified(int processId,long expectedCreationTime){",
  "IntPtr handle=OpenProcess(ProcessTerminate|ProcessQueryLimitedInformation|Synchronize,false,processId);",
  "if(handle==IntPtr.Zero){return Marshal.GetLastWin32Error()==ErrorInvalidParameter;}",
  "try{",
  "long creationTime,exitTime,kernelTime,userTime;",
  "if(!GetProcessTimes(handle,out creationTime,out exitTime,out kernelTime,out userTime)){return false;}",
  "if(creationTime/10!=expectedCreationTime/10){return true;}",
  "uint status=WaitForSingleObject(handle,0);",
  "if(status==WaitObject0){return true;}",
  "if(status!=WaitTimeout){return false;}",
  "if(!TerminateProcess(handle,1)){return WaitForSingleObject(handle,0)==WaitObject0;}",
  "return WaitForSingleObject(handle,1000)==WaitObject0;",
  "}finally{CloseHandle(handle);}",
  "}",
  "}",
].join("");

let windowsJobHelperPath: string | null | undefined;

function removeWindowsJobHelper(directory: string): void {
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // The helper may still be exiting during process shutdown.
  }
}

function ensureWindowsJobHelper(): string | undefined {
  if (windowsJobHelperPath !== undefined) {
    return windowsJobHelperPath ?? undefined;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "crabline-script-job-"));
  const helperPath = path.join(directory, "crabline-script-job.exe");
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -TypeDefinition $env:${WINDOWS_JOB_HELPER_SOURCE_ENV} -Language CSharp -OutputAssembly $env:${WINDOWS_JOB_HELPER_OUTPUT_ENV} -OutputType ConsoleApplication`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          [WINDOWS_JOB_HELPER_OUTPUT_ENV]: helperPath,
          [WINDOWS_JOB_HELPER_SOURCE_ENV]: WINDOWS_JOB_HELPER_SOURCE,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        windowsHide: true,
      },
    );
    execFileSync(helperPath, ["--probe"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    removeWindowsJobHelper(directory);
    windowsJobHelperPath = null;
    return undefined;
  }
  windowsJobHelperPath = helperPath;
  process.once("exit", () => removeWindowsJobHelper(directory));
  return helperPath;
}

function quoteWindowsArgument(value: string): string {
  if (!value) {
    return '""';
  }
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function windowsShellCommand(
  command: string,
  shell?: string,
): {
  commandLine: string;
  shell: string;
} {
  const resolvedShell = shell ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const shellCommand = quoteWindowsArgument(resolvedShell);
  const shellName = path.win32.basename(resolvedShell).toLowerCase();
  return {
    commandLine:
      shellName === "cmd" || shellName === "cmd.exe"
        ? `${shellCommand} /d /s /c "${command}"`
        : `${shellCommand} -c ${quoteWindowsArgument(command)}`,
    shell: resolvedShell,
  };
}

function spawnScriptChild(params: {
  command: string;
  cwd?: string | undefined;
  shell?: string | undefined;
}): { child: SpawnedScriptChild; observedAtMs: number; startedAtMs: number } {
  const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
  let startedAtMs: number;
  let child: SpawnedScriptChild;
  if (process.platform === "win32") {
    const helperPath = ensureWindowsJobHelper();
    startedAtMs = Date.now();
    if (helperPath) {
      const shellCommand = windowsShellCommand(params.command, params.shell);
      child = spawn(helperPath, [], {
        cwd,
        env: {
          ...process.env,
          [WINDOWS_JOB_COMMAND_ENV]: Buffer.from(shellCommand.commandLine).toString("base64"),
          [WINDOWS_JOB_SHELL_ENV]: Buffer.from(shellCommand.shell).toString("base64"),
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } else {
      child = spawn(params.command, {
        cwd,
        env: process.env,
        shell: params.shell ?? true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    }
  } else {
    startedAtMs = Date.now();
    child = spawn(params.command, {
      cwd,
      env: process.env,
      shell: params.shell ?? true,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return { child, observedAtMs: Date.now(), startedAtMs };
}

type ScriptWatchIterator = AsyncIterableIterator<InboundEnvelope> & {
  [Symbol.asyncIterator](): ScriptWatchIterator;
  return(): Promise<IteratorResult<InboundEnvelope, undefined>>;
  throw(error?: unknown): Promise<IteratorResult<InboundEnvelope, undefined>>;
};

type ScriptPayload = {
  fixture: ProviderContext["fixture"];
  provider: {
    config: ProviderContext["config"];
    id: string;
    manifestPath: string;
  };
};

type ScriptDiagnosticsSnapshot = {
  commandValues: string[];
  configuredCommands: string[];
  diagnosticsSafe: boolean;
  exactCommandValues: string[];
  sensitiveEnvironmentValues: string[];
  sensitivePayloadValues: string[];
};

type SpawnedScriptChild = ChildProcessByStdio<Writable, Readable, Readable>;
type ScriptChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const ScriptMessageSchema = z.object({
  author: z.enum(["assistant", "system", "user"]),
  id: z.string().min(1),
  raw: z.unknown().optional(),
  sentAt: z.string().min(1),
  text: z.string(),
  threadId: z.string().min(1),
});

const ScriptProbeResultSchema = z.object({
  details: z.array(z.string()).optional(),
  healthy: z.boolean(),
});

const ScriptSendResultSchema = z.object({
  accepted: z.boolean(),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
});

const ScriptInboundResultSchema = z
  .object({
    message: ScriptMessageSchema.optional(),
    timeout: z.boolean().optional(),
  })
  .refine(
    (result) =>
      (result.timeout === true && result.message === undefined) ||
      (result.timeout !== true && result.message !== undefined),
    { message: "result must contain either a message or timeout: true" },
  );

function runTerminationCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let cleanup: ChildProcess;
    try {
      cleanup = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(succeeded);
    };
    const timeout = setTimeout(() => {
      try {
        cleanup.kill("SIGKILL");
      } catch {
        // The cleanup process may have exited at the timeout boundary.
      }
      finish(false);
    }, WINDOWS_TERMINATION_COMMAND_TIMEOUT_MS);
    timeout.unref();
    cleanup.once("close", (code) => finish(code === 0));
    cleanup.once("error", () => finish(false));
  });
}

function windowsProcessTreeTermination(
  pid: number,
  childStartedAtMs: number,
  childObservedAtMs: number,
  rootExpectedAlive: boolean,
): string {
  const rootNotBeforeMs = Math.max(0, Math.floor(childStartedAtMs));
  const rootObservedByMs = Math.max(rootNotBeforeMs, Math.ceil(childObservedAtMs) + 1);
  return [
    "$ErrorActionPreference='Stop'",
    `$NativeSource='${WINDOWS_PROCESS_TERMINATOR_SOURCE}'`,
    "Add-Type -TypeDefinition $NativeSource",
    `$RootProcessId=${pid}`,
    `$RootExpectedAlive=$${rootExpectedAlive ? "true" : "false"}`,
    `$RootNotBefore=[DateTimeOffset]::FromUnixTimeMilliseconds(${rootNotBeforeMs}).UtcDateTime`,
    `$RootObservedBy=[DateTimeOffset]::FromUnixTimeMilliseconds(${rootObservedByMs}).UtcDateTime`,
    "$AllProcesses=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)",
    "$Snapshot=[System.Collections.Generic.List[object]]::new()",
    "$Pending=[System.Collections.Generic.Queue[object]]::new()",
    "$Visited=[System.Collections.Generic.HashSet[string]]::new()",
    "$RootProcess=$AllProcesses | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1",
    "$RootCreated=if($null -ne $RootProcess){([datetime]$RootProcess.CreationDate).ToUniversalTime()}else{$null}",
    "$RootMatches=$null -ne $RootProcess -and $RootCreated -ge $RootNotBefore -and $RootCreated -le $RootObservedBy",
    "$KillRoot=$RootExpectedAlive -and $RootMatches",
    "$CleanupFailed=$RootExpectedAlive -and !$RootMatches",
    "if($KillRoot){",
    "$Snapshot.Add($RootProcess)",
    '$Visited.Add("$([int]$RootProcess.ProcessId)|$(([datetime]$RootProcess.CreationDate).ToFileTimeUtc())") | Out-Null',
    "$Pending.Enqueue($RootProcess)",
    "}",
    "while($Pending.Count -gt 0){",
    "$Parent=$Pending.Dequeue()",
    "foreach($Process in @($AllProcesses | Where-Object { [int]$_.ParentProcessId -eq [int]$Parent.ProcessId })){",
    "$ChildCreated=([datetime]$Process.CreationDate).ToUniversalTime()",
    "$ParentCreated=([datetime]$Parent.CreationDate).ToUniversalTime()",
    "if($ChildCreated -lt $ParentCreated){continue}",
    '$Identity="$([int]$Process.ProcessId)|$($ChildCreated.ToFileTimeUtc())"',
    "if(!$Visited.Add($Identity)){continue}",
    "$Snapshot.Add($Process)",
    "$Pending.Enqueue($Process)",
    "}",
    "}",
    "if($KillRoot){",
    "$Entries=@($Snapshot)",
    "[array]::Reverse($Entries)",
    "foreach($Entry in $Entries){",
    "$CreationTime=([datetime]$Entry.CreationDate).ToFileTimeUtc()",
    "if(![CrablineProcessTerminator]::TerminateVerified([int]$Entry.ProcessId,$CreationTime)){$CleanupFailed=$true}",
    "}",
    "}",
    "if($CleanupFailed){exit 1}",
  ].join(";");
}

function destroyChildPipes(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Pipe teardown is best effort after process-tree termination.
    }
  }
}

function isChildRunning(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  try {
    return child.kill(0);
  } catch {
    return false;
  }
}

async function terminateChild(
  child: ChildProcess,
  childStartedAtMs: number,
  childObservedAtMs: number,
): Promise<void> {
  try {
    const childRunning = isChildRunning(child);
    if (process.platform === "win32") {
      if (child.pid) {
        const treeTerminated = await runTerminationCommand("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsProcessTreeTermination(
            child.pid,
            childStartedAtMs,
            childObservedAtMs,
            childRunning,
          ),
        ]);
        if (!treeTerminated && isChildRunning(child)) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Closing the helper handle is the bounded fallback for its Job Object.
          }
        }
      }
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group may have exited with the shell.
      }
    }

    if (isChildRunning(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited while its descendants retained the pipes.
      }
    }
  } finally {
    destroyChildPipes(child);
  }
}

async function waitForChildClose(
  childClosed: Promise<ScriptChildExit>,
): Promise<ScriptChildExit | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    childClosed,
    new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), CHILD_CLOSE_TIMEOUT_MS);
      timeout.unref();
    }),
  ]);
  clearTimeout(timeout);
  return exit;
}

function waitForChildCloseOrAbort(
  childClosed: Promise<ScriptChildExit>,
  signals: Array<AbortSignal | undefined>,
): Promise<ScriptChildExit | undefined> {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.some((signal) => signal.aborted)) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let settled = false;
    const abort = () => finish(undefined);
    const finish = (exit: ScriptChildExit | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const signal of activeSignals) {
        signal.removeEventListener("abort", abort);
      }
      resolve(exit);
    };
    for (const signal of activeSignals) {
      signal.addEventListener("abort", abort, { once: true });
    }
    void childClosed.then((exit) => finish(exit));
  });
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "result"}: ${issue.message}`)
    .join("; ");
}

const sensitiveEnvironmentNameFragmentPattern =
  /(?:AUTH|BEARER|CREDENTIAL|JWT|KEY|PASS|PRIVATE|SECRET|TOKEN)/iu;
const nonSensitiveWorkingDirectoryNames = new Set(["PWD", "OLDPWD"]);

function isSensitiveEnvironmentName(name: string): boolean {
  const upperName = name.toUpperCase();
  return (
    sensitiveEnvironmentNameFragmentPattern.test(upperName) ||
    (!nonSensitiveWorkingDirectoryNames.has(upperName) && upperName.includes("PWD")) ||
    /PAT(?!H)/u.test(upperName)
  );
}

function redactCredentialSyntax(detail: string): string {
  let redacted = detail.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/giu,
    "$1[redacted credentials]@",
  );
  redacted = redacted.replace(
    /(\bauthorization\b["']?\s*[:=]\s*["']?\s*)(?:(basic|bearer)\s+)?([^\s"',;}]+)/giu,
    (_match, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme ? `${scheme} ` : ""}[redacted credential]`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(\+?=|:)\s*("[^"]*"|'[^']*'|[^,;}\]\r\n]+)/gu,
    (match, name: string, operator: string) =>
      name.toLowerCase() !== "authorization" && isSensitiveEnvironmentName(name)
        ? `${name}${operator}[redacted credential]`
        : match,
  );
  return redacted.replace(
    /--([A-Za-z0-9][A-Za-z0-9_-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gu,
    (match, name: string, separator: string) =>
      isSensitiveEnvironmentName(name.replaceAll("-", "_"))
        ? `--${name}${separator}[redacted credential]`
        : match,
  );
}

function commandContainsSensitiveValue(command: string): boolean {
  if (redactCredentialSyntax(command) !== command) {
    return true;
  }
  const assignments = [
    ...command.matchAll(/(?:^|[\s;&|])["']?([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/gu),
    ...command.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/giu),
    ...command.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}\s*\+?=/giu),
  ];
  if (assignments.some((match) => isSensitiveEnvironmentName(match[1] ?? ""))) {
    return true;
  }
  return [...command.matchAll(/(?:^|[\s;&|])["']?--([A-Za-z0-9][A-Za-z0-9_-]*)(?:=|\s)/gu)].some(
    (match) => isSensitiveEnvironmentName((match[1] ?? "").replaceAll("-", "_")),
  );
}

function addRedactionRepresentations(values: Set<string>, value: string): void {
  if (!value) {
    return;
  }
  values.add(value);
  const serialized = JSON.stringify(value);
  values.add(serialized);
  values.add(serialized.slice(1, -1));
}

function addCommandValueRedactions(substringValues: Set<string>, value: string): void {
  addRedactionRepresentations(substringValues, value);
}

function tokenizeLiteralCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\n" || character === "\r") {
      return undefined;
    }
    if (process.platform === "win32" && character === "\\" && command[index + 1] === '"') {
      return undefined;
    }
    if (process.platform === "win32" && character === '"' && command[index + 1] === '"') {
      return undefined;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && /[$`%!]/u.test(character)) {
        return undefined;
      }
      if (character === "\\" && quote === '"' && process.platform !== "win32") {
        return undefined;
      }
      current += character;
      continue;
    }
    if (character === '"' || (character === "'" && process.platform !== "win32")) {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (
      /[;&|<>(){}$`%!*?[\]~]/u.test(character) ||
      (process.platform === "win32" && character === "^")
    ) {
      return undefined;
    }
    if (character === "\\") {
      if (process.platform !== "win32") {
        return undefined;
      }
    }
    current += character;
  }
  if (quote) {
    return undefined;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function snapshotCommandValues(
  command: string,
): { exactValues: string[]; substringValues: string[] } | undefined {
  const tokens = tokenizeLiteralCommand(command);
  if (!tokens) {
    return undefined;
  }
  const exactValues = new Set<string>();
  const substringValues = new Set<string>();
  let executableSeen = false;
  for (const token of tokens) {
    if (!executableSeen) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/u.exec(token);
      if (assignment) {
        addCommandValueRedactions(substringValues, assignment[2] ?? "");
        continue;
      }
      executableSeen = true;
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(token)) {
      const value = token.slice(2);
      if (value.length < 3) {
        return undefined;
      }
      addRedactionRepresentations(exactValues, token);
      addCommandValueRedactions(substringValues, value);
      continue;
    }
    if (/^-[A-Za-z0-9][A-Za-z0-9_-]+$/u.test(token)) {
      const value = token.slice(2);
      if (value.length < 3) {
        return undefined;
      }
      addRedactionRepresentations(exactValues, token);
      addCommandValueRedactions(substringValues, token.slice(1));
      addCommandValueRedactions(substringValues, value);
      continue;
    }
    const option = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.*)$/u.exec(token);
    if (option) {
      const value = option[1] ?? "";
      if (value.length < 3) {
        return undefined;
      }
      addCommandValueRedactions(substringValues, value);
      continue;
    }
    if (process.platform === "win32" && token.startsWith("/")) {
      const slashOption = /^\/[A-Za-z0-9][A-Za-z0-9_-]*[:=](.*)$/u.exec(token);
      const value = slashOption?.[1] ?? "";
      if (value.length < 3) {
        return undefined;
      }
      addCommandValueRedactions(substringValues, value);
      continue;
    }
    if (token.length < 3) {
      return undefined;
    }
    if (token.startsWith("-")) {
      return undefined;
    } else {
      addRedactionRepresentations(substringValues, token);
    }
  }
  return {
    exactValues: [...exactValues].sort((left, right) => right.length - left.length),
    substringValues: [...substringValues].sort((left, right) => right.length - left.length),
  };
}

function snapshotSensitiveEnvironmentValues(): string[] {
  const representations = new Set<string>();
  const values = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        isSensitiveEnvironmentName(name) && value !== undefined && value.length > 0,
    )
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    addRedactionRepresentations(representations, value);
  }
  return [...representations].sort((left, right) => right.length - left.length);
}

function collectSensitivePayloadValues(
  value: unknown,
  values: Set<string>,
  seen: { nonSensitive: WeakSet<object>; sensitive: WeakSet<object> },
  sensitive = false,
): void {
  if (typeof value === "string") {
    if (sensitive && value.length > 0) {
      values.add(value);
      const serialized = JSON.stringify(value);
      values.add(serialized);
      values.add(serialized.slice(1, -1));
    }
    return;
  }
  if (sensitive && typeof value === "number" && Number.isFinite(value)) {
    values.add(String(value));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const visited = sensitive ? seen.sensitive : seen.nonSensitive;
  if (visited.has(value)) {
    return;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSensitivePayloadValues(entry, values, seen, sensitive);
    }
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    collectSensitivePayloadValues(
      entry,
      values,
      seen,
      sensitive || isSensitiveEnvironmentName(name),
    );
  }
}

function snapshotSensitivePayloadValues(payload: unknown): string[] {
  const values = new Set<string>();
  collectSensitivePayloadValues(payload, values, {
    nonSensitive: new WeakSet(),
    sensitive: new WeakSet(),
  });
  return [...values].sort((left, right) => right.length - left.length);
}

function isExactCommandValueBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s"'`=,:;.()[\]{}<>!?]/u.test(character);
}

type DiagnosticRedactionSpan = {
  end: number;
  label: string;
  priority: number;
  sourceLength: number;
  start: number;
};

function collectDiagnosticRedactionSpans(
  detail: string,
  values: string[],
  label: string,
  priority: number,
  exact = false,
): DiagnosticRedactionSpan[] {
  const spans: DiagnosticRedactionSpan[] = [];
  for (const value of values) {
    let cursor = 0;
    while (cursor < detail.length) {
      const start = detail.indexOf(value, cursor);
      if (start < 0) {
        break;
      }
      const end = start + value.length;
      if (
        !exact ||
        (isExactCommandValueBoundary(detail[start - 1]) && isExactCommandValueBoundary(detail[end]))
      ) {
        spans.push({ end, label, priority, sourceLength: value.length, start });
      }
      cursor = end;
    }
  }
  return spans;
}

function redactDiagnosticValues(detail: string, diagnostics: ScriptDiagnosticsSnapshot): string {
  const spans = [
    ...collectDiagnosticRedactionSpans(
      detail,
      diagnostics.sensitiveEnvironmentValues,
      "[redacted environment value]",
      4,
    ),
    ...collectDiagnosticRedactionSpans(
      detail,
      diagnostics.configuredCommands,
      "[configured script command]",
      3,
    ),
    ...collectDiagnosticRedactionSpans(
      detail,
      diagnostics.commandValues,
      "[redacted command value]",
      3,
    ),
    ...collectDiagnosticRedactionSpans(
      detail,
      diagnostics.exactCommandValues,
      "[redacted command value]",
      3,
      true,
    ),
    ...collectDiagnosticRedactionSpans(
      detail,
      diagnostics.sensitivePayloadValues,
      "[redacted configured value]",
      2,
    ),
  ].sort(
    (left, right) =>
      left.start - right.start || right.end - left.end || right.priority - left.priority,
  );
  const merged: DiagnosticRedactionSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
    if (
      span.sourceLength > previous.sourceLength ||
      (span.sourceLength === previous.sourceLength && span.priority > previous.priority)
    ) {
      previous.label = span.label;
      previous.priority = span.priority;
      previous.sourceLength = span.sourceLength;
    }
  }
  let redacted = detail;
  for (const span of merged.toReversed()) {
    redacted = redacted.slice(0, span.start) + span.label + redacted.slice(span.end);
  }
  return redacted;
}

function formatScriptError(
  summary: string,
  detail: string,
  command: string,
  diagnostics: ScriptDiagnosticsSnapshot,
): string {
  if (!detail.trim()) {
    return summary;
  }
  if (!diagnostics.diagnosticsSafe || commandContainsSensitiveValue(command)) {
    return `${summary}\n[script diagnostics redacted]`;
  }
  let redacted = redactDiagnosticValues(detail, diagnostics);
  redacted = redactCredentialSyntax(redacted);
  redacted = redacted.trim();
  return redacted ? `${summary}\n${redacted}` : summary;
}

function usesSupportedDiagnosticShell(shell?: string | undefined): boolean {
  if (shell !== undefined) {
    return false;
  }
  if (process.platform !== "win32") {
    return true;
  }
  const comspec = process.env.ComSpec ?? process.env.COMSPEC;
  return comspec === undefined || /(?:^|[\\/])cmd(?:\.exe)?$/iu.test(comspec);
}

function createScriptDiagnosticsSnapshot(
  command: string,
  serializedPayload: string,
  shell?: string | undefined,
): ScriptDiagnosticsSnapshot {
  const payload = JSON.parse(serializedPayload) as unknown;
  const configuredCommands = new Set([command]);
  const commands = (
    payload as {
      provider?: { config?: { script?: { commands?: Record<string, unknown> } } };
    }
  ).provider?.config?.script?.commands;
  for (const configuredCommand of Object.values(commands ?? {})) {
    if (typeof configuredCommand === "string" && configuredCommand.length > 0) {
      configuredCommands.add(configuredCommand);
    }
  }
  const commandValues = new Set<string>();
  const exactCommandValues = new Set<string>();
  let diagnosticsSafe = usesSupportedDiagnosticShell(shell);
  for (const configuredCommand of configuredCommands) {
    if (commandContainsSensitiveValue(configuredCommand)) {
      diagnosticsSafe = false;
    }
    const values = snapshotCommandValues(configuredCommand);
    if (!values) {
      diagnosticsSafe = false;
      continue;
    }
    for (const value of values.substringValues) {
      commandValues.add(value);
    }
    for (const value of values.exactValues) {
      exactCommandValues.add(value);
    }
  }
  return {
    commandValues: [...commandValues].sort((left, right) => right.length - left.length),
    configuredCommands: [...configuredCommands].sort((left, right) => right.length - left.length),
    diagnosticsSafe,
    exactCommandValues: [...exactCommandValues].sort((left, right) => right.length - left.length),
    sensitiveEnvironmentValues: snapshotSensitiveEnvironmentValues(),
    sensitivePayloadValues: snapshotSensitivePayloadValues(payload),
  };
}

function parseScriptJson<T>(params: {
  command: string;
  diagnostics: ScriptDiagnosticsSnapshot;
  output: string;
  schema: z.ZodType<T>;
}): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.output);
  } catch (error) {
    throw new CrablineError(
      formatScriptError(
        "Script command did not return valid JSON.",
        ensureErrorMessage(error),
        params.command,
        params.diagnostics,
      ),
      { kind: "config" },
    );
  }

  const result = params.schema.safeParse(parsed);
  if (!result.success) {
    throw new CrablineError(
      `Script command returned invalid result.\n${formatValidationError(result.error)}`,
      { kind: "config" },
    );
  }
  return result.data;
}

function runScript<T>(params: {
  acceptResultDuringTimeoutGrace?: ((result: T) => boolean) | undefined;
  command: string;
  cwd?: string | undefined;
  payload: unknown;
  schema: z.ZodType<T>;
  shell?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutGraceMs?: number | undefined;
  timeoutMs: number;
}): Promise<T> {
  if (params.signal?.aborted) {
    return Promise.reject(params.signal.reason ?? new Error("Script command aborted."));
  }
  const serializedPayload = JSON.stringify(params.payload);
  const diagnostics = createScriptDiagnosticsSnapshot(
    params.command,
    serializedPayload,
    params.shell,
  );
  return new Promise((resolve, reject) => {
    let child: SpawnedScriptChild;
    let childStartedAtMs: number;
    let childObservedAtMs: number;
    try {
      ({
        child,
        observedAtMs: childObservedAtMs,
        startedAtMs: childStartedAtMs,
      } = spawnScriptChild(params));
    } catch (error) {
      reject(
        new CrablineError(
          formatScriptError(
            "Script command failed to start.",
            ensureErrorMessage(error),
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let deadlineExceeded = false;
    let outputBytes = 0;
    let settled = false;
    let timeoutGrace: NodeJS.Timeout | undefined;
    const abort = () => {
      finish(async () => {
        await terminateChild(child, childStartedAtMs, childObservedAtMs);
        reject(params.signal?.reason ?? new Error("Script command aborted."));
      });
    };

    const finish = (callback: () => Promise<void> | void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(timeoutGrace);
      params.signal?.removeEventListener("abort", abort);
      void callback();
    };

    const failForOutputLimit = () => {
      finish(async () => {
        await terminateChild(child, childStartedAtMs, childObservedAtMs);
        reject(
          new CrablineError(`Script command exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes of output.`, {
            kind: "connectivity",
          }),
        );
      });
    };

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        failForOutputLimit();
        return;
      }
      stdout.push(buffer);
    });

    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        failForOutputLimit();
        return;
      }
      stderr.push(buffer);
    });

    child.stdin.on("error", () => {
      // Child closure is reported through the process error/close handlers.
    });
    child.once("error", (error) => {
      finish(() => {
        reject(
          new CrablineError(
            formatScriptError(
              "Script command failed to start.",
              ensureErrorMessage(error),
              params.command,
              diagnostics,
            ),
            { kind: "connectivity" },
          ),
        );
      });
    });
    child.once("close", (code, signal) => {
      finish(() => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          reject(
            new CrablineError(
              formatScriptError(
                `Script command failed${signal ? ` (${signal})` : ""}.`,
                stderrText.trim() ? stderrText : stdoutText,
                params.command,
                diagnostics,
              ),
              { kind: "connectivity" },
            ),
          );
          return;
        }

        try {
          const result = parseScriptJson({
            command: params.command,
            diagnostics,
            output: stdoutText,
            schema: params.schema,
          });
          if (deadlineExceeded && !params.acceptResultDuringTimeoutGrace?.(result)) {
            reject(
              new CrablineError(`Script command timed out after ${params.timeoutMs}ms.`, {
                kind: "timeout",
              }),
            );
            return;
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    const failForTimeout = () => {
      finish(async () => {
        await terminateChild(child, childStartedAtMs, childObservedAtMs);
        reject(
          new CrablineError(`Script command timed out after ${params.timeoutMs}ms.`, {
            kind: "timeout",
          }),
        );
      });
    };
    const timeout = setTimeout(() => {
      const timeoutGraceMs = params.timeoutGraceMs ?? 0;
      if (timeoutGraceMs <= 0) {
        failForTimeout();
        return;
      }
      deadlineExceeded = true;
      timeoutGrace = setTimeout(failForTimeout, timeoutGraceMs);
      timeoutGrace.unref();
    }, params.timeoutMs);
    timeout.unref();

    if (params.signal?.aborted) {
      abort();
      return;
    }
    params.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(serializedPayload);
  });
}

function watchScript(params: {
  cancelSignal: AbortSignal;
  command: string;
  context: WatchContext;
  cwd?: string | undefined;
  id: string;
  normalizeTarget: ProviderAdapter["normalizeTarget"];
  shell?: string | undefined;
}): AsyncGenerator<InboundEnvelope> {
  return (async function* () {
    if (params.cancelSignal.aborted) {
      return;
    }
    if (params.context.signal?.aborted) {
      throw params.context.signal.reason ?? new Error("Script watch command aborted.");
    }
    const payload = {
      ...createPayload(params.context),
      watch: {
        since: params.context.since,
        target: params.normalizeTarget(params.context.fixture.target),
      },
    };
    const serializedPayload = JSON.stringify(payload);
    const diagnostics = createScriptDiagnosticsSnapshot(
      params.command,
      serializedPayload,
      params.shell,
    );
    let child: SpawnedScriptChild;
    let childStartedAtMs: number;
    let childObservedAtMs: number;
    try {
      ({
        child,
        observedAtMs: childObservedAtMs,
        startedAtMs: childStartedAtMs,
      } = spawnScriptChild(params));
    } catch (error) {
      throw new CrablineError(
        formatScriptError(
          "Script watch command failed to start.",
          ensureErrorMessage(error),
          params.command,
          diagnostics,
        ),
        { kind: "connectivity" },
      );
    }

    let buffer = "";
    let stderr = "";
    let childError: unknown;
    let outputLimitError: CrablineError | undefined;
    let termination: Promise<void> | undefined;
    const stopChild = () => {
      termination ??= terminateChild(child, childStartedAtMs, childObservedAtMs);
      return termination;
    };
    const requestStopChild = () => {
      void stopChild();
    };
    params.cancelSignal.addEventListener("abort", requestStopChild, { once: true });
    params.context.signal?.addEventListener("abort", requestStopChild, { once: true });
    if (params.cancelSignal.aborted || params.context.signal?.aborted) {
      requestStopChild();
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {
      // Child closure is reported through the process error/close handlers.
    });
    child.stderr.on("data", (chunk) => {
      if (outputLimitError) {
        return;
      }
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_SCRIPT_OUTPUT_BYTES) {
        outputLimitError = new CrablineError(
          `Script watch command exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes of stderr.`,
          { kind: "connectivity" },
        );
        requestStopChild();
      }
    });
    child.once("error", (error) => {
      childError = error;
    });
    let childCloseObserved = false;
    const childClosed = new Promise<ScriptChildExit>((resolve) => {
      child.once("close", (code, signal) => {
        childCloseObserved = true;
        resolve({ code, signal });
      });
    });
    child.stdin.end(serializedPayload);

    try {
      for await (const chunk of child.stdout) {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_SCRIPT_OUTPUT_BYTES && !buffer.includes("\n")) {
          throw new CrablineError(
            `Script watch command exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes without a newline.`,
            { kind: "config" },
          );
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          if (Buffer.byteLength(line) > MAX_SCRIPT_OUTPUT_BYTES) {
            throw new CrablineError(
              `Script watch command emitted a JSON line larger than ${MAX_SCRIPT_OUTPUT_BYTES} bytes.`,
              { kind: "config" },
            );
          }
          const parsed = parseScriptJson({
            command: params.command,
            diagnostics,
            output: line,
            schema: ScriptMessageSchema,
          });
          yield {
            ...parsed,
            provider: params.id,
          };
        }
      }

      if (params.context.signal?.aborted) {
        throw params.context.signal.reason ?? new Error("Script watch command aborted.");
      }
      if (params.cancelSignal.aborted) {
        return;
      }
      if (buffer.trim()) {
        const parsed = parseScriptJson({
          command: params.command,
          diagnostics,
          output: buffer,
          schema: ScriptMessageSchema,
        });
        yield {
          ...parsed,
          provider: params.id,
        };
      }

      if (outputLimitError) {
        await stopChild();
        await waitForChildClose(childClosed);
        throw outputLimitError;
      }
      if (childError) {
        await waitForChildClose(childClosed);
        throw new CrablineError(
          formatScriptError(
            "Script watch command failed to start.",
            ensureErrorMessage(childError),
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        );
      }
      const exit = await waitForChildCloseOrAbort(childClosed, [
        params.cancelSignal,
        params.context.signal,
      ]);
      if (!exit) {
        await stopChild();
        if (params.cancelSignal.aborted) {
          return;
        }
        if (params.context.signal?.aborted) {
          throw params.context.signal.reason ?? new Error("Script watch command aborted.");
        }
        return;
      }
      if (exit.code !== 0) {
        throw new CrablineError(
          formatScriptError(
            `Script watch command failed${exit.signal ? ` (${exit.signal})` : ""}.`,
            stderr,
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        );
      }
    } catch (error) {
      if (params.cancelSignal.aborted) {
        return;
      }
      if (outputLimitError) {
        throw outputLimitError;
      }
      if (childError) {
        throw new CrablineError(
          formatScriptError(
            "Script watch command failed to start.",
            ensureErrorMessage(childError),
            params.command,
            diagnostics,
          ),
          { kind: "connectivity" },
        );
      }
      throw error;
    } finally {
      params.cancelSignal.removeEventListener("abort", requestStopChild);
      params.context.signal?.removeEventListener("abort", requestStopChild);
      child.stdin.destroy();
      if (!childCloseObserved) {
        await stopChild();
      }
      await waitForChildClose(childClosed);
    }
  })();
}

function failedScriptWatch(error: unknown): ScriptWatchIterator {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return Promise.reject(error);
    },
    return() {
      return Promise.resolve({ done: true, value: undefined });
    },
    throw(thrown?: unknown) {
      return Promise.reject(thrown);
    },
  };
}

export class ScriptProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status = "bridge" as const;
  readonly supports;
  readonly #config;

  constructor(context: ProviderContext) {
    if (!context.config.script) {
      throw new CrablineError(`Provider "${context.providerId}" is missing script configuration.`, {
        kind: "config",
      });
    }

    this.id = context.providerId;
    this.platform = context.config.platform;
    this.supports = [...context.config.capabilities];
    this.#config = context.config.script;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]) {
    const normalized = {
      id: target.id,
      metadata: target.metadata,
    } as ReturnType<ProviderAdapter["normalizeTarget"]>;
    if (target.channelId) {
      normalized.channelId = target.channelId;
    }
    if (target.threadId) {
      normalized.threadId = target.threadId;
    }
    return normalized;
  }

  async probe(context: ProviderContext) {
    const command = this.#config.commands.probe;
    if (!command) {
      return {
        details: ["probe command not configured"],
        healthy: false,
      };
    }

    const result = await runScript({
      command,
      cwd: this.#config.cwd,
      payload: createPayload(context),
      schema: ScriptProbeResultSchema,
      shell: this.#config.shell,
      signal: context.signal,
      timeoutMs: context.fixture.timeoutMs,
    });
    return {
      details: result.details ?? [],
      healthy: result.healthy,
    };
  }

  async send(context: SendContext) {
    const command = this.#config.commands.send;
    if (!command) {
      throw new CrablineError(`Provider "${this.id}" is missing send command.`, {
        kind: "config",
      });
    }

    return runScript({
      command,
      cwd: this.#config.cwd,
      payload: {
        ...createPayload(context),
        outbound: {
          mode: context.mode,
          nonce: context.nonce,
          target: this.normalizeTarget(context.fixture.target),
          text: context.text,
        },
      },
      schema: ScriptSendResultSchema,
      shell: this.#config.shell,
      signal: context.signal,
      timeoutMs: context.fixture.timeoutMs,
    });
  }

  async waitForInbound(context: WaitContext) {
    const command = this.#config.commands.waitForInbound;
    if (!command) {
      return null;
    }

    const result = await runScript({
      acceptResultDuringTimeoutGrace: (candidate) => candidate.timeout === true,
      command,
      cwd: this.#config.cwd,
      payload: {
        ...createPayload(context),
        wait: {
          excludeIds: context.excludeIds ?? [],
          nonce: context.nonce,
          since: context.since,
          target: this.normalizeTarget(context.fixture.target),
          threadId: context.threadId,
          timeoutMs: context.timeoutMs,
        },
      },
      schema: ScriptInboundResultSchema,
      shell: this.#config.shell,
      signal: context.signal,
      timeoutGraceMs: SCRIPT_WAIT_EXIT_GRACE_MS,
      timeoutMs: context.timeoutMs,
    });

    if (result.timeout || !result.message) {
      return null;
    }

    return {
      ...result.message,
      provider: this.id,
    };
  }

  watch(context: WatchContext): ScriptWatchIterator {
    const command = this.#config.commands.watch;
    if (!command) {
      return failedScriptWatch(
        new CrablineError(`Provider "${this.id}" is missing watch command.`, {
          kind: "config",
        }),
      );
    }

    const controller = new AbortController();
    const source = watchScript({
      cancelSignal: controller.signal,
      command,
      context,
      cwd: this.#config.cwd,
      id: this.id,
      normalizeTarget: (target) => this.normalizeTarget(target),
      shell: this.#config.shell,
    });
    const iterator: ScriptWatchIterator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return source.next();
      },
      async return() {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        await source.return(undefined);
        return { done: true, value: undefined };
      },
      async throw(error?: unknown) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        await source.return(undefined);
        throw error;
      },
    };
    return iterator;
  }
}

function createPayload(context: ProviderContext): ScriptPayload {
  return {
    fixture: context.fixture,
    provider: {
      config: context.config,
      id: context.providerId,
      manifestPath: context.manifestPath,
    },
  };
}
