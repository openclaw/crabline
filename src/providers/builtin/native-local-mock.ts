import { createHash, timingSafeEqual } from "node:crypto";
import { CrablineError } from "../../core/errors.js";
import type { NativeIdRule } from "../native-ids.js";
import type { InboundEnvelope } from "../types.js";

export type { NativeIdRule } from "../native-ids.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createSecretVerifier(expected: string): (candidate: string | null) => boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  return (candidate) =>
    candidate !== null &&
    timingSafeEqual(createHash("sha256").update(candidate).digest(), expectedDigest);
}

export function optionalRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

export function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const child = value[key];
  return typeof child === "string" && child.length > 0 ? child : undefined;
}

export function optionalNumberString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const child = value[key];
  return typeof child === "number" || typeof child === "bigint" ? child.toString() : undefined;
}

export function optionalStringish(value: Record<string, unknown>, key: string): string | undefined {
  return optionalString(value, key) ?? optionalNumberString(value, key);
}

export function normalizeAuthor(value: unknown): "assistant" | "system" | "user" | undefined {
  return value === "assistant" || value === "system" || value === "user" ? value : undefined;
}

export function requireNativeInboundId(value: string, rule: NativeIdRule, label: string): string {
  if (!rule.pattern.test(value)) {
    throw new CrablineError(`${label} must be a native ${rule.name} such as ${rule.example}.`, {
      kind: "inbound",
    });
  }
  return value;
}

export function genericMockPayloadWithNativeThread(params: {
  channelRule?: NativeIdRule | undefined;
  payload: Record<string, unknown>;
  threadRule: NativeIdRule;
}) {
  const message = optionalRecord(params.payload, "message");
  const threadId = message
    ? optionalString(message, "threadId")
    : optionalString(params.payload, "threadId");
  if (!threadId) {
    return {
      ...(normalizeAuthor(params.payload.author)
        ? { author: normalizeAuthor(params.payload.author) }
        : {}),
      ...(typeof params.payload.authorIsBot === "boolean"
        ? { authorIsBot: params.payload.authorIsBot }
        : {}),
      ...(optionalString(params.payload, "id") ? { id: optionalString(params.payload, "id") } : {}),
      raw: params.payload.raw ?? params.payload,
      ...(optionalString(params.payload, "text")
        ? { text: optionalString(params.payload, "text") }
        : {}),
    };
  }

  const isValidThread = params.threadRule.pattern.test(threadId);
  const isValidChannel = params.channelRule?.pattern.test(threadId) ?? false;
  if (!isValidThread && !isValidChannel) {
    throw new CrablineError(
      `mock webhook threadId must be a native ${params.threadRule.name}${
        params.channelRule ? ` or ${params.channelRule.name}` : ""
      }.`,
      { kind: "inbound" },
    );
  }

  return {
    ...(normalizeAuthor(params.payload.author)
      ? { author: normalizeAuthor(params.payload.author) }
      : {}),
    ...(typeof params.payload.authorIsBot === "boolean"
      ? { authorIsBot: params.payload.authorIsBot }
      : {}),
    ...(optionalString(params.payload, "id") ? { id: optionalString(params.payload, "id") } : {}),
    ...(message
      ? {
          message: {
            ...(normalizeAuthor(message.author) ? { author: normalizeAuthor(message.author) } : {}),
            ...(typeof message.authorIsBot === "boolean"
              ? { authorIsBot: message.authorIsBot }
              : {}),
            ...(optionalString(message, "id") ? { id: optionalString(message, "id") } : {}),
            ...(message.raw !== undefined ? { raw: message.raw } : {}),
            ...(optionalString(message, "text") ? { text: optionalString(message, "text") } : {}),
            threadId,
          },
        }
      : {}),
    raw: params.payload.raw ?? params.payload,
    ...(optionalString(params.payload, "text")
      ? { text: optionalString(params.payload, "text") }
      : {}),
    threadId,
  };
}

export function authorFromBotFlag(isBot: boolean | undefined): InboundEnvelope["author"] {
  return isBot ? "assistant" : "user";
}
