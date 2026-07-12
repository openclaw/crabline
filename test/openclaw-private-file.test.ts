import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyOwnerOnlyWindowsAcl,
  publishPrivateFileAtomically,
  type WindowsAclRunner,
} from "../src/openclaw/private-file.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

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
