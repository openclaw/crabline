import pc from "picocolors";
import type { CommandRunResult, SuiteRunResult } from "./run.js";

export function formatRunResultText(result: CommandRunResult | SuiteRunResult): string {
  if ("results" in result) {
    const lines = [
      `${pc.bold("suite")} ${result.totalPassed}/${result.results.length} passed`,
      ...result.results.flatMap((entry) => [
        formatCaseLine(entry),
        ...entry.diagnostics.map((diagnostic) => `  - ${diagnostic}`),
      ]),
    ];
    return lines.join("\n");
  }

  return formatSingleResult(result);
}

export function formatJson(result: unknown): string {
  return JSON.stringify(result === undefined ? null : result, null, 2);
}

function formatSingleResult(result: CommandRunResult): string {
  const lines = [formatCaseLine(result), ...result.diagnostics.map((entry) => `  - ${entry}`)];
  return lines.join("\n");
}

function formatCaseLine(result: CommandRunResult): string {
  const colorize = result.ok ? pc.green : result.failureKind === "timeout" ? pc.yellow : pc.red;
  return `${colorize(result.ok ? "PASS" : "FAIL")} ${result.fixtureId} ${result.mode} ${result.providerId}`;
}
