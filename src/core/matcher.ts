import { extractNonces } from "./nonces.js";
import type { InboundEnvelope, InboundMatchConfig } from "../providers/types.js";

export function matchesInbound(
  envelope: InboundEnvelope,
  config: InboundMatchConfig,
  nonce: string,
): boolean {
  if (config.author !== "any" && envelope.author !== config.author) {
    return false;
  }

  const text = envelope.text ?? "";
  const extractedNonces = extractNonces(text);

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
    return new RegExp(config.pattern, "u").test(text);
  }

  return text.includes(config.pattern);
}
