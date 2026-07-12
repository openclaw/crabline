import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const CHANGELOG_HEADING_ERROR =
  'CHANGELOG.md must contain exactly one "## 1.2.3 - YYYY-MM-DD" heading.';

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type ReleaseWorkflow = {
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
  };
  jobs?: {
    release?: {
      steps?: WorkflowStep[];
    };
  };
};

describe("release workflow", () => {
  it("only accepts stable tags and checks out the exact tag ref", async () => {
    const workflow = await readWorkflow();
    const steps = workflow.jobs?.release?.steps ?? [];
    const resolveStep = steps.find((step) => step.name === "Resolve release tag")?.run;
    const checkoutStep = steps.find((step) => step.uses?.startsWith("actions/checkout@"));

    await expect(runResolveTag(resolveStep, "v1.2.3")).resolves.toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    });
    await expect(runResolveTag(resolveStep, "v1.2.3-beta.1")).rejects.toThrow();
    await expect(runResolveTag(resolveStep, "v1.2.3.preview")).rejects.toThrow();
    expect(checkoutStep?.with?.ref).toBe("refs/tags/${{ steps.release.outputs.tag }}");
  });

  it("pins tooling and makes package and GitHub publication retry-safe", async () => {
    const workflow = await readWorkflow();
    const steps = workflow.jobs?.release?.steps ?? [];
    const commands = steps.map((step) => step.run).filter((run): run is string => Boolean(run));
    const packageStep = steps.find((step) => step.id === "package")?.run;
    const publishStep = steps.find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    const releaseStep = steps.find((step) => step.name === "Create GitHub release")?.run;

    expect(workflow.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "release-${{ inputs.tag_name || github.ref_name }}",
    });
    expect(commands).toContain("npm install -g npm@12.0.1");
    expect(commands.some((command) => command.includes("npm@latest"))).toBe(false);
    expect(packageStep).toContain('npm pack --json --pack-destination "$RUNNER_TEMP"');
    expect(packageStep).toContain("Packed artifact is missing the crabline CLI");
    expect(publishStep).toContain('npm view "$PACKAGE_NAME@$RELEASE_VERSION" dist.integrity');
    expect(publishStep).toContain('npm publish "$PACKAGE_TARBALL" --access public --provenance');
    expect(releaseStep).toContain('gh release view "$RELEASE_TAG"');
    expect(releaseStep).toContain("--verify-tag");
  });

  it("requires an exact changelog version heading", async () => {
    const workflow = await readWorkflow();
    const verifyStep = workflow.jobs?.release?.steps?.find(
      (step) => step.name === "Verify release metadata",
    )?.run;
    const script = extractNodeHeredoc(verifyStep);

    await expect(runMetadataCheck(script, "## 1.2.3 - 2026-07-12\n")).resolves.toBeUndefined();
    await expect(runMetadataCheck(script, "## 1.2.30 - 2026-07-12\n")).rejects.toThrow(
      CHANGELOG_HEADING_ERROR,
    );
    await expect(runMetadataCheck(script, "## 1x2x3 - 2026-07-12\n")).rejects.toThrow(
      CHANGELOG_HEADING_ERROR,
    );
    await expect(runMetadataCheck(script, "## 1.2.3-beta - 2026-07-12\n")).rejects.toThrow(
      CHANGELOG_HEADING_ERROR,
    );
  });

  it("extracts pack metadata around lifecycle output", async () => {
    const workflow = await readWorkflow();
    const packageStep = workflow.jobs?.release?.steps?.find((step) => step.id === "package")?.run;
    const script = extractNodeHeredoc(packageStep);
    const pack = {
      filename: "openclaw-crabline-1.2.3.tgz",
      files: [{ path: "dist/src/bin/crabline.js" }],
      integrity: "sha512-expected",
      version: "1.2.3",
    };

    for (const metadata of [[pack], { "@openclaw/crabline": pack }]) {
      await expect(
        runPackageMetadataCheck(
          script,
          `> @openclaw/crabline prepare\n${JSON.stringify(metadata, null, 2)}\n> prepare complete`,
        ),
      ).resolves.toEqual({
        integrity: "sha512-expected",
        name: "@openclaw/crabline",
        tarball: expect.stringMatching(/openclaw-crabline-1\.2\.3\.tgz$/u),
      });
    }
  });

  it("skips matching packages, rejects drift, and recovers after publish races", async () => {
    const workflow = await readWorkflow();
    const publishStep = workflow.jobs?.release?.steps?.find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    if (!publishStep) {
      throw new Error("Release workflow is missing its npm publish step.");
    }

    const matchingCalls = await runPublishStep(publishStep, {
      MOCK_VIEW_RESULT: "matching",
    });
    expect(matchingCalls).toEqual(["view @openclaw/crabline@1.2.3 dist.integrity"]);

    await expect(
      runPublishStep(publishStep, {
        MOCK_VIEW_RESULT: "mismatch",
      }),
    ).rejects.toThrow(
      "::error::Published @openclaw/crabline@1.2.3 has integrity sha512-different, expected sha512-expected.",
    );

    const racedCalls = await runPublishStep(publishStep, {
      MOCK_PUBLISH_STATUS: "1",
      MOCK_VIEW_RESULT: "after-publish",
    });
    expect(racedCalls).toEqual([
      "view @openclaw/crabline@1.2.3 dist.integrity",
      "publish /tmp/crabline-1.2.3.tgz --access public --provenance",
      "view @openclaw/crabline@1.2.3 dist.integrity",
    ]);
  });
});

