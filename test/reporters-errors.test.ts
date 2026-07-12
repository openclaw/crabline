import { describe, expect, it } from "vitest";
import { CrablineError, ensureErrorMessage } from "../src/core/errors.js";
import { EXIT_CODES } from "../src/core/exit-codes.js";
import { formatJson, formatRunResultText, sanitizeTerminalText } from "../src/core/reporters.js";

const ansiPattern = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value: string): string => value.replace(ansiPattern, "");

describe("errors and reporters", () => {
  it("maps failure kinds to exit codes", () => {
    const error = new CrablineError("boom", { kind: "auth" });
    expect(error.exitCode).toBe(EXIT_CODES.AUTH);
    expect(ensureErrorMessage(error)).toBe("boom");
    expect(ensureErrorMessage("plain")).toBe("plain");
  });

  it("formats single and suite results", () => {
    const single = formatRunResultText({
      diagnostics: ["accepted"],
      fixtureId: "fixture",
      mode: "send",
      ok: true,
      providerId: "local",
    });
    const suite = formatRunResultText({
      results: [
        {
          diagnostics: ["accepted"],
          fixtureId: "fixture",
          mode: "send",
          ok: true,
          providerId: "local",
        },
      ],
      totalPassed: 1,
    });

    expect(stripAnsi(single)).toContain("PASS");
    expect(stripAnsi(suite)).toContain("suite 1/1 passed");
    expect(stripAnsi(suite)).toContain("  - accepted");
    expect(formatJson({ ok: true })).toContain('"ok": true');
    expect(formatJson(undefined)).toBe("null");
    expect(formatJson(Symbol("value"))).toBe("null");
    expect(formatJson(() => undefined)).toBe("null");
  });

  it("neutralizes terminal controls in text output", () => {
    const output = formatRunResultText({
      diagnostics: ["first\u001b[2J\rsecond\nthird\u202e"],
      fixtureId: "fixture\u001b]0;owned\u0007",
      mode: "send",
      ok: false,
      providerId: "local",
    });

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\r");
    expect(stripAnsi(output)).toContain(String.raw`fixture\x1b]0;owned\x07`);
    expect(output).toContain(String.raw`first\x1b[2J\rsecond`);
    expect(output).toContain("  - third\\u202e");
    expect(sanitizeTerminalText("line\nbreak", true)).toBe(String.raw`line\nbreak`);
    expect(sanitizeTerminalText("\u061c\u200e\u200f")).toBe(String.raw`\u061c\u200e\u200f`);
  });
});
