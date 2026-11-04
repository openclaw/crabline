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
const PUBLISH_PACKAGE_DIGEST = createHash("sha512").update(PUBLISH_TARBALL_CONTENTS).digest("hex");
const PROVENANCE_MISMATCH_ERROR =
  "::error::Published @openclaw/crabline@1.2.3 has provenance that does not match the repository, workflow, tag, commit, or package integrity.";

type WorkflowStep = {
  env?: Record<string, string>;
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
      if?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

function createAuditResult(
  overrides: {
    commit?: string;
    predicateType?: string;
    ref?: string;
    repository?: string;
    subjectDigest?: string;
    workflowPath?: string;
  } = {},
): Record<string, unknown> {
  const predicateType = overrides.predicateType ?? "https://slsa.dev/provenance/v1";
  const repository = overrides.repository ?? "https://github.com/openclaw/crabline";
  const ref = overrides.ref ?? "refs/tags/v1.2.3";
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType,
    subject: [
      {
        digest: { sha512: overrides.subjectDigest ?? PUBLISH_PACKAGE_DIGEST },
        name: "pkg:npm/%40openclaw/crabline@1.2.3",
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path: overrides.workflowPath ?? ".github/workflows/release.yml",
            ref,
            repository,
          },
        },
        resolvedDependencies: [
          {
            digest: {
              gitCommit: overrides.commit ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            uri: `git+${repository}@${ref}`,
          },
        ],
      },
    },
  };
  return {
    verified: [
      {
        attestationBundles: [
          {
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
              },
            },
            predicateType,
          },
        ],
        attestations: { provenance: { predicateType } },
        name: "@openclaw/crabline",
        version: "1.2.3",
      },
    ],
  };
}