async function readWorkflow(): Promise<ReleaseWorkflow> {
  const contents = await fs.readFile(
    path.join(process.cwd(), ".github/workflows/release.yml"),
    "utf8",
  );
  return parse(contents) as ReleaseWorkflow;
}

function extractNodeHeredoc(run: string | undefined): string {
  const match = /node --input-type=module <<'NODE'\n(?<script>[\s\S]*?)\nNODE/u.exec(run ?? "");
  if (!match?.groups?.script) {
    throw new Error("Workflow step is missing its Node validation script.");
  }
  return match.groups.script;
}

async function runMetadataCheck(script: string, changelog: string): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-release-metadata-"));
  try {
    await Promise.all([
      fs.writeFile(path.join(tempDir, "CHANGELOG.md"), changelog),
      fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ version: "1.2.3" })),
    ]);
    await execFileWithOutput(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        RELEASE_VERSION: "1.2.3",
      },
    });
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function runResolveTag(
  script: string | undefined,
  tag: string,
): Promise<Record<string, string>> {
  if (!script) {
    throw new Error("Release workflow is missing its tag resolution step.");
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-release-tag-"));
  const outputPath = path.join(tempDir, "outputs");
  try {
    await execFileWithOutput("bash", ["-c", script], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REF_NAME: tag,
        INPUT_TAG: tag,
      },
    });
    return Object.fromEntries(
      (await fs.readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function runPackageMetadataCheck(
  script: string,
  packOutput: string,
): Promise<Record<string, string>> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-release-package-"));
  const outputPath = path.join(tempDir, "outputs");
  try {
    await fs.mkdir(path.join(tempDir, "dist/src/bin"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(tempDir, "npm-pack.json"), packOutput),
      fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({
          bin: { crabline: "dist/src/bin/crabline.js" },
          name: "@openclaw/crabline",
        }),
      ),
      fs.writeFile(
        path.join(tempDir, "dist/src/bin/crabline.js"),
        "#!/usr/bin/env node\nconsole.log('crabline');\n",
      ),
    ]);
    await execFileWithOutput(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RELEASE_VERSION: "1.2.3",
        RUNNER_TEMP: tempDir,
      },
    });
    return Object.fromEntries(
      (await fs.readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function runPublishStep(
  script: string,
  overrides: Record<string, string>,
): Promise<string[]> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-release-publish-"));
  const binDir = path.join(tempDir, "bin");
  const logPath = path.join(tempDir, "npm.log");
  const viewCountPath = path.join(tempDir, "view-count");

  try {
    await fs.mkdir(binDir);
    await Promise.all([
      writeExecutable(
        path.join(binDir, "npm"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$MOCK_LOG"
if [[ "$1" == "publish" ]]; then
  exit "\${MOCK_PUBLISH_STATUS:-0}"
fi
count=0
if [[ -f "$MOCK_VIEW_COUNT" ]]; then
  count="$(cat "$MOCK_VIEW_COUNT")"
fi
count=$((count + 1))
echo "$count" > "$MOCK_VIEW_COUNT"
case "\${MOCK_VIEW_RESULT:-missing}" in
  matching) echo "$PACKAGE_INTEGRITY" ;;
  mismatch) echo "sha512-different" ;;
  after-publish)
    if [[ "$count" -gt 1 ]]; then
      echo "$PACKAGE_INTEGRITY"
    else
      exit 1
    fi
    ;;
  *) exit 1 ;;
esac
`,
      ),
      writeExecutable(path.join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n"),
    ]);

    await execFileWithOutput("bash", ["-c", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        ...overrides,
        MOCK_LOG: logPath,
        MOCK_VIEW_COUNT: viewCountPath,
        PACKAGE_INTEGRITY: "sha512-expected",
        PACKAGE_NAME: "@openclaw/crabline",
        PACKAGE_TARBALL: "/tmp/crabline-1.2.3.tgz",
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_VERSION: "1.2.3",
      },
    });
    return (await fs.readFile(logPath, "utf8")).trim().split("\n");
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
}

async function execFileWithOutput(
  file: string,
  args: string[],
  options: Parameters<typeof execFileAsync>[2],
): Promise<void> {
  try {
    await execFileAsync(file, args, options);
  } catch (error) {
    const failure = error as Error & {
      stderr?: string;
      stdout?: string;
    };
    const output = [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || failure.message, { cause: error });
  }
}
