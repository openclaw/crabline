import type { FixtureDefinition, FixtureMode } from "../config/schema.js";

function modePrefix(mode: FixtureMode): string {
  switch (mode) {
    case "send":
      return "send";
    case "roundtrip":
      return "roundtrip";
    case "agent":
      return "agent";
    case "probe":
      return "probe";
  }
}

export function createOutboundText(fixture: FixtureDefinition, nonce: string): string {
  const prefix = `crabline ${modePrefix(fixture.mode)} ${fixture.id}`;
  if (fixture.mode === "agent") {
    return `${prefix} nonce=${nonce}. Reply with ACK ${nonce}.`;
  }

  return `${prefix} nonce=${nonce}`;
}
