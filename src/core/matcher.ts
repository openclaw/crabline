import { extractNonces } from "./nonces.js";
import { compileInboundRegex } from "./safe-regex.js";
import type { InboundEnvelope, InboundMatchConfig } from "../providers/types.js";

const EXACT_ACK_WORD =
  /(?<![\p{ID_Continue}\p{Mark}\p{Cf}])ACK(?![\p{ID_Continue}\p{Mark}\p{Cf}])/gu;
const ACK_SEPARATOR = /[\p{White_Space}\p{P}\p{S}]/u;
const IDENTIFIER_CONTINUATION = /[\p{ID_Continue}\p{Mark}\p{Cf}-]/u;

function characterBefore(text: string, offset: number): string | undefined {
  if (offset === 0) {
    return undefined;
  }
  const previous = text.charCodeAt(offset - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && offset > 1) {
    const leading = text.charCodeAt(offset - 2);
    if (leading >= 0xd800 && leading <= 0xdbff) {
      return text.slice(offset - 2, offset);
    }
  }
  return text[offset - 1];
}

function isCanonicalNonceOccurrence(text: string, offset: number, nonce: string): boolean {
  const precedingCharacter = characterBefore(text, offset);
  const followingOffset = offset + nonce.length;
  const followingCharacter =
    followingOffset < text.length
      ? String.fromCodePoint(text.codePointAt(followingOffset)!)
      : undefined;
  return (
    (!precedingCharacter || !IDENTIFIER_CONTINUATION.test(precedingCharacter)) &&
    (!followingCharacter || !IDENTIFIER_CONTINUATION.test(followingCharacter))
  );
}

function extractCanonicalNonces(text: string): string[] {
  let searchOffset = 0;
  return extractNonces(text).filter((nonce) => {
    const offset = text.indexOf(nonce, searchOffset);
    if (offset < 0) {
      return false;
    }
    searchOffset = offset + nonce.length;
    return isCanonicalNonceOccurrence(text, offset, nonce);
  });
}

function hasAcknowledgementForNonce(text: string, nonce: string): boolean {
  for (const match of text.matchAll(EXACT_ACK_WORD)) {
    let offset = match.index + match[0].length;
    while (offset < text.length) {
      const character = String.fromCodePoint(text.codePointAt(offset)!);
      if (!ACK_SEPARATOR.test(character)) {
        break;
      }
      offset += character.length;
    }
    if (text.startsWith(nonce, offset) && isCanonicalNonceOccurrence(text, offset, nonce)) {
      return true;
    }
  }
  return false;
}

export function matchesInbound(
  envelope: InboundEnvelope,
  config: InboundMatchConfig,
  nonce: string,
  options?: { requireAcknowledgement?: boolean },
): boolean {
  if (config.author !== "any" && envelope.author !== config.author) {
    return false;
  }

  const text = envelope.text ?? "";
  const extractedNonces = extractCanonicalNonces(text);

  if (
    options?.requireAcknowledgement &&
    (!extractedNonces.includes(nonce) || !hasAcknowledgementForNonce(text, nonce))
  ) {
    return false;
  }

  if (config.nonce !== "ignore") {
    if (extractedNonces.length === 0) {
      return false;
    }

    if (config.nonce === "exact" && extractedNonces[0] !== nonce) {
      return false;
    }

    if (config.nonce === "contains" && !extractedNonces.includes(nonce)) {
      return false;
    }
  }

  if (!config.pattern) {
    return true;
  }

  if (config.strategy === "exact") {
    return text === config.pattern;
  }

  if (config.strategy === "regex") {
    return compileInboundRegex(config.pattern).test(text);
  }

  return text.includes(config.pattern);
}
