import { RE2JS } from "re2js";

const MAX_INBOUND_REGEX_LENGTH = 512;

export function inboundRegexSafetyError(pattern: string): string | undefined {
  if (pattern.length > MAX_INBOUND_REGEX_LENGTH) {
    return `must contain at most ${MAX_INBOUND_REGEX_LENGTH} characters`;
  }
  try {
    compileInboundRegex(pattern);
  } catch {
    return "must use syntax supported by the linear-time regex engine";
  }
  return undefined;
}

export function compileInboundRegex(pattern: string): RE2JS {
  if (pattern.length > MAX_INBOUND_REGEX_LENGTH) {
    throw new Error(`Regex must contain at most ${MAX_INBOUND_REGEX_LENGTH} characters.`);
  }
  return RE2JS.compile(RE2JS.translateRegExp(pattern));
}
