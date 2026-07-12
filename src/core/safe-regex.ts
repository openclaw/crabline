const MAX_INBOUND_REGEX_LENGTH = 512;

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
    if (
      character === "*" ||
      character === "+" ||
      character === "{" ||
      (character === "?" && pattern[index - 1] !== "(")
    ) {
      return "must not contain repetition operators";
    }
  }
  return undefined;
}
