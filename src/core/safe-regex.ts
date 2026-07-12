const MAX_INBOUND_REGEX_LENGTH = 512;

type GroupState = {
  hasAlternation: boolean;
  hasQuantifier: boolean;
};

function quantifierEnd(pattern: string, index: number): number | undefined {
  const character = pattern[index];
  if (character === "*" || character === "+" || character === "?") {
    return index + 1;
  }
  if (character !== "{") {
    return undefined;
  }
  const match = /^\{\d+(?:,\d*)?\}/u.exec(pattern.slice(index));
  return match ? index + match[0].length : undefined;
}

export function inboundRegexSafetyError(pattern: string): string | undefined {
  if (pattern.length > MAX_INBOUND_REGEX_LENGTH) {
    return `must contain at most ${MAX_INBOUND_REGEX_LENGTH} characters`;
  }
  if (/\\(?:[1-9]|k<)/u.test(pattern)) {
    return "must not contain backreferences";
  }

  const groups: GroupState[] = [{ hasAlternation: false, hasQuantifier: false }];
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
    if (character === "(") {
      groups.push({ hasAlternation: false, hasQuantifier: false });
      continue;
    }
    if (character === "|") {
      groups.at(-1)!.hasAlternation = true;
      continue;
    }
    if (character === ")") {
      if (groups.length === 1) {
        continue;
      }
      const group = groups.pop()!;
      const end = quantifierEnd(pattern, index + 1);
      if (end !== undefined && (group.hasAlternation || group.hasQuantifier)) {
        return "must not quantify a group containing alternation or another quantifier";
      }
      if (end !== undefined) {
        groups.at(-1)!.hasQuantifier = true;
      }
      continue;
    }
    const end = quantifierEnd(pattern, index);
    if (end !== undefined) {
      if (character === "?" && pattern[index - 1] === "(") {
        continue;
      }
      groups.at(-1)!.hasQuantifier = true;
      index = end - 1;
    }
  }
  return undefined;
}
