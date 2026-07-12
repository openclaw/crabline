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
    queue?: string;
  };
  jobs?: Record<
    string,
    {
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

describe("release workflow", () => {
  it("only accepts stable tags and checks out the exact tag ref", async () => {
    const workflow = await readWorkflow();
    const steps = jobSteps(workflow, "verify");
    const resolveStep = steps.find((step) => step.name === "Resolve release tag")?.run;
    const checkoutStep = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    const verifyCheckoutStep = steps.find(
      (step) => step.name === "Verify checked out release tag",
    )?.run;

    await expect(runResolveTag(resolveStep, "v1.2.3")).resolves.toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    });
    await expect(
      runResolveTag(resolveStep, "v1.2.3", {
        eventName: "workflow_dispatch",
        refName: "v1.2.3",
        refType: "tag",
      }),
    ).resolves.toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    });
    await expect(
      runResolveTag(resolveStep, "v1.2.3", {
        eventName: "workflow_dispatch",
        refName: "main",
        refType: "branch",
      }),
    ).rejects.toThrow(/Command failed/u);
    await expect(runResolveTag(resolveStep, "v1.2.3-beta.1")).rejects.toThrow(/Command failed/u);
    await expect(runResolveTag(resolveStep, "v1.2.3.preview")).rejects.toThrow(/Command failed/u);
    await expect(
      runResolveTag(resolveStep, "v1.2.3", { refName: "main", refType: "branch" }),
    ).rejects.toThrow(/Command failed/u);
    await expect(
      runResolveTag(resolveStep, "v1.2.3", { refName: "v1.2.2", refType: "tag" }),
    ).rejects.toThrow(/Command failed/u);
    expect(checkoutStep?.with?.ref).toBe("refs/tags/${{ steps.release.outputs.tag }}");
    expect(verifyCheckoutStep).toContain("refs/tags/${RELEASE_TAG}^{commit}");
    expect(verifyCheckoutStep).toContain('"$release_commit" == "$GITHUB_EVENT_SHA"');
  });

  it("pins tooling and makes package and GitHub publication retry-safe", async () => {
    const workflow = await readWorkflow();
    const verifySteps = jobSteps(workflow, "verify");
    const publishSteps = jobSteps(workflow, "publish");
    const releaseSteps = jobSteps(workflow, "github-release");
    const steps = [...verifySteps, ...publishSteps, ...releaseSteps];
    const commands = steps.map((step) => step.run).filter((run): run is string => Boolean(run));
    const packageStep = verifySteps.find((step) => step.id === "package")?.run;
    const uploadStep = verifySteps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const publishStep = publishSteps.find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    const releaseStep = releaseSteps.find((step) => step.name === "Create GitHub release")?.run;

    expect(workflow.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "release",
      queue: "max",
    });
    expect(
      verifySteps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with?.[
        "node-version"
      ],
    ).toBe(22);
    expect(commands).toContain("npm install -g npm@12.0.1");
    for (const jobName of ["verify", "publish"]) {
      const jobCommands = jobSteps(workflow, jobName)
        .map((step) => step.run)
        .filter((run): run is string => Boolean(run));
      expect(jobCommands).toContain("npm install -g npm@12.0.1");
    }
    expect(commands.some((command) => command.includes("npm@latest"))).toBe(false);
    const verifyCommands = verifySteps
      .map((step) => step.run)
      .filter((run): run is string => Boolean(run));
    expect(verifyCommands.indexOf("pnpm build")).toBeLessThan(
      verifyCommands.indexOf("pnpm verify"),
    );
    expect(packageStep).toContain(
      'npm pack --ignore-scripts --json --pack-destination "$RUNNER_TEMP"',
    );
    expect(packageStep).toContain("Packed artifact is missing the crabline CLI");
    expect(packageStep).toContain('execFileSync("tar", ["-xzf", tarballPath');
    expect(uploadStep?.with?.path).toBe("${{ steps.package.outputs.tarball }}");
    expect(publishStep).toContain('npm view "$PACKAGE_NAME@$RELEASE_VERSION" dist.integrity');
    expect(publishStep).toContain('npm view "$PACKAGE_NAME@latest" version');
    expect(publishStep).toContain('"Refusing to publish " +');
    expect(publishStep).toContain('" because npm latest is newer at " +');
    expect(publishStep).toContain('npm publish "$PACKAGE_TARBALL" --access public --provenance');
    expect(releaseStep).toContain('gh release view "$RELEASE_TAG"');
    expect(releaseStep).toContain("--json isDraft,isPrerelease");
    expect(releaseStep).toContain("--verify-tag");
  });

  it("accepts only published stable GitHub releases as existing", async () => {
    const workflow = await readWorkflow();
    const releaseStep = jobSteps(workflow, "github-release").find(
      (step) => step.name === "Create GitHub release",
    )?.run;
    if (!releaseStep) {
      throw new Error("Release workflow is missing its GitHub release step.");
    }

    const stableCalls = await runGithubReleaseStep(releaseStep, "stable");
    expect(stableCalls).toHaveLength(1);
    expect(stableCalls[0]).toContain("release view v1.2.3");

    for (const state of ["draft", "prerelease"]) {
      await expect(runGithubReleaseStep(releaseStep, state)).rejects.toThrow(
        "exists but is draft or prerelease",
      );
    }

    const missingCalls = await runGithubReleaseStep(releaseStep, "missing");
    expect(missingCalls).toHaveLength(2);
    expect(missingCalls[1]).toContain("release create v1.2.3");
  });

  it("pins privileged release actions to immutable revisions", async () => {
    const workflow = await readWorkflow();
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const actionRefs = steps
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined);

    expect(actionRefs).not.toEqual([]);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
    }
  });

  it("identifies the dependency-review checkout pin as v7", async () => {
    const contents = await fs.readFile(
      path.join(process.cwd(), ".github/workflows/dependency-review.yml"),
      "utf8",
    );

    expect(contents).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
    );
    expect(contents).not.toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v6",
    );
  });

  it("isolates package verification, OIDC publication, and GitHub release authority", async () => {
    const workflow = await readWorkflow();
    const verify = workflow.jobs?.verify;
    const publish = workflow.jobs?.publish;
    const githubRelease = workflow.jobs?.["github-release"];
    const verifyCommands = jobSteps(workflow, "verify")
      .map((step) => step.run)
      .filter((run): run is string => Boolean(run));
    const publishCommands = jobSteps(workflow, "publish")
      .map((step) => step.run)
      .filter((run): run is string => Boolean(run));

    expect(verify?.permissions).toEqual({ contents: "read" });
    expect(publish?.permissions).toEqual({ "id-token": "write" });
    expect(githubRelease?.permissions).toEqual({ contents: "write" });
    expect(publish?.needs).toBe("verify");
    expect(githubRelease?.needs).toEqual(["verify", "publish"]);
    expect(verifyCommands).toContain("pnpm install --frozen-lockfile");
    expect(verifyCommands).toContain("pnpm verify");
    expect(
      publishCommands
        .filter((command) => command !== "npm install -g npm@12.0.1")
        .some((command) => /\b(?:pnpm|install|build|test|pack)\b/u.test(command)),
    ).toBe(false);
  });

  it("requires an exact changelog version heading", async () => {
    const workflow = await readWorkflow();
    const verifyStep = jobSteps(workflow, "verify").find(
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
    const packageStep = jobSteps(workflow, "verify").find((step) => step.id === "package")?.run;
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

    await expect(
      runPackageMetadataCheck(script, JSON.stringify([pack]), "console.log('missing shebang');\n"),
    ).rejects.toThrow("Packed CLI dist/src/bin/crabline.js is missing its Node shebang.");
  });

  it("skips matching packages, rejects drift, and recovers after publish races", async () => {
    const workflow = await readWorkflow();
    const publishStep = jobSteps(workflow, "publish").find(
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
      "view @openclaw/crabline@latest version",
      expect.stringMatching(
        /publish .*\/release\/crabline-1\.2\.3\.tgz --access public --provenance$/u,
      ),
      "view @openclaw/crabline@1.2.3 dist.integrity",
    ]);

    await expect(
      runPublishStep(publishStep, {
        MOCK_LATEST_VERSION: "1.2.4",
      }),
    ).rejects.toThrow("Refusing to publish 1.2.3 because npm latest is newer at 1.2.4.");
    await expect(
      runPublishStep(publishStep, {
        MOCK_LATEST_STATUS: "1",
      }),
    ).rejects.toThrow(
      "::error::Unable to resolve the current npm latest version for @openclaw/crabline.",
    );
  });
});

