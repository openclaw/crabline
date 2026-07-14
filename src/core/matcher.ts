import { extractNonces } from "./nonces.js";
import { compileInboundRegex } from "./safe-regex.js";
import type { InboundEnvelope, InboundMatchConfig } from "../providers/types.js";

const EXACT_ACK_WORD =
  /(?<![\p{ID_Continue}\p{Mark}\p{Cf}])ACK(?![\p{ID_Continue}\p{Mark}\p{Cf}])/gu;
const ACK_SEPARATOR = /[\p{White_Space}\p{P}\p{S}]/u;
const IDENTIFIER_CONTINUATION = /[a-z0-9-]/iu;

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
    const followingCharacter = text[offset + nonce.length];
    if (
      text.startsWith(nonce, offset) &&
      (!followingCharacter || !IDENTIFIER_CONTINUATION.test(followingCharacter))
    ) {
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
  const extractedNonces = extractNonces(text);

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
