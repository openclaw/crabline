import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const CHANGELOG_HEADING_ERROR =
  'CHANGELOG.md must contain exactly one "## 1.2.3 - YYYY-MM-DD" heading.';
const PUBLISH_TARBALL_CONTENTS = "package";
const PUBLISH_PACKAGE_INTEGRITY = `sha512-${createHash("sha512")
  .update(PUBLISH_TARBALL_CONTENTS)
  .digest("base64")}`;

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
    expect(workflow.jobs?.verify?.outputs?.commit).toBe(
      "${{ steps.release-commit.outputs.commit }}",
    );
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
    expect(publishStep).toContain('npm view "$PACKAGE_NAME@$RELEASE_VERSION" version');
    expect(publishStep).toContain(
      'npm view "$PACKAGE_NAME@$RELEASE_VERSION" dist.attestations.provenance.predicateType',
    );
    expect(publishStep).toContain('npm view "$PACKAGE_NAME@latest" version');
    expect(publishStep).toContain('"Refusing to publish " +');
    expect(publishStep).toContain('" because npm latest is newer at " +');
    expect(publishStep).toContain("Downloaded npm tarball does not match expected integrity");
    expect(publishStep).toContain('npm publish "$PACKAGE_TARBALL" --access public --provenance');
    expect(publishStep).toContain("for delay in 2 4 8 16; do");
    expect(releaseStep).toContain('gh release view "$RELEASE_TAG"');
    expect(releaseStep).toContain("--json isDraft,isPrerelease");
    expect(releaseStep).toContain("--verify-tag");
  });

  it("revalidates the verified commit immediately before each release mutation", async () => {
    const workflow = await readWorkflow();
    const publishSteps = jobSteps(workflow, "publish");
    const releaseSteps = jobSteps(workflow, "github-release");
    const publishStep = publishSteps.find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    const releaseStep = releaseSteps.find((step) => step.name === "Create GitHub release")?.run;

    expect(publishSteps.some((step) => step.name === "Revalidate release tag commit")).toBe(false);
    expect(releaseSteps.some((step) => step.name === "Revalidate release tag commit")).toBe(false);
    for (const script of [publishStep, releaseStep]) {
      expect(script).toContain('"$GITHUB_EVENT_SHA" != "$VERIFIED_COMMIT"');
      expect(script).toContain("git ls-remote --exit-code");
      expect(script).toContain('"$remote_commit" != "$VERIFIED_COMMIT"');
    }
    expect(publishStep).toMatch(/revalidate_release_tag\n\s*if npm publish "\$PACKAGE_TARBALL"/u);
    expect(releaseStep).toMatch(/revalidate_release_tag\n\s*gh release create "\$RELEASE_TAG"/u);

    await expect(
      runPublishStep(publishStep ?? "", {
        MOCK_TAG_RACE_AFTER_LOOKUP: "1",
      }),
    ).rejects.toThrow("resolves to bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await expect(
      runGithubReleaseStep(releaseStep ?? "", "missing", {
        MOCK_TAG_RACE_AFTER_LOOKUP: "1",
      }),
    ).rejects.toThrow("resolves to bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
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
    expect(missingCalls).toHaveLength(3);
    expect(missingCalls[1]).toContain("git ls-remote --exit-code");
    expect(missingCalls[2]).toContain("release create v1.2.3");

    await expect(runGithubReleaseStep(releaseStep, "api-error")).rejects.toThrow(
      "Unable to inspect GitHub release v1.2.3",
    );
    await expect(runGithubReleaseStep(releaseStep, "unexpected-exit")).rejects.toThrow(
      "Unable to inspect GitHub release v1.2.3",
    );
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
    expect(contents).toContain('      - ".github/actions/**"');
    expect(contents).toContain('      - ".github/workflows/**"');
    expect(contents).toContain("      - pnpm-workspace.yaml");
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
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
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

  it("verifies package postconditions after existing, successful, and raced publishes", async () => {
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
    expect(matchingCalls).toEqual([
      "view @openclaw/crabline@1.2.3 dist.integrity",
      "view @openclaw/crabline@1.2.3 version",
      "view @openclaw/crabline@1.2.3 dist.attestations.provenance.predicateType",
      "view @openclaw/crabline@1.2.3 dist.integrity",
      "view @openclaw/crabline@1.2.3 version",
      "view @openclaw/crabline@1.2.3 dist.attestations.provenance.predicateType",
    ]);

    await expect(
      runPublishStep(publishStep, {
        MOCK_VIEW_RESULT: "mismatch",
      }),
    ).rejects.toThrow(
      `::error::Published @openclaw/crabline@1.2.3 has integrity sha512-different, expected ${PUBLISH_PACKAGE_INTEGRITY}.`,
    );
    await expect(
      runPublishStep(publishStep, {
        MOCK_PROVENANCE_RESULT: "missing",
        MOCK_VIEW_RESULT: "matching",
      }),
    ).rejects.toThrow("::error::Published @openclaw/crabline@1.2.3 is missing npm provenance.");
    await expect(
      runPublishStep(publishStep, {
        MOCK_PROVENANCE_RESULT: "unsupported",
        MOCK_VIEW_RESULT: "matching",
      }),
    ).rejects.toThrow(
      "::error::Published @openclaw/crabline@1.2.3 has unsupported provenance predicate https://example.invalid/provenance.",
    );
    const transientProvenanceCalls = await runPublishStep(publishStep, {
      MOCK_PROVENANCE_RESULT: "transient-once",
      MOCK_VIEW_RESULT: "matching",
    });
    expect(transientProvenanceCalls).toEqual(matchingCalls);
    await expect(
      runPublishStep(publishStep, {
        MOCK_PROVENANCE_RESULT: "transient",
        MOCK_VIEW_RESULT: "matching",
      }),
    ).rejects.toThrow(
      "::error::Unable to verify existing @openclaw/crabline@1.2.3 after bounded retries.",
    );

    const publishedCalls = await runPublishStep(publishStep, {
      MOCK_VIEW_RESULT: "after-publish",
    });
    const expectedPublishCalls = [
      "view @openclaw/crabline@1.2.3 dist.integrity",
      "view @openclaw/crabline@latest version",
      expect.stringContaining("git ls-remote --exit-code"),
      expect.stringMatching(
        /publish .*\/release\/crabline-1\.2\.3\.tgz --access public --provenance$/u,
      ),
      "view @openclaw/crabline@1.2.3 dist.integrity",
      "view @openclaw/crabline@1.2.3 version",
      "view @openclaw/crabline@1.2.3 dist.attestations.provenance.predicateType",
    ];
    expect(publishedCalls).toEqual(expectedPublishCalls);
    await expect(
      runPublishStep(publishStep, {
        MOCK_PUBLISH_STATUS: "1",
        MOCK_VIEW_RESULT: "after-publish",
      }),
    ).resolves.toEqual(expectedPublishCalls);

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

  it("rejects a downloaded tarball whose bytes do not match the verified SRI", async () => {
    const workflow = await readWorkflow();
    const publishStep = jobSteps(workflow, "publish").find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    if (!publishStep) {
      throw new Error("Release workflow is missing its npm publish step.");
    }

    const wrongIntegrity = `sha512-${createHash("sha512").update("other bytes").digest("base64")}`;
    await expect(
      runPublishStep(publishStep, {
        PACKAGE_INTEGRITY: wrongIntegrity,
      }),
    ).rejects.toThrow("Downloaded npm tarball does not match expected integrity");
  });

  it("fails closed when successful publication violates package postconditions", async () => {
    const workflow = await readWorkflow();
    const publishStep = jobSteps(workflow, "publish").find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    if (!publishStep) {
      throw new Error("Release workflow is missing its npm publish step.");
    }

    await expect(
      runPublishStep(publishStep, {
        MOCK_VIEW_RESULT: "mismatch-after-publish",
      }),
    ).rejects.toThrow(
      `::error::Published @openclaw/crabline@1.2.3 has integrity sha512-different, expected ${PUBLISH_PACKAGE_INTEGRITY}.`,
    );
    await expect(
      runPublishStep(publishStep, {
        MOCK_PROVENANCE_RESULT: "missing",
        MOCK_VIEW_RESULT: "after-publish",
      }),
    ).rejects.toThrow("::error::Published @openclaw/crabline@1.2.3 is missing npm provenance.");
    await expect(
      runPublishStep(publishStep, {
        MOCK_VERSION_RESULT: "mismatch",
        MOCK_VIEW_RESULT: "after-publish",
      }),
    ).rejects.toThrow("::error::Published @openclaw/crabline@1.2.3 reports version 1.2.4.");
    await expect(runPublishStep(publishStep, {})).rejects.toThrow(
      "::error::Unable to verify published @openclaw/crabline@1.2.3 after bounded retries.",
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

async function runGithubReleaseStep(
  script: string,
  state: string,
  overrides: Record<string, string> = {},
): Promise<string[]> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-github-release-"));
  const binDir = path.join(tempDir, "bin");
  const logPath = path.join(tempDir, "gh.log");
  const racePath = path.join(tempDir, "tag-raced");
  try {
    await fs.mkdir(binDir);
    await Promise.all([
      writeExecutable(
        path.join(binDir, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$MOCK_LOG"
if [[ "$1 $2" == "release view" ]]; then
  if [[ "\${MOCK_TAG_RACE_AFTER_LOOKUP:-0}" -eq 1 ]]; then
    touch "$MOCK_TAG_RACE"
  fi
  case "$MOCK_RELEASE_STATE" in
    stable) printf 'false\\tfalse\\n' ;;
    draft) printf 'true\\tfalse\\n' ;;
    prerelease) printf 'false\\ttrue\\n' ;;
    missing) echo "release not found" >&2; exit 1 ;;
    api-error) echo "HTTP 503: service unavailable" >&2; exit 1 ;;
    unexpected-exit) echo "gh crashed" >&2; exit 2 ;;
    *) exit 3 ;;
  esac
fi
`,
      ),
      writeExecutable(
        path.join(binDir, "git"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "git $*" >> "$MOCK_LOG"
remote_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if [[ -f "$MOCK_TAG_RACE" ]]; then
  remote_commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
fi
printf '%s\\trefs/tags/v1.2.3\\n' "dddddddddddddddddddddddddddddddddddddddd"
printf '%s\\trefs/tags/v1.2.3^{}\\n' "$remote_commit"
`,
      ),
    ]);
    await execFileWithOutput("bash", ["-c", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        ...overrides,
        GITHUB_EVENT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        GITHUB_REPOSITORY: "openclaw/crabline",
        GITHUB_SERVER_URL: "https://github.com",
        MOCK_LOG: logPath,
        MOCK_RELEASE_STATE: state,
        MOCK_TAG_RACE: racePath,
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_TAG: "v1.2.3",
        RUNNER_TEMP: tempDir,
        VERIFIED_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
  const publishedPath = path.join(tempDir, "published");
  const provenanceCountPath = path.join(tempDir, "provenance-count");
  const racePath = path.join(tempDir, "tag-raced");
  const releaseDir = path.join(tempDir, "release");

  try {
    await Promise.all([fs.mkdir(binDir), fs.mkdir(releaseDir)]);
    await fs.writeFile(path.join(releaseDir, "crabline-1.2.3.tgz"), PUBLISH_TARBALL_CONTENTS);
    await Promise.all([
      writeExecutable(
        path.join(binDir, "npm"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$MOCK_LOG"
if [[ "$1" == "publish" ]]; then
  touch "$MOCK_PUBLISHED"
  exit "\${MOCK_PUBLISH_STATUS:-0}"
fi
if [[ "$2" == "$PACKAGE_NAME@latest" ]]; then
  if [[ "\${MOCK_TAG_RACE_AFTER_LOOKUP:-0}" -eq 1 ]]; then
    touch "$MOCK_TAG_RACE"
  fi
  if [[ "\${MOCK_LATEST_STATUS:-0}" -ne 0 ]]; then
    exit "$MOCK_LATEST_STATUS"
  fi
  echo "\${MOCK_LATEST_VERSION:-1.2.2}"
  exit 0
fi
view_result="\${MOCK_VIEW_RESULT:-missing}"
if [[ "$view_result" == *"after-publish" && ! -f "$MOCK_PUBLISHED" ]]; then
  exit 1
fi
if [[ "$3" == "version" ]]; then
  case "\${MOCK_VERSION_RESULT:-matching}" in
    matching) echo "$RELEASE_VERSION" ;;
    mismatch) echo "1.2.4" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$3" == "dist.attestations.provenance.predicateType" ]]; then
  case "\${MOCK_PROVENANCE_RESULT:-matching}" in
    matching) echo "https://slsa.dev/provenance/v1" ;;
    missing) exit 0 ;;
    unsupported) echo "https://example.invalid/provenance" ;;
    transient-once)
      provenance_count=0
      if [[ -f "$MOCK_PROVENANCE_COUNT" ]]; then
        provenance_count="$(cat "$MOCK_PROVENANCE_COUNT")"
      fi
      echo "$((provenance_count + 1))" > "$MOCK_PROVENANCE_COUNT"
      if [[ "$provenance_count" -eq 0 ]]; then
        exit 1
      fi
      echo "https://slsa.dev/provenance/v1"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$view_result" in
  matching | after-publish) echo "$PACKAGE_INTEGRITY" ;;
  mismatch | mismatch-after-publish) echo "sha512-different" ;;
  *) exit 1 ;;
esac
`,
      ),
      writeExecutable(
        path.join(binDir, "git"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "git $*" >> "$MOCK_LOG"
remote_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if [[ -f "$MOCK_TAG_RACE" ]]; then
  remote_commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
fi
printf '%s\\trefs/tags/v1.2.3\\n' "dddddddddddddddddddddddddddddddddddddddd"
printf '%s\\trefs/tags/v1.2.3^{}\\n' "$remote_commit"
`,
      ),
      writeExecutable(path.join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n"),
    ]);

    await execFileWithOutput("bash", ["-c", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        GITHUB_EVENT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        GITHUB_REPOSITORY: "openclaw/crabline",
        GITHUB_SERVER_URL: "https://github.com",
        MOCK_LOG: logPath,
        MOCK_PUBLISHED: publishedPath,
        MOCK_PROVENANCE_COUNT: provenanceCountPath,
        MOCK_TAG_RACE: racePath,
        PACKAGE_INTEGRITY: PUBLISH_PACKAGE_INTEGRITY,
        PACKAGE_NAME: "@openclaw/crabline",
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_TAG: "v1.2.3",
        RELEASE_VERSION: "1.2.3",
        RUNNER_TEMP: tempDir,
        VERIFIED_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ...overrides,
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