describe("release workflow", () => {
  it("only accepts stable tags and checks out the immutable workflow commit", async () => {
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
    expect(checkoutStep?.with?.ref).toBe("${{ github.sha }}");
    expect(verifyCheckoutStep).toContain("${tag_object}^{commit}");
    expect(verifyCheckoutStep).toContain('"$release_commit" == "$GITHUB_EVENT_SHA"');
    expect(workflow.jobs?.verify?.outputs?.tag_object).toBe(
      "${{ steps.release-commit.outputs.tag_object }}",
    );
    expect(workflow.jobs?.verify?.outputs?.commit).toBe(
      "${{ steps.release-commit.outputs.commit }}",
    );
  });

  it("verifies real SSH tag signatures against the frozen signer policy", async () => {
    const workflow = await readWorkflow();
    const script = jobSteps(workflow, "verify").find(
      (step) => step.name === "Verify checked out release tag",
    )?.run;
    expect(script).toBeDefined();
    await withReleaseTagFixture(async (fixture) => {
      const output = path.join(fixture.cwd, "outputs");
      const verify = (overrides: Record<string, string> = {}) =>
        execFileWithOutput("/bin/bash", ["-c", script!], {
          cwd: fixture.cwd,
          env: {
            ...fixture.env,
            GITHUB_EVENT_SHA: fixture.commit,
            GITHUB_OUTPUT: output,
            RELEASE_TAG: "v1.2.3",
            ...overrides,
          },
        });
      for (const key of [fixture.key, fixture.secondKey]) {
        await fixture.sign(key);
        await fs.writeFile(output, "");
        await verify();
        expect(await fs.readFile(output, "utf8")).toBe(
          `commit=${fixture.commit}\ntag_object=${await fixture.git("rev-parse", "v1.2.3")}\n`,
        );
      }
      await expect(verify({ GITHUB_EVENT_SHA: fixture.otherCommit })).rejects.toThrow(
        "does not match the workflow event commit",
      );
      await fixture.git("tag", "-f", "v1.2.3", fixture.commit);
      await expect(verify()).rejects.toThrow(/must be an annotated SSH-signed tag/iu);
      await fixture.git("tag", "-f", "-a", "v1.2.3", fixture.commit, "-m", "unsigned");
      await expect(verify()).rejects.toThrow("must end with an SSH signature");
      for (const format of ["PGP SIGNATURE", "SIGNED MESSAGE"]) {
        await fixture.git(
          "tag",
          "-f",
          "-a",
          "v1.2.3",
          fixture.commit,
          "-m",
          `-----BEGIN ${format}-----\nZmFrZQ==\n-----END ${format}-----`,
        );
        await expect(verify()).rejects.toThrow("must end with an SSH signature");
      }
      await fixture.sign(fixture.unknownKey);
      await expect(verify()).rejects.toThrow(/No principal matched/iu);
      await fixture.sign(fixture.key, fixture.otherCommit);
      await expect(verify()).rejects.toThrow(/does not match the checked out commit/iu);
      await fixture.sign(fixture.key);
      const payload = (await fixture.git("cat-file", "tag", "v1.2.3")).replace(
        "release fixture",
        "tampered fixture",
      );
      const payloadPath = path.join(fixture.cwd, "tampered-tag");
      await fs.writeFile(payloadPath, `${payload}\n`);
      const tampered = await fixture.git("hash-object", "-t", "tag", "-w", payloadPath);
      await fixture.git("update-ref", "refs/tags/v1.2.3", tampered);
      await expect(verify()).rejects.toThrow(/signature/iu);
      await fixture.sign(fixture.key);
      const policy = path.join(fixture.cwd, ".github/release-allowed-signers");
      const allowed = await fs.readFile(policy, "utf8");
      await fs.writeFile(policy, "");
      await expect(verify()).rejects.toThrow(/nonempty regular file/iu);
      await fs.rm(policy);
      await expect(verify()).rejects.toThrow(/nonempty regular file/iu);
      const alternate = path.join(fixture.cwd, "allowed-signers");
      await fs.writeFile(alternate, allowed);
      await fs.symlink(alternate, policy);
      await expect(verify()).rejects.toThrow(/nonempty regular file/iu);
      await fs.rm(policy);
      await fs.writeFile(policy, allowed.replaceAll('namespaces="git"', 'namespaces="file"'));
      await expect(verify()).rejects.toThrow(/namespace/iu);
      await fixture.git("tag", "-d", "v1.2.3");
      await fs.rm(policy);
      await fs.writeFile(output, "");
      await verify({ INPUT_DRY_RUN: "true" });
      expect(await fs.readFile(output, "utf8")).toBe(`commit=${fixture.commit}\ntag_object=\n`);
    });
  });

  it("binds both publication guards to the real verified tag object and commit", async () => {
    const workflow = await readWorkflow();
    await withReleaseTagFixture(async (fixture) => {
      const remote = path.join(fixture.cwd, "remote.git");
      await fixture.git("init", "--bare", remote);
      const frozenObject = await fixture.git("rev-parse", "v1.2.3");
      const publishTag = () => fixture.git("push", "--force", remote, "refs/tags/v1.2.3");
      await publishTag();
      for (const [job, name] of [
        ["publish", "Publish package with npm provenance"],
        ["github-release", "Create GitHub release"],
      ]) {
        const step = jobSteps(workflow, job!).find((candidate) => candidate.name === name);
        const guard = /revalidate_release_tag\(\) \{[\s\S]*?\n\}/u.exec(step?.run ?? "")?.[0];
        expect(guard).toBeDefined();
        const verify = (overrides: Record<string, string> = {}) =>
          execFileWithOutput(
            "/bin/bash",
            ["-c", `set -euo pipefail\n${guard}\nrevalidate_release_tag`],
            {
              cwd: fixture.cwd,
              env: {
                ...fixture.env,
                GITHUB_EVENT_SHA: fixture.commit,
                GITHUB_REPOSITORY: "remote",
                GITHUB_SERVER_URL: fixture.cwd,
                RELEASE_TAG: "v1.2.3",
                VERIFIED_COMMIT: fixture.commit,
                VERIFIED_TAG_OBJECT: frozenObject,
                ...overrides,
              },
            },
          );
        await fixture.git("update-ref", "refs/tags/v1.2.3", frozenObject);
        await publishTag();
        await verify();
        await expect(verify({ VERIFIED_TAG_OBJECT: "" })).rejects.toThrow("object is");
        await expect(verify({ GITHUB_EVENT_SHA: fixture.otherCommit })).rejects.toThrow(
          "does not match verified commit",
        );
        await fixture.sign(fixture.secondKey);
        await publishTag();
        await expect(verify()).rejects.toThrow("object is");
        await fixture.sign(fixture.key, fixture.otherCommit);
        await publishTag();
        await expect(verify()).rejects.toThrow("object is");
        await fixture.git("tag", "-f", "v1.2.3", fixture.commit);
        await publishTag();
        await expect(verify()).rejects.toThrow("object is");
        await fixture.git("push", remote, ":refs/tags/v1.2.3");
        await expect(verify()).rejects.toThrow(/Command failed/u);
      }
    });
  });

  it("pins a manual dry run to its commit and skips both publication jobs", async () => {
    const workflow = await readWorkflow();
    const resolveStep = jobSteps(workflow, "verify").find(
      (step) => step.name === "Resolve release tag",
    )?.run;
    await expect(
      runResolveTag(resolveStep, "v1.2.3", {
        eventName: "workflow_dispatch",
        refName: "main",
        refType: "branch",
        dryRun: true,
      }),
    ).resolves.toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    });
    await expect(
      runResolveTag(resolveStep, "v1.2.3", {
        eventName: "push",
        refName: "main",
        refType: "branch",
        dryRun: true,
      }),
    ).rejects.toThrow(/Command failed/u);
    expect(workflow.jobs?.publish?.if).toBe("${{ !inputs.dry_run }}");
    expect(workflow.jobs?.["github-release"]?.if).toBe("${{ !inputs.dry_run }}");
    expect(workflow.jobs?.verify?.permissions).toEqual({ contents: "read" });
    expect(
      jobSteps(workflow, "verify").find((step) => step.uses?.startsWith("actions/checkout@"))?.with
        ?.ref,
    ).toBe("${{ github.sha }}");
  });

  it("rejects a dry-run checkout that differs from the workflow commit", async () => {
    const workflow = await readWorkflow();
    const script = jobSteps(workflow, "verify").find(
      (step) => step.name === "Verify checked out release tag",
    )?.run;
    expect(script).toBeDefined();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-dry-run-checkout-"));
    const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try {
      await writeExecutable(
        path.join(tempDir, "git"),
        `#!/usr/bin/env bash
[[ "$*" == "rev-parse HEAD" ]] || exit 1
echo "${commit}"
`,
      );
      const env = {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GITHUB_EVENT_SHA: commit,
        GITHUB_OUTPUT: path.join(tempDir, "outputs"),
        INPUT_DRY_RUN: "true",
        RELEASE_TAG: "v1.2.3",
      };
      await execFileWithOutput("bash", ["-c", script!], { env });
      expect(await fs.readFile(env.GITHUB_OUTPUT, "utf8")).toBe(`commit=${commit}\ntag_object=\n`);
      await expect(
        execFileWithOutput("bash", ["-c", script!], {
          env: { ...env, GITHUB_EVENT_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        }),
      ).rejects.toThrow("does not match the workflow event commit");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
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
    ).toBe("22.23.4");
    expect(
      verifySteps.find((step) => step.uses?.startsWith("pnpm/action-setup@"))?.with?.version,
    ).toBe("11.28.5");
    expect(commands).toContain("npm install -g npm@12.0.2");
    for (const jobName of ["verify", "publish"]) {
      const jobCommands = jobSteps(workflow, jobName)
        .map((step) => step.run)
        .filter((run): run is string => Boolean(run));
      expect(jobCommands).toContain("npm install -g npm@12.0.2");
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
    expect(publishStep).toContain("npm audit signatures --json --include-attestations=true");
    expect(publishStep).toContain('workflow?.path === ".github/workflows/release.yml"');
    expect(publishStep).toContain("dependency?.digest?.gitCommit === process.env.VERIFIED_COMMIT");
    expect(publishStep).toContain("subject?.digest?.sha512 === expectedDigest");
    expect(publishStep).toContain('npm view "$PACKAGE_NAME@latest" version');
    expect(publishStep).toContain('"Refusing to publish " +');
    expect(publishStep).toContain('" because npm latest is newer at " +');
    expect(publishStep).toContain("Downloaded npm tarball does not match expected integrity");
    expect(publishStep).toContain('npm publish "$PACKAGE_TARBALL" --access public --provenance');
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
    for (const steps of [publishSteps, releaseSteps]) {
      expect(
        steps.find((step) => step.run?.includes("revalidate_release_tag()"))?.env
          ?.VERIFIED_TAG_OBJECT,
      ).toBe("${{ needs.verify.outputs.tag_object }}");
    }
    for (const script of [publishStep, releaseStep]) {
      expect(script).toContain('"$GITHUB_EVENT_SHA" != "$VERIFIED_COMMIT"');
      expect(script).toContain("git ls-remote --exit-code");
      expect(script).toContain('"$remote_commit" != "$VERIFIED_COMMIT"');
      expect(script).toContain('"$remote_tag_object" != "$VERIFIED_TAG_OBJECT"');
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
    await expect(
      runPublishStep(publishStep ?? "", {
        MOCK_TAG_RACE_AFTER_EXISTING: "1",
        MOCK_VIEW_RESULT: "matching",
      }),
    ).rejects.toThrow("resolves to bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await expect(
      runGithubReleaseStep(releaseStep ?? "", "stable", {
        MOCK_TAG_RACE_AFTER_LOOKUP: "1",
      }),
    ).rejects.toThrow("resolves to bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("rejects same-commit tag replacements on new and existing publication paths", async () => {
    const workflow = await readWorkflow();
    const publish = jobSteps(workflow, "publish").find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    const release = jobSteps(workflow, "github-release").find(
      (step) => step.name === "Create GitHub release",
    )?.run;
    const replacement = "object is eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await expect(
      runPublishStep(publish ?? "", {
        MOCK_TAG_OBJECT_RACE: "1",
        MOCK_TAG_RACE_AFTER_LOOKUP: "1",
      }),
    ).rejects.toThrow(replacement);
    await expect(
      runPublishStep(publish ?? "", {
        MOCK_TAG_OBJECT_RACE: "1",
        MOCK_TAG_RACE_AFTER_EXISTING: "1",
        MOCK_VIEW_RESULT: "matching",
      }),
    ).rejects.toThrow(replacement);
    for (const state of ["missing", "stable"]) {
      await expect(
        runGithubReleaseStep(release ?? "", state, {
          MOCK_TAG_OBJECT_RACE: "1",
          MOCK_TAG_RACE_AFTER_LOOKUP: "1",
        }),
      ).rejects.toThrow(replacement);
    }
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
    expect(stableCalls).toHaveLength(2);
    expect(stableCalls[0]).toContain("release view v1.2.3");
    expect(stableCalls[1]).toContain("git ls-remote --exit-code");

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

  it("publishes the exact versioned changelog with npm verification links", async () => {
    const workflow = await readWorkflow();
    const steps = jobSteps(workflow, "github-release");
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ needs.verify.outputs.commit }}");
    const script = extractNodeHeredoc(
      steps.find((step) => step.name === "Prepare release notes")?.run,
    );
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-release-notes-"));
    const section = "**Highlights:** New version flag.\n\n- Add --version.\n- Security fix.";
    const run = async (changelog: string): Promise<void> => {
      await fs.writeFile(path.join(tempDir, "CHANGELOG.md"), changelog);
      await execFileWithOutput(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: tempDir,
        env: {
          ...process.env,
          RELEASE_VERSION: "1.2.3",
          PACKAGE_NAME: "@openclaw/crabline",
          PACKAGE_INTEGRITY: PUBLISH_PACKAGE_INTEGRITY,
          GITHUB_REPOSITORY: "openclaw/crabline",
          GITHUB_RUN_ID: "123",
          RUNNER_TEMP: tempDir,
        },
      });
    };
    try {
      await run(
        `# Changelog\n\n## Unreleased\n\n## 1.2.3 - 2026-10-23\n\n${section}\n\n## 1.2.2 - 2026-10-01\n\n- Older fix.\n`,
      );
      const notes = await fs.readFile(path.join(tempDir, "release-notes.md"), "utf8");
      expect(notes).toBe(
        `${section}\n\n### npm package\n\n` +
          "- [@openclaw/crabline@1.2.3](https://www.npmjs.com/package/@openclaw/crabline/v/1.2.3)\n" +
          "- [Registry tarball](https://registry.npmjs.org/@openclaw/crabline/-/crabline-1.2.3.tgz)\n" +
          `- Integrity: \`${PUBLISH_PACKAGE_INTEGRITY}\`\n` +
          "- [Release workflow](https://github.com/openclaw/crabline/actions/runs/123)\n",
      );
      await expect(run("## Unreleased\n\n- Pending.\n")).rejects.toThrow(
        "Expected exactly one changelog section",
      );
      await expect(run("## 1.2.3 - 2026-10-23\n\n")).rejects.toThrow("Empty changelog");
      await expect(
        run("## 1.2.3 - 2026-10-23\n\n- One.\n\n## 1.2.3 - 2026-10-23\n\n- Two.\n"),
      ).rejects.toThrow("Expected exactly one changelog section");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
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
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    );
    expect(contents).not.toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v6",
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
        .filter((command) => command !== "npm install -g npm@12.0.2")
        .some((command) => /\b(?:pnpm|build|test|pack)\b/u.test(command)),
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
    await expect(runMetadataCheck(script, "## 1.2.3 - 2024-02-29\n")).resolves.toBeUndefined();
    for (const invalidDate of ["2025-02-29", "2026-02-30", "2026-00-10", "2026-13-01"]) {
      await expect(runMetadataCheck(script, `## 1.2.3 - ${invalidDate}\n`)).rejects.toThrow(
        CHANGELOG_HEADING_ERROR,
      );
    }
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
      "install --ignore-scripts --no-audit --no-fund @openclaw/crabline@1.2.3",
      "audit signatures --json --include-attestations=true",
      "view @openclaw/crabline@1.2.3 dist.integrity",
      "view @openclaw/crabline@1.2.3 version",
      "install --ignore-scripts --no-audit --no-fund @openclaw/crabline@1.2.3",
      "audit signatures --json --include-attestations=true",
      expect.stringContaining("git ls-remote --exit-code"),
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
    ).rejects.toThrow(PROVENANCE_MISMATCH_ERROR);
    await expect(
      runPublishStep(publishStep, {
        MOCK_PROVENANCE_RESULT: "unsupported",
        MOCK_VIEW_RESULT: "matching",
      }),
    ).rejects.toThrow(PROVENANCE_MISMATCH_ERROR);
    for (const provenanceResult of [
      "wrong-commit",
      "wrong-repository",
      "wrong-workflow",
      "wrong-ref",
      "wrong-subject",
    ]) {
      await expect(
        runPublishStep(publishStep, {
          MOCK_PROVENANCE_RESULT: provenanceResult,
          MOCK_VIEW_RESULT: "matching",
        }),
      ).rejects.toThrow(PROVENANCE_MISMATCH_ERROR);
    }
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
      "install --ignore-scripts --no-audit --no-fund @openclaw/crabline@1.2.3",
      "audit signatures --json --include-attestations=true",
      expect.stringContaining("git ls-remote --exit-code"),
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
  }, 20_000);

  it("waits for delayed registry visibility without publishing twice", async () => {
    const workflow = await readWorkflow();
    const publishStep = jobSteps(workflow, "publish").find(
      (step) => step.name === "Publish package with npm provenance",
    )?.run;
    if (!publishStep) {
      throw new Error("Release workflow is missing its npm publish step.");
    }

    const calls = await runPublishStep(publishStep, {
      MOCK_VIEW_DELAY_SECONDS: "90",
      MOCK_VIEW_RESULT: "after-publish",
    });
    expect(calls.filter((call) => call.startsWith("publish "))).toHaveLength(1);
    expect(calls).toContain("audit signatures --json --include-attestations=true");
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
    ).rejects.toThrow(PROVENANCE_MISMATCH_ERROR);
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

type ReleaseTagFixture = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  commit: string;
  otherCommit: string;
  key: string;
  secondKey: string;
  unknownKey: string;
  git: (...args: string[]) => Promise<string>;
  sign: (key: string, target?: string) => Promise<string>;
};

async function withReleaseTagFixture(
  run: (fixture: ReleaseTagFixture) => Promise<void>,
): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-signed-release-"));
  try {
    const globalConfig = path.join(cwd, "empty-gitconfig");
    await fs.writeFile(globalConfig, "");
    const env = {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = async (...args: string[]): Promise<string> =>
      (await execFileAsync("git", args, { cwd, env })).stdout.trim();
    await git("init", "-q");
    await git("config", "user.name", "Release fixture");
    await git("config", "user.email", "release@example.invalid");
    await git("config", "core.hooksPath", "/dev/null");
    await git("config", "gpg.format", "ssh");
    const keys = ["first", "second", "unknown"].map((name) => path.join(cwd, name));
    for (const key of keys) {
      await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { cwd, env });
    }
    const [key, secondKey, unknownKey] = keys as [string, string, string];
    await fs.mkdir(path.join(cwd, ".github"));
    const allowed = await Promise.all(
      [key, secondKey].map(
        async (signer, index) =>
          `signer-${index} namespaces="git" ${await fs.readFile(`${signer}.pub`, "utf8")}`,
      ),
    );
    await fs.writeFile(path.join(cwd, ".github/release-allowed-signers"), allowed.join(""));
    await git("add", ".github/release-allowed-signers");
    await git("commit", "-m", "fixture target");
    const commit = await git("rev-parse", "HEAD");
    await git("commit", "--allow-empty", "-m", "other target");
    const otherCommit = await git("rev-parse", "HEAD");
    await git("checkout", "--detach", commit);
    const sign = (signer: string, target = commit) =>
      git(
        "-c",
        `user.signingkey=${signer}`,
        "tag",
        "-f",
        "-s",
        "v1.2.3",
        target,
        "-m",
        "release fixture",
      );
    await sign(key);
    await run({ cwd, env, commit, otherCommit, key, secondKey, unknownKey, git, sign });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

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
  ref: { dryRun?: boolean; eventName?: string; refName: string; refType: string } = {
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
        GITHUB_EVENT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REF_NAME: ref.refName,
        GITHUB_REF_TYPE: ref.refType,
        INPUT_TAG: tag,
        INPUT_DRY_RUN: String(ref.dryRun ?? false),
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
remote_object="dddddddddddddddddddddddddddddddddddddddd"
if [[ -f "$MOCK_TAG_RACE" ]]; then
  if [[ "\${MOCK_TAG_OBJECT_RACE:-0}" -eq 1 ]]; then
    remote_object="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  else
    remote_commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  fi
fi
printf '%s\\trefs/tags/v1.2.3\\n' "$remote_object"
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
        VERIFIED_TAG_OBJECT: "dddddddddddddddddddddddddddddddddddddddd",
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
  const elapsedPath = path.join(tempDir, "elapsed");
  const provenanceCountPath = path.join(tempDir, "provenance-count");
  const provenanceDir = path.join(tempDir, "provenance");
  const racePath = path.join(tempDir, "tag-raced");
  const releaseDir = path.join(tempDir, "release");

  try {
    await Promise.all([fs.mkdir(binDir), fs.mkdir(provenanceDir), fs.mkdir(releaseDir)]);
    await fs.writeFile(path.join(releaseDir, "crabline-1.2.3.tgz"), PUBLISH_TARBALL_CONTENTS);
    const provenanceResults = {
      matching: createAuditResult(),
      missing: { verified: [] },
      unsupported: createAuditResult({
        predicateType: "https://example.invalid/provenance",
      }),
      "wrong-commit": createAuditResult({
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      "wrong-ref": createAuditResult({ ref: "refs/tags/v1.2.2" }),
      "wrong-repository": createAuditResult({
        repository: "https://github.com/example/crabline",
      }),
      "wrong-subject": createAuditResult({ subjectDigest: "0".repeat(128) }),
      "wrong-workflow": createAuditResult({ workflowPath: ".github/workflows/other.yml" }),
    };
    await Promise.all(
      Object.entries(provenanceResults).map(([name, result]) =>
        fs.writeFile(path.join(provenanceDir, `${name}.json`), JSON.stringify(result)),
      ),
    );
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
if [[ "$1" == "install" ]]; then
  exit 0
fi
if [[ "$1 $2" == "audit signatures" ]]; then
  provenance_result="\${MOCK_PROVENANCE_RESULT:-matching}"
  if [[ "$provenance_result" == "transient-once" ]]; then
    provenance_count=0
    if [[ -f "$MOCK_PROVENANCE_COUNT" ]]; then
      provenance_count="$(cat "$MOCK_PROVENANCE_COUNT")"
    fi
    echo "$((provenance_count + 1))" > "$MOCK_PROVENANCE_COUNT"
    if [[ "$provenance_count" -eq 0 ]]; then
      exit 1
    fi
    provenance_result="matching"
  elif [[ "$provenance_result" == "transient" ]]; then
    exit 1
  fi
  cat "$MOCK_PROVENANCE_DIR/$provenance_result.json"
  if [[ "\${MOCK_TAG_RACE_AFTER_EXISTING:-0}" -eq 1 ]]; then
    touch "$MOCK_TAG_RACE"
  fi
  exit 0
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
if [[ "$view_result" == "after-publish" ]]; then
  elapsed=0
  if [[ -f "$MOCK_ELAPSED" ]]; then
    elapsed="$(cat "$MOCK_ELAPSED")"
  fi
  if [[ "$elapsed" -lt "\${MOCK_VIEW_DELAY_SECONDS:-0}" ]]; then
    exit 1
  fi
fi
if [[ "$3" == "version" ]]; then
  case "\${MOCK_VERSION_RESULT:-matching}" in
    matching) echo "$RELEASE_VERSION" ;;
    mismatch) echo "1.2.4" ;;
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
remote_object="dddddddddddddddddddddddddddddddddddddddd"
if [[ -f "$MOCK_TAG_RACE" ]]; then
  if [[ "\${MOCK_TAG_OBJECT_RACE:-0}" -eq 1 ]]; then
    remote_object="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  else
    remote_commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  fi
fi
printf '%s\\trefs/tags/v1.2.3\\n' "$remote_object"
printf '%s\\trefs/tags/v1.2.3^{}\\n' "$remote_commit"
`,
      ),
      writeExecutable(
        path.join(binDir, "sleep"),
        `#!/usr/bin/env bash
set -euo pipefail
elapsed=0
if [[ -f "$MOCK_ELAPSED" ]]; then
  elapsed="$(cat "$MOCK_ELAPSED")"
fi
echo "$((elapsed + $1))" > "$MOCK_ELAPSED"
`,
      ),
    ]);

    await execFileWithOutput("bash", ["-c", script], {
      cwd: tempDir,
      env: {
        ...process.env,
        GITHUB_EVENT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        GITHUB_REPOSITORY: "openclaw/crabline",
        GITHUB_SERVER_URL: "https://github.com",
        MOCK_ELAPSED: elapsedPath,
        MOCK_LOG: logPath,
        MOCK_PUBLISHED: publishedPath,
        MOCK_PROVENANCE_COUNT: provenanceCountPath,
        MOCK_PROVENANCE_DIR: provenanceDir,
        MOCK_TAG_RACE: racePath,
        PACKAGE_INTEGRITY: PUBLISH_PACKAGE_INTEGRITY,
        PACKAGE_NAME: "@openclaw/crabline",
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_TAG: "v1.2.3",
        RELEASE_VERSION: "1.2.3",
        RUNNER_TEMP: tempDir,
        VERIFIED_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        VERIFIED_TAG_OBJECT: "dddddddddddddddddddddddddddddddddddddddd",
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
