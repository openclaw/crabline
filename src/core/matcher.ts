import { extractNonces } from "./nonces.js";
import { compileInboundRegex } from "./safe-regex.js";
import type { InboundEnvelope, InboundMatchConfig } from "../providers/types.js";

const EXACT_ACK_TOKEN =
  /(?<![\p{ID_Continue}\p{Mark}\p{Cf}])ACK(?![\p{ID_Continue}\p{Mark}\p{Cf}])/u;

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
    (!EXACT_ACK_TOKEN.test(text) || !extractedNonces.includes(nonce))
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
