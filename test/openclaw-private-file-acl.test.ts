import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishPrivateFileAtomically,
  removeSecuredPrivateDirectory,
  securePrivateDirectory,
} from "../src/openclaw/private-file.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const { inspectCommand } = vi.hoisted(() => ({ inspectCommand: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  return {
    ...actual,
    execFile: Object.assign(
      (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args),
      {
        [promisify.custom]: async (...args: Parameters<typeof run>) =>
          (await inspectCommand(...args)) ?? (await run(...args)),
      },
    ),
  };
});

function directoryAcl(directory: string): string[] {
  return execFileSync("/bin/ls", ["-lde", "."], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  })
    .split("\n")
    .slice(1)
    .filter(Boolean);
}

async function directoryState(directory: string) {
  const { dev, ino, mode, uid } = await fs.lstat(directory);
  return { acl: directoryAcl(directory), dev, ino, mode, uid };
}

describe.skipIf(process.platform !== "darwin")("macOS private ancestry ACLs", () => {
  afterEach(() => inspectCommand.mockReset());

  it.each([
    { mode: 0o755, inherited: false, acl: true, xattr: false },
    { mode: 0o755, inherited: true, acl: true, xattr: true },
    { mode: 0o1777, inherited: false, acl: true, xattr: false },
    { mode: 0o755, inherited: false, acl: false, xattr: true },
  ])(
    "preserves safe ancestry ($mode, ACL=$acl, inherited=$inherited, xattr=$xattr) across all mutations",
    async ({ mode, inherited, acl, xattr }) => {
      const root = await createTempDir();
      const ancestor = path.join(root, "ancestor\n 0: group:everyone allow add_file");
      await fs.mkdir(ancestor);
      try {
        await fs.chmod(ancestor, mode);
        if (acl) {
          execFileSync("/bin/chmod", [
            inherited ? "+ai" : "+a",
            "group:everyone deny delete",
            ancestor,
          ]);
          execFileSync("/bin/chmod", ["+a", "group:staff deny chown", ancestor]);
        }
        if (xattr) {
          execFileSync("/usr/bin/xattr", ["-w", "com.crabline.acl-test", "fixture", ancestor]);
        }
        const before = await directoryState(ancestor);
        const existing = path.join(ancestor, "existing");
        const nested = path.join(ancestor, "nested", "deep");
        await fs.mkdir(existing, { mode: 0o700 });
        for (const directory of [existing, nested]) {
          const file = path.join(directory, "private.json");
          await publishPrivateFileAtomically(file, "private\n");
          expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
          expect(
            execFileSync("/bin/ls", ["-lde", "private.json"], { cwd: directory, encoding: "utf8" })
              .split("\n")
              .filter(Boolean),
          ).toHaveLength(1);
          expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
          expect(directoryAcl(directory)).toEqual([]);
          await removeSecuredPrivateDirectory(await securePrivateDirectory(directory));
          await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(directoryAcl(path.dirname(nested))).toEqual([]);
        expect((await fs.stat(path.dirname(nested))).mode & 0o777).toBe(0o700);
        const direct = await securePrivateDirectory(path.join(ancestor, "direct"));
        expect(directoryAcl(direct.directoryPath)).toEqual([]);
        await removeSecuredPrivateDirectory(direct);
        expect(await directoryState(ancestor)).toEqual(before);
      } finally {
        execFileSync("/bin/chmod", ["-N", ancestor]);
        await disposeTempDir(root);
      }
    },
  );

  it("rejects an allowing ACL even when extended attributes hide the plus marker", async () => {
    const root = await createTempDir();
    const ancestor = path.join(root, "ancestor\n 0: group:everyone deny delete");
    await fs.mkdir(ancestor, { mode: 0o700 });
    try {
      execFileSync("/bin/chmod", ["+a", "everyone allow add_file", ancestor]);
      execFileSync("/usr/bin/xattr", ["-w", "com.crabline.acl-test", "fixture", ancestor]);
      const before = await directoryState(ancestor);
      await expect(securePrivateDirectory(path.join(ancestor, "private"))).rejects.toThrow(
        /macOS.*ACL/u,
      );
      await expect(fs.readdir(ancestor)).resolves.toEqual([]);
      expect(await directoryState(ancestor)).toEqual(before);
    } finally {
      execFileSync("/bin/chmod", ["-N", ancestor]);
      await disposeTempDir(root);
    }
  });

  it.each([0o777, 0o770])(
    "does not use deny entries to excuse writable POSIX mode %i",
    async (mode) => {
      const ancestor = await createTempDir();
      try {
        await fs.chmod(ancestor, mode);
        execFileSync("/bin/chmod", ["+a", "everyone deny delete", ancestor]);
        const before = await directoryState(ancestor);
        await expect(
          publishPrivateFileAtomically(path.join(ancestor, "nested", "private.json"), "private"),
        ).rejects.toThrow("writable by another POSIX principal");
        expect(await directoryState(ancestor)).toEqual(before);
      } finally {
        execFileSync("/bin/chmod", ["-N", ancestor]);
        await disposeTempDir(ancestor);
      }
    },
  );

  it("preserves actual permission failures from a restrictive ancestor", async () => {
    const ancestor = await createTempDir();
    try {
      execFileSync("/bin/chmod", ["+a", "everyone deny add_subdirectory", ancestor]);
      const before = await directoryState(ancestor);
      const failure = await securePrivateDirectory(path.join(ancestor, "private")).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: expect.stringMatching(/^(?:EACCES|EPERM)$/u) });
      expect(await directoryState(ancestor)).toEqual(before);
    } finally {
      execFileSync("/bin/chmod", ["-N", ancestor]);
      await disposeTempDir(ancestor);
    }
  });

  const header = "drwx------  2 owner group 64 Aug 27 12:00 .\n";
  const aclHeader = header.replace("------ ", "------+ ");
  it.each([
    ["empty", ""],
    ["non-directory", header.replace(/^d/u, "-")],
    ["control character", header.replace("owner", "own\0er")],
    ["missing entries", aclHeader],
    ["missing marker", `${header} 0: group:everyone deny delete\n`],
    ["truncated", `${aclHeader} 0: group:everyone deny`],
    ["unknown right", `${aclHeader} 0: group:everyone deny future_right\n`],
    ["unknown flag", `${aclHeader} 0: group:everyone future_flag deny delete\n`],
    ["skipped index", `${aclHeader} 1: group:everyone deny delete\n`],
    [
      "duplicate index",
      `${aclHeader} 0: group:everyone deny delete\n 0: group:staff deny delete\n`,
    ],
    ["trailing garbage", `${aclHeader} 0: group:everyone deny delete\nunrecognized\n`],
    ["missing principal", `${aclHeader} 0: deny delete\n`],
    ["wrong header name", header.replace(" .\n", " something\n")],
    ["command warning", header],
    ["command failure", header],
  ])("fails closed for %s inspection output before creation", async (label, stdout) => {
    const directory = await createTempDir();
    try {
      inspectCommand.mockImplementation((command: string) => {
        if (command !== "/bin/ls") {
          return undefined;
        }
        if (label === "command failure") {
          throw new Error("inspection unavailable");
        }
        return { stdout, stderr: label === "command warning" ? "ls: ACL unavailable" : "" };
      });
      await expect(securePrivateDirectory(path.join(directory, "private"))).rejects.toThrow(
        /macOS.*ACL/u,
      );
      await expect(fs.readdir(directory)).resolves.toEqual([]);
    } finally {
      await disposeTempDir(directory);
    }
  });

  it("rejects replacement of the inspected ancestor before capturing its identity", async () => {
    const root = await createTempDir();
    const ancestor = path.join(root, "ancestor");
    const displaced = path.join(root, "displaced");
    await fs.mkdir(ancestor, { mode: 0o700 });
    let replaced = false;
    try {
      inspectCommand.mockImplementation(
        async (command: string, args: string[], options: { cwd?: string }) => {
          if (
            command !== "/bin/ls" ||
            replaced ||
            (options.cwd !== ancestor && !args.includes(ancestor))
          ) {
            return undefined;
          }
          replaced = true;
          await fs.rename(ancestor, displaced);
          await fs.mkdir(ancestor, { mode: 0o777 });
          await fs.chmod(ancestor, 0o777);
          return { stdout: header, stderr: "" };
        },
      );
      await expect(
        publishPrivateFileAtomically(path.join(ancestor, "nested", "private.json"), "private"),
      ).rejects.toThrow(/identity changed/u);
      expect(replaced).toBe(true);
      await expect(fs.readdir(ancestor)).resolves.toEqual([]);
    } finally {
      await disposeTempDir(root);
    }
  });
});
