import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const candidates =
  process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python3", []],
        ["python", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];

const python = candidates.find(([command, launcherArgs]) => {
  const result = spawnSync(
    command,
    [
      ...launcherArgs,
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
    ],
    { stdio: "ignore" },
  );
  return result.status === 0;
});

if (!python) {
  // oxlint-disable-next-line no-console -- This CLI failure must be visible on stderr.
  console.error("Python 3.10 or newer is required to run the autoreview tests.");
  process.exit(127);
}

const [command, launcherArgs] = python;
const suites = [
  [path.join(root, ".agents/skills/autoreview/scripts/autoreview_test.py")],
  [
    "-m",
    "unittest",
    "discover",
    "-s",
    path.join(root, ".agents/skills/autoreview/tests"),
    "-p",
    "test_*.py",
  ],
];

for (const suiteArgs of suites) {
  const result = spawnSync(command, [...launcherArgs, ...suiteArgs], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
