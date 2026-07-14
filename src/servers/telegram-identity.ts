import { createHash } from "node:crypto";

export const TELEGRAM_NATIVE_CHAT_ID_MAX = (1n << 52n) - 1n;
export const TELEGRAM_BOT_USERNAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/u;
export const TELEGRAM_CHAT_USERNAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/u;

const TELEGRAM_SYNTHETIC_ID_RANGE = 1n << 50n;
const TELEGRAM_USERNAME_ID_BASE = TELEGRAM_NATIVE_CHAT_ID_MAX - TELEGRAM_SYNTHETIC_ID_RANGE + 1n;

export function canonicalizeTelegramUsername(value: string): string | undefined {
  const username = value.trim();
  return TELEGRAM_CHAT_USERNAME_PATTERN.test(username) ? username.toLowerCase() : undefined;
}

export function telegramUsernameChatId(value: string): number | undefined {
  const username = canonicalizeTelegramUsername(value);
  if (!username) {
    return undefined;
  }
  const hash = createHash("sha256").update(username).digest();
  return Number(
    -(TELEGRAM_USERNAME_ID_BASE + (hash.readBigUInt64BE() % TELEGRAM_SYNTHETIC_ID_RANGE)),
  );
}

export function isTelegramUsernameChatId(value: number): boolean {
  if (!Number.isSafeInteger(value) || value >= 0) {
    return false;
  }
  const magnitude = BigInt(-value);
  return magnitude >= TELEGRAM_USERNAME_ID_BASE && magnitude <= TELEGRAM_NATIVE_CHAT_ID_MAX;
}
