import { randomBytes } from "node:crypto";

const NONCE_ALPHABET = "a-z0-9-";
export const NONCE_FIXTURE_ID_ERROR = "fixture id must contain only letters, numbers, and hyphens";
const INVALID_NONCE_FIXTURE_ID_CHARACTER = new RegExp(`[^${NONCE_ALPHABET}]`, "i");
const NONCE_PATTERN = new RegExp(
  `(?<![${NONCE_ALPHABET}])mp-[${NONCE_ALPHABET}]+-[a-z0-9]+-[a-f0-9]{8}(?![${NONCE_ALPHABET}])`,
  "gi",
);

export function isValidNonceFixtureId(fixtureId: string): boolean {
  return fixtureId.length > 0 && !INVALID_NONCE_FIXTURE_ID_CHARACTER.test(fixtureId);
}

export function createNonce(fixtureId: string): string {
  if (typeof fixtureId !== "string" || !isValidNonceFixtureId(fixtureId)) {
    throw new TypeError(NONCE_FIXTURE_ID_ERROR);
  }

  const timestamp = Date.now().toString(36);
  const entropy = randomBytes(4).toString("hex");
  return `mp-${fixtureId}-${timestamp}-${entropy}`;
}

export function extractNonces(text: string): string[] {
  return text.match(NONCE_PATTERN) ?? [];
}

export function extractNonce(text: string): string | null {
  return extractNonces(text)[0] ?? null;
}
