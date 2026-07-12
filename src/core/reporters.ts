import pc from "picocolors";
import type { CommandRunResult, SuiteRunResult } from "./run.js";

const BIDI_CONTROL_CODE_POINTS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

export function sanitizeTerminalText(value: string, singleLine = false): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\n") {
      sanitized += singleLine ? String.raw`\n` : "\n";
    } else if (character === "\r") {
      sanitized += String.raw`\r`;
    } else if (character === "\t") {
      sanitized += String.raw`\t`;
    } else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      sanitized += String.raw`\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      BIDI_CONTROL_CODE_POINTS.has(codePoint)
    ) {
      sanitized += String.raw`\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      sanitized += character;
    }
  }
  return sanitized;
}

export function formatRunResultText(result: CommandRunResult | SuiteRunResult): string {
  if ("results" in result) {
    const lines = [
      `${pc.bold("suite")} ${result.totalPassed}/${result.results.length} passed`,
      ...result.results.flatMap((entry) => [
        formatCaseLine(entry),
        ...entry.diagnostics.flatMap(formatDiagnostic),
      ]),
    ];
    return lines.join("\n");
  }

  return formatSingleResult(result);
}

export function formatJson(result: unknown): string {
  return JSON.stringify(result === undefined ? null : result, null, 2) ?? "null";
}

function formatSingleResult(result: CommandRunResult): string {
  const lines = [formatCaseLine(result), ...result.diagnostics.flatMap(formatDiagnostic)];
  return lines.join("\n");
}

function formatDiagnostic(diagnostic: string): string[] {
  return sanitizeTerminalText(diagnostic)
    .split("\n")
    .map((line) => `  - ${line}`);
}

function formatCaseLine(result: CommandRunResult): string {
  const colorize = result.ok ? pc.green : result.failureKind === "timeout" ? pc.yellow : pc.red;
  return `${colorize(result.ok ? "PASS" : "FAIL")} ${sanitizeTerminalText(result.fixtureId, true)} ${sanitizeTerminalText(result.mode, true)} ${sanitizeTerminalText(result.providerId, true)}`;
}
