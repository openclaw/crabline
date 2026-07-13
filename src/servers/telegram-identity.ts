import { createHash } from "node:crypto";

export const TELEGRAM_USERNAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/u;

export function canonicalizeTelegramUsername(value: string): string | undefined {
  const username = value.trim();
  return TELEGRAM_USERNAME_PATTERN.test(username) ? username.toLowerCase() : undefined;
}

export function telegramUsernameChatId(value: string): number | undefined {
  const username = canonicalizeTelegramUsername(value);
  if (!username) {
    return undefined;
  }
  const hash = createHash("sha256").update(username).digest();
  return -1_000_000_000_000 - (hash.readUIntBE(0, 6) % 10_000_000_000);
}
