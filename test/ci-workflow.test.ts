import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[]; uses?: string }>;
  on?: {
    pull_request?: { paths?: string[] };
    push?: { paths?: string[] };
  };
};

type CompositeAction = {
  runs?: {
    image?: string;
    steps?: WorkflowStep[];
    using?: string;
  };
};

async function readWorkflow(filePath: string): Promise<Workflow> {
  return parse(await fs.readFile(filePath, "utf8")) as Workflow;
}

describe("CI workflow hardening", () => {
  it("runs actionlint in the primary CI gate", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const commands = Object.values(workflow.jobs ?? {}).flatMap(
      (job) => job.steps?.map((step) => step.run).filter(Boolean) ?? [],
    );

    expect(commands).toContain(
      "go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 " +
        '-ignore \'unexpected key "queue" for "concurrency" section\'',
    );
  });

  it("pins every external workflow action and image to immutable revisions", async () => {
    const actionRefs = await collectExternalActionRefs(process.cwd());

    expect(actionRefs).not.toEqual([]);
    for (const actionRef of actionRefs) {
      expect(isImmutableActionRef(actionRef)).toBe(true);
    }
  });

  it("inspects reusable workflow jobs and composite action steps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-action-pins-"));
    try {
      await Promise.all([
        fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true }),
        fs.mkdir(path.join(root, ".github", "actions", "example"), { recursive: true }),
        fs.mkdir(path.join(root, ".github", "actions", "container"), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(
          path.join(root, ".github", "workflows", "reusable.yml"),
          [
            "jobs:",
            "  external:",
            "    uses: owner/repository/.github/workflows/check.yml@main",
          ].join("\n"),
        ),
        fs.writeFile(
          path.join(root, ".github", "actions", "example", "action.yml"),
          [
            "runs:",
            "  using: composite",
            "  steps:",
            "    - uses: owner/action@v1",
            "    - uses: docker://alpine:3.20",
            `    - uses: docker://ghcr.io/owner/action@sha256:${"0".repeat(64)}`,
          ].join("\n"),
        ),
        fs.writeFile(
          path.join(root, ".github", "actions", "container", "action.yml"),
          ["runs:", "  using: docker", "  image: docker://busybox:1.37"].join("\n"),
        ),
      ]);

      const actionRefs = await collectExternalActionRefs(root);
      expect(actionRefs.toSorted()).toEqual(
        [
          "owner/repository/.github/workflows/check.yml@main",
          "owner/action@v1",
          "docker://alpine:3.20",
          `docker://ghcr.io/owner/action@sha256:${"0".repeat(64)}`,
          "docker://busybox:1.37",
        ].toSorted(),
      );
      expect(actionRefs.filter((actionRef) => !isImmutableActionRef(actionRef)).toSorted()).toEqual(
        [
          "owner/repository/.github/workflows/check.yml@main",
          "owner/action@v1",
          "docker://alpine:3.20",
          "docker://busybox:1.37",
        ].toSorted(),
      );
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("protects pnpm install-script policy changes", async () => {
    const [codeowners, dependencyReview] = await Promise.all([
      fs.readFile(".github/CODEOWNERS", "utf8"),
      fs.readFile(".github/workflows/dependency-review.yml", "utf8"),
    ]);

    expect(codeowners).toContain("/pnpm-workspace.yaml @openclaw/openclaw-secops");
    expect(dependencyReview).toContain("      - pnpm-workspace.yaml");
  });

  it("protects and scans local action and executable tool changes", async () => {
    const [codeowners, codeqlWorkflow, actionsConfig, typescriptConfig] = await Promise.all([
      fs.readFile(".github/CODEOWNERS", "utf8"),
      readWorkflow(".github/workflows/codeql.yml"),
      fs
        .readFile(".github/codeql/codeql-actions-security.yml", "utf8")
        .then((contents) => parse(contents) as { paths?: string[] }),
      fs
        .readFile(".github/codeql/codeql-typescript-security.yml", "utf8")
        .then((contents) => parse(contents) as { paths?: string[] }),
    ]);

    expect(codeowners).toContain("/.github/actions/ @openclaw/openclaw-secops");
    expect(codeqlWorkflow.on?.push?.paths).toContain(".github/actions/**");
    expect(codeqlWorkflow.on?.pull_request?.paths).toContain(".github/actions/**");
    expect(codeqlWorkflow.on?.push?.paths).toContain("tools/**");
    expect(codeqlWorkflow.on?.pull_request?.paths).toContain("tools/**");
    expect(actionsConfig.paths).toContain(".github/actions");
    expect(typescriptConfig.paths).toContain("tools");
  });

  it("exempts security pull requests from stale automation", async () => {
    const workflow = await readWorkflow(".github/workflows/stale.yml");
    const staleStep = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/stale@"));

    expect(String(staleStep?.with?.["exempt-pr-labels"]).split(",")).toContain("security");
  });
});

async function collectExternalActionRefs(root: string): Promise<string[]> {
  const workflowDirectory = path.join(root, ".github", "workflows");
  const workflowFiles = await listYamlFiles(workflowDirectory);
  const workflowRefs = (
    await Promise.all(
      workflowFiles.map(async (filePath) => {
        const workflow = await readWorkflow(filePath);
        return Object.values(workflow.jobs ?? {}).flatMap((job) => [
          ...(job.uses ? [job.uses] : []),
          ...(job.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? []),
        ]);
      }),
    )
  ).flat();

  const actionFiles = await listYamlFiles(path.join(root, ".github", "actions"));
  const compositeRefs = (
    await Promise.all(
      actionFiles.map(async (filePath) => {
        const action = parse(await fs.readFile(filePath, "utf8")) as CompositeAction;
        if (action.runs?.using === "composite") {
          return action.runs.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [];
        }
        return action.runs?.using === "docker" && action.runs.image?.startsWith("docker://")
          ? [action.runs.image]
          : [];
      }),
    )
  ).flat();

  return [...workflowRefs, ...compositeRefs].filter((uses) => !uses.startsWith("./"));
}

function isImmutableActionRef(actionRef: string): boolean {
  if (actionRef.startsWith("docker://")) {
    return /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/u.test(actionRef);
  }
  return /^[^@\s]+@[0-9a-f]{40}$/u.test(actionRef);
}

async function listYamlFiles(directory: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return (
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return await listYamlFiles(entryPath);
        }
        return /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
      }),
    )
  ).flat();
}
