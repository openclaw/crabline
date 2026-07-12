import { randomBytes } from "node:crypto";

export function createNonce(fixtureId: string): string {
  const timestamp = Date.now().toString(36);
  const entropy = randomBytes(4).toString("hex");
  return `mp-${fixtureId}-${timestamp}-${entropy}`;
}

export function extractNonces(text: string): string[] {
  return text.match(/\bmp-[a-z0-9-]+-[a-z0-9]+-[a-f0-9]{8}\b/gi) ?? [];
}

export function extractNonce(text: string): string | null {
  return extractNonces(text)[0] ?? null;
}