async function readWorkflow(): Promise<ReleaseWorkflow> {
  const contents = await fs.readFile(
    path.join(process.cwd(), ".github/workflows/release.yml"),
    "utf8",
  );
  return parse(contents) as ReleaseWorkflow;
}

function jobSteps(workflow: ReleaseWorkflow, name: string): WorkflowStep[] {
  return workflow.jobs?.[name]?.steps ?? [];
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
  ref: { eventName?: string; refName: string; refType: string } = {
    refName: tag,
    refType: "tag",
  },
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
        GITHUB_EVENT_NAME: ref.eventName ?? "push",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REF_NAME: ref.refName,
        GITHUB_REF_TYPE: ref.refType,
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

async function runGithubReleaseStep(script: string, state: string): Promise<string[]> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-github-release-"));
  const binDir = path.join(tempDir, "bin");
  const logPath = path.join(tempDir, "gh.log");
  try {
    await fs.mkdir(binDir);
    await writeExecutable(
      path.join(binDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$MOCK_LOG"
if [[ "$1 $2" == "release view" ]]; then
  case "$MOCK_RELEASE_STATE" in
    stable) printf 'false\\tfalse\\n' ;;
    draft) printf 'true\\tfalse\\n' ;;
    prerelease) printf 'false\\ttrue\\n' ;;
    missing) exit 1 ;;
    *) exit 2 ;;
  esac
