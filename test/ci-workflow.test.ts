import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
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

  it("pins every external workflow action to immutable revisions", async () => {
    const workflowDirectory = ".github/workflows";
    const workflowFiles = (await fs.readdir(workflowDirectory))
      .filter((entry) => /\.ya?ml$/u.test(entry))
      .map((entry) => path.join(workflowDirectory, entry));
    const actionRefs = (
      await Promise.all(
        workflowFiles.map(async (filePath) => {
          const workflow = await readWorkflow(filePath);
          return Object.values(workflow.jobs ?? {}).flatMap(
            (job) =>
              job.steps
                ?.map((step) => step.uses)
                .filter((uses): uses is string => uses !== undefined && !uses.startsWith("./")) ??
              [],
          );
        }),
      )
    ).flat();

    expect(actionRefs).not.toEqual([]);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
    }
  });

  it("exempts security pull requests from stale automation", async () => {
    const workflow = await readWorkflow(".github/workflows/stale.yml");
    const staleStep = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/stale@"));

    expect(String(staleStep?.with?.["exempt-pr-labels"]).split(",")).toContain("security");
  });
});
