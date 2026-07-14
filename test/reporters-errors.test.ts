import { describe, expect, it } from "vitest";
import { CrablineError, ensureErrorMessage } from "../src/core/errors.js";
import { EXIT_CODES } from "../src/core/exit-codes.js";
import {
  formatJson,
  formatJsonResult,
  formatRunResultText,
  sanitizeTerminalText,
} from "../src/core/reporters.js";

const ansiPattern = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value: string): string => value.replace(ansiPattern, "");

describe("errors and reporters", () => {
  it("maps failure kinds to exit codes", () => {
    const error = new CrablineError("boom", { kind: "auth" });
    expect(error.exitCode).toBe(EXIT_CODES.AUTH);
    expect(error.hasExplicitExitCode).toBe(false);
    expect(ensureErrorMessage(error)).toBe("boom");
    expect(ensureErrorMessage("plain")).toBe("plain");
    const normalizedExit = new CrablineError("failed", { exitCode: EXIT_CODES.SUCCESS });
    expect(normalizedExit.exitCode).toBe(EXIT_CODES.FAILURE);
    expect(normalizedExit.hasExplicitExitCode).toBe(true);
    expect(ensureErrorMessage(Object.create(null))).toBe("Unknown error");
    const numericMessage = new Error("hidden");
    Object.defineProperty(numericMessage, "message", { value: 42 });
    expect(ensureErrorMessage(numericMessage)).toBe("42");
    let changingMessageReads = 0;
    const changingMessage = new Error("hidden");
    Object.defineProperty(changingMessage, "message", {
      get() {
        changingMessageReads += 1;
        if (changingMessageReads > 1) {
          throw new Error("message getter read twice");
        }
        return 42;
      },
    });
    expect(ensureErrorMessage(changingMessage)).toBe("42");
    expect(changingMessageReads).toBe(1);
    let throwingMessageReads = 0;
    const throwingMessage = new Error("hidden");
    Object.defineProperty(throwingMessage, "message", {
      get() {
        throwingMessageReads += 1;
        throw new Error("message getter exploded");
      },
    });
    expect(ensureErrorMessage(throwingMessage)).toBe("Unknown error");
    expect(throwingMessageReads).toBe(1);
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
      requestedFixtureIds: ["fixture", "second"],
      skippedFixtureIds: ["second"],
      totalPassed: 1,
    });
    const inferredSuite = formatRunResultText({
      results: [
        {
          diagnostics: [],
          fixtureId: "fixture",
          mode: "send",
          ok: true,
          providerId: "local",
        },
      ],
      skippedFixtureIds: ["second"],
      totalPassed: 1,
    });

    expect(stripAnsi(single)).toContain("PASS");
    expect(stripAnsi(suite)).toContain("suite 1/2 passed, 1 skipped");
    expect(stripAnsi(inferredSuite)).toContain("suite 1/2 passed, 1 skipped");
    expect(stripAnsi(suite)).toContain("  - accepted");
    expect(stripAnsi(suite)).toContain("SKIP second not run");
    expect(formatJson({ ok: true })).toContain('"ok": true');
    expect(formatJson(undefined)).toBe("null");
    expect(formatJson(Symbol("value"))).toBe("null");
    expect(formatJson(() => undefined)).toBe("null");
  });

  it("escapes visually unsafe Unicode controls without changing parsed JSON values", () => {
    const controls =
      "\u007f\u0080\u0085\u009f\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const output = formatJson({ [controls]: controls });

    expect(output).not.toMatch(
      /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u,
    );
    for (const character of controls) {
      expect(output).toContain(
        String.raw`\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
      );
    }
    expect(JSON.parse(output)).toEqual({ [controls]: controls });
  });

  it("returns a stable error envelope when JSON serialization fails", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwingValue = {
      toJSON() {
        throw new Error("sensitive serialization detail");
      },
    };
    const expected = {
      error: {
        message: "Unable to serialize JSON output.",
      },
      ok: false,
    };
    const expectedOutput = JSON.stringify(expected, null, 2);

    for (const value of [cyclic, { value: 1n }, throwingValue]) {
      const result = formatJsonResult(value);
      const output = result.output;
      expect(result.ok).toBe(false);
      expect(output).toBe(expectedOutput);
      expect(output).not.toContain("sensitive serialization detail");
    }
  });

  it("neutralizes terminal controls in text output", () => {
    const output = formatRunResultText({
      diagnostics: ["first\u001b[2J\rsecond\nthird\u202e"],
      fixtureId: "fixture\u001b]0;owned\u0007",
      mode: "send",
      ok: false,
      providerId: "local",
    });
    const plainOutput = stripAnsi(output);

    expect(plainOutput).not.toContain("\u001b");
    expect(plainOutput).not.toContain("\u0007");
    expect(plainOutput).not.toContain("\r");
    expect(plainOutput).toContain(String.raw`fixture\x1b]0;owned\x07`);
    expect(plainOutput).toContain(String.raw`first\x1b[2J\rsecond`);
    expect(plainOutput).toContain("  - third\\u202e");
    expect(sanitizeTerminalText("line\nbreak", true)).toBe(String.raw`line\nbreak`);
    expect(sanitizeTerminalText("\u061c\u200e\u200f")).toBe(String.raw`\u061c\u200e\u200f`);
  });
});