fi
`,
    );
    await execFileWithOutput("bash", ["-c", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "openclaw/crabline",
        MOCK_LOG: logPath,
        MOCK_RELEASE_STATE: state,
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_TAG: "v1.2.3",
      },
    });
    return (await fs.readFile(logPath, "utf8")).trim().split("\n");
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function runPackageMetadataCheck(
  script: string,
  packOutput: string,
  packedCli = "#!/usr/bin/env node\nconsole.log('crabline');\n",
): Promise<Record<string, string>> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-release-package-"));
  const outputPath = path.join(tempDir, "outputs");
  const packageRoot = path.join(tempDir, "package");
  try {
    await Promise.all([
      fs.mkdir(path.join(tempDir, "dist/src/bin"), { recursive: true }),
      fs.mkdir(path.join(packageRoot, "dist/src/bin"), { recursive: true }),
    ]);
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
      fs.writeFile(path.join(packageRoot, "dist/src/bin/crabline.js"), packedCli),
    ]);
    await execFileAsync(
      "tar",
      ["-czf", path.join(tempDir, "openclaw-crabline-1.2.3.tgz"), "-C", tempDir, "package"],
      { cwd: tempDir },
    );
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
  const releaseDir = path.join(tempDir, "release");
  const viewCountPath = path.join(tempDir, "view-count");

  try {
    await Promise.all([fs.mkdir(binDir), fs.mkdir(releaseDir)]);
    await fs.writeFile(path.join(releaseDir, "crabline-1.2.3.tgz"), "package");
    await Promise.all([
      writeExecutable(
        path.join(binDir, "npm"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$MOCK_LOG"
if [[ "$1" == "publish" ]]; then
  exit "\${MOCK_PUBLISH_STATUS:-0}"
fi
if [[ "$2" == "$PACKAGE_NAME@latest" ]]; then
  if [[ "\${MOCK_LATEST_STATUS:-0}" -ne 0 ]]; then
    exit "$MOCK_LATEST_STATUS"
  fi
  echo "\${MOCK_LATEST_VERSION:-1.2.2}"
  exit 0
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
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_VERSION: "1.2.3",
        RUNNER_TEMP: tempDir,
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
