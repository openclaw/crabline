const MAX_INBOUND_REGEX_LENGTH = 512;
const MAX_BOUNDED_REPETITION = 100;

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
    if (character === "*" || character === "+") {
      return "must not contain unbounded quantifiers";
    }
    if (character !== "{") {
      continue;
    }
    const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(index));
    if (!match) {
      continue;
    }
    if (match[2] === "") {
      return "must not contain unbounded quantifiers";
    }
    const maximum = match[2] === undefined ? Number(match[1]) : Number(match[2]);
    if (!Number.isSafeInteger(maximum) || maximum > MAX_BOUNDED_REPETITION) {
      return `must use bounded repetitions no greater than ${MAX_BOUNDED_REPETITION}`;
    }
    index += match[0].length - 1;
  }
  return undefined;
}
