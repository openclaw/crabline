import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  run?: string;
  uses?: string;
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

    expect(commands).toContain("go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7");
  });

  it("pins CodeQL actions to immutable revisions", async () => {
    const workflow = await readWorkflow(".github/workflows/codeql.yml");
    const actionRefs = Object.values(workflow.jobs ?? {}).flatMap(
      (job) => job.steps?.map((step) => step.uses).filter(Boolean) ?? [],
    );

    expect(actionRefs).not.toEqual([]);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
    }
  });
});
