const MAX_INBOUND_REGEX_LENGTH = 512;

function isEscaped(pattern: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && pattern[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export function inboundRegexSafetyError(pattern: string): string | undefined {
  if (pattern.length > MAX_INBOUND_REGEX_LENGTH) {
    return `must contain at most ${MAX_INBOUND_REGEX_LENGTH} characters`;
  }
  if (/\\(?:[1-9]|k<)/u.test(pattern)) {
    return "must not contain backreferences";
  }

  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) {
      continue;
    }
    if (character === "|") {
      return "must not contain alternation";
    }
    if (
      character === "*" ||
      character === "+" ||
      character === "{" ||
      (character === "?" && (pattern[index - 1] !== "(" || isEscaped(pattern, index - 1)))
    ) {
      return "must not contain repetition operators";
    }
  }
  return undefined;
}
