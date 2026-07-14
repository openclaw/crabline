import pc from "picocolors";
import type { CommandRunResult, SuiteRunResult } from "./run.js";

const BIDI_CONTROL_CODE_POINTS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const UNSAFE_JSON_CODE_POINTS =
  /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
const JSON_SERIALIZATION_ERROR = `{
  "error": {
    "message": "Unable to serialize JSON output."
  },
  "ok": false
}`;

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
    const skippedFixtureIds = result.skippedFixtureIds ?? [];
    const requestedFixtureCount =
      result.requestedFixtureIds?.length ?? result.results.length + skippedFixtureIds.length;
    const skippedSummary =
      skippedFixtureIds.length > 0 ? `, ${skippedFixtureIds.length} skipped` : "";
    const lines = [
      `${pc.bold("suite")} ${result.totalPassed}/${requestedFixtureCount} passed${skippedSummary}`,
      ...result.results.flatMap((entry) => [
        formatCaseLine(entry),
        ...entry.diagnostics.flatMap(formatDiagnostic),
      ]),
      ...skippedFixtureIds.map(
        (fixtureId) => `${pc.yellow("SKIP")} ${sanitizeTerminalText(fixtureId, true)} not run`,
      ),
    ];
    return lines.join("\n");
  }

  return formatSingleResult(result);
}

export type JsonFormatResult = {
  ok: boolean;
  output: string;
};

export function formatJsonResult(result: unknown): JsonFormatResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result === undefined ? null : result, null, 2);
  } catch {
    return { ok: false, output: JSON_SERIALIZATION_ERROR };
  }
  return {
    ok: true,
    output: (serialized ?? "null").replace(
      UNSAFE_JSON_CODE_POINTS,
      (character) => String.raw`\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    ),
  };
}

export function formatJson(result: unknown): string {
  return formatJsonResult(result).output;
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
