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
  jobs?: Record<
    string,
    {
      container?: string | { image?: string };
      services?: Record<string, string | { image?: string }>;
      steps?: WorkflowStep[];
      uses?: string;
    }
  >;
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
    const steps = workflow.jobs?.verify?.steps ?? [];
    const setupGoIndex = steps.findIndex((step) => step.uses?.startsWith("actions/setup-go@"));
    const actionlintIndex = steps.findIndex((step) =>
      step.run?.includes("github.com/rhysd/actionlint/cmd/actionlint"),
    );

    expect(steps[setupGoIndex]).toEqual({
      uses: "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16",
      with: {
        "cache-dependency-path": "tools/go.sum",
        "go-version-file": "tools/go.mod",
      },
    });
    expect(setupGoIndex).toBeLessThan(actionlintIndex);
    expect(steps[actionlintIndex]?.run).toBe(
      "cd tools && " +
        "find ../.github/workflows -type f " +
        "\\( -name '*.yml' -o -name '*.yaml' \\) " +
        "-exec " +
        "go run github.com/rhysd/actionlint/cmd/actionlint " +
        "-config-file ../.github/actionlint.yaml " +
        '-ignore \'unexpected key "queue" for "concurrency" section\' ' +
        "{} +",
    );
  });

  it("uses the package manager that enforces the development Node floor", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const setupStep = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("pnpm/action-setup@"));

    expect(setupStep?.with?.version).toBe("11.13.0");
  });

  it("pins every external workflow action and image to immutable revisions", async () => {
    const actionRefs = await collectExternalActionRefs(process.cwd());

    expect(actionRefs).not.toEqual([]);
    for (const actionRef of actionRefs) {
      expect(isImmutableActionRef(actionRef)).toBe(true);
    }
  });

  it("distinguishes local reusable workflows from local action steps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-action-pins-"));
    try {
      await Promise.all([
        fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true }),
        fs.mkdir(path.join(root, ".github", "actions", "example"), { recursive: true }),
        fs.mkdir(path.join(root, ".github", "actions", "container"), { recursive: true }),
        fs.mkdir(path.join(root, "ci", "outside"), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(
          path.join(root, ".github", "workflows", "reusable.yml"),
          [
            "jobs:",
            "  local:",
            "    uses: ./.github/workflows/local.yml",
            "  external:",
            "    uses: owner/repository/.github/workflows/check.yml@main",
            "  containerized:",
            "    runs-on: ubuntu-latest",
            "    container:",
            "      image: ghcr.io/owner/runtime:latest",
            "    services:",
            "      database:",
            "        image: postgres:17",
            "    steps:",
            "      - run: echo ok",
            "      - uses: ./ci/outside",
          ].join("\n"),
        ),
        fs.writeFile(
          path.join(root, ".github", "workflows", "local.yml"),
          [
            "jobs:",
            "  nested:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - uses: owner/local-workflow-action@v3",
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
        fs.writeFile(
          path.join(root, "ci", "outside", "action.yml"),
          ["runs:", "  using: composite", "  steps:", "    - uses: owner/outside@v2"].join("\n"),
        ),
      ]);

      const actionRefs = await collectExternalActionRefs(root);
      expect(actionRefs.toSorted()).toEqual(
        [
          "owner/repository/.github/workflows/check.yml@main",
          "owner/local-workflow-action@v3",
          "docker://ghcr.io/owner/runtime:latest",
          "docker://postgres:17",
          "owner/action@v1",
          "owner/outside@v2",
          "docker://alpine:3.20",
          `docker://ghcr.io/owner/action@sha256:${"0".repeat(64)}`,
          "docker://busybox:1.37",
        ].toSorted(),
      );
      expect(actionRefs.filter((actionRef) => !isImmutableActionRef(actionRef)).toSorted()).toEqual(
        [
          "owner/repository/.github/workflows/check.yml@main",
          "owner/local-workflow-action@v3",
          "docker://ghcr.io/owner/runtime:latest",
          "docker://postgres:17",
          "owner/action@v1",
          "owner/outside@v2",
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
    expect(dependencyReview).toContain("      - tools/go.mod");
    expect(dependencyReview).toContain("      - tools/go.sum");
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
    expect(codeowners).toContain("/.github/pull_request_template.md @openclaw/openclaw-secops");
    expect(codeowners).toContain("/AGENTS.md @openclaw/openclaw-secops");
    expect(codeowners).toContain("/tools/ @openclaw/openclaw-secops");
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
        return Object.values(workflow.jobs ?? {}).map((job) => {
          const containerImage = workflowImage(job.container);
          const serviceImages = Object.values(job.services ?? {}).flatMap((service) => {
            const image = workflowImage(service);
            return image ? [image] : [];
          });
          const stepRefs = job.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [];
          return {
            external: [
              ...(job.uses && !job.uses.startsWith("./") ? [job.uses] : []),
              ...(containerImage ? [containerImage] : []),
              ...serviceImages,
              ...stepRefs.filter((uses) => !uses.startsWith("./")),
            ],
            localActions: stepRefs.filter((uses) => uses.startsWith("./")),
          };
        });
      }),
    )
  ).flat();

  const externalRefs = workflowRefs.flatMap((refs) => refs.external);
  const actionFiles = await listYamlFiles(path.join(root, ".github", "actions"));
  for (const localRef of workflowRefs.flatMap((refs) => refs.localActions)) {
    actionFiles.push(await resolveLocalActionManifest(root, localRef));
  }

  const pending = [...new Set(actionFiles)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.shift()!;
    if (visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    const action = parse(await fs.readFile(filePath, "utf8")) as CompositeAction;
    const refs =
      action.runs?.using === "composite"
        ? (action.runs.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [])
        : action.runs?.using === "docker" && action.runs.image?.startsWith("docker://")
          ? [action.runs.image]
          : [];
    for (const uses of refs) {
      if (uses.startsWith("./")) {
        pending.push(await resolveLocalActionManifest(root, uses));
      } else {
        externalRefs.push(uses);
      }
    }
  }

  return externalRefs;
}

async function resolveLocalActionManifest(root: string, uses: string): Promise<string> {
  const resolved = path.resolve(root, uses.slice(2));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Local action escapes the repository: ${uses}`);
  }
  for (const fileName of ["action.yml", "action.yaml"]) {
    const manifestPath = path.join(resolved, fileName);
    try {
      if ((await fs.stat(manifestPath)).isFile()) {
        return manifestPath;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`Local action manifest is missing: ${uses}`);
}

function workflowImage(value: string | { image?: string } | undefined): string | undefined {
  const image = typeof value === "string" ? value : value?.image;
  return image ? `docker://${image}` : undefined;
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
