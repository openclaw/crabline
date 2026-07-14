import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("autoreview tooling", () => {
  it("requires Python 3.10 across every launcher", async () => {
    const [runner, shellLauncher, powershellLauncher, harness] = await Promise.all([
      fs.readFile("tools/run-autoreview-tests.mjs", "utf8"),
      fs.readFile(".agents/skills/autoreview/scripts/test-review-harness", "utf8"),
      fs.readFile(".agents/skills/autoreview/scripts/test-review-harness.ps1", "utf8"),
      fs.readFile(".agents/skills/autoreview/scripts/test-review-harness.py", "utf8"),
    ]);

    for (const launcher of [runner, shellLauncher, powershellLauncher]) {
      expect(launcher).toContain("sys.version_info >= (3, 10)");
      expect(launcher).toContain("Python 3.10 or newer is required");
    }
    for (const defectClass of ["path traversal", "command injection", "password exposure"]) {
      expect(harness).toContain(`"--require-finding",\n                    "${defectClass}"`);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects fake Python 3.9 launchers without running either harness",
    async () => {
      const root = process.cwd();
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-python39-"));
      const binDir = path.join(tempDir, "bin");
      const markerPath = path.join(tempDir, "ran-harness");
      const fakePython = `#!/bin/sh
if [ "$1" = "-c" ]; then
  exit 1
fi
touch "$FAKE_PYTHON_MARKER"
exit 99
`;

      try {
        await fs.mkdir(binDir);
        await Promise.all(
          ["python3", "python"].map(async (name) => {
            const executable = path.join(binDir, name);
            await fs.writeFile(executable, fakePython);
            await fs.chmod(executable, 0o755);
          }),
        );
        const env = {
          ...process.env,
          FAKE_PYTHON_MARKER: markerPath,
          PATH: `${binDir}:/usr/bin:/bin`,
        };

        await expect(
          execFileAsync(process.execPath, ["tools/run-autoreview-tests.mjs"], { cwd: root, env }),
        ).rejects.toMatchObject({
          code: 127,
          stderr: expect.stringContaining(
            "Python 3.10 or newer is required to run the autoreview tests.",
          ),
        });
        await expect(
          execFileAsync("bash", [".agents/skills/autoreview/scripts/test-review-harness"], {
            cwd: root,
            env,
          }),
        ).rejects.toMatchObject({
          code: 127,
          stderr: expect.stringContaining(
            "Python 3.10 or newer is required to run test-review-harness.",
          ),
        });
        await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    },
  );
});
