import { verify, type KeyObject } from "node:crypto";

type JwtHeader = {
  alg: string;
  kid: string;
};

export type JwtClaims = Record<string, unknown>;

export type RemoteJwtKeySet<T> = {
  expiresAt: number;
  values: readonly T[];
};

const DEFAULT_KEY_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_UNKNOWN_KEY_COOLDOWN_MS = 30_000;
const MAX_HTTP_CACHE_AGE_SECONDS = 24 * 60 * 60;
const MAX_NEGATIVE_KEY_IDS = 128;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeBase64UrlPart(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} must use unpadded base64url encoding.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new Error(`${label} must use canonical base64url encoding.`);
  }
  return decoded;
}

function decodeJsonPart(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(UTF8_DECODER.decode(decodeBase64UrlPart(value, "JWT part")));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("JWT part must be a JSON object.");
  }
  return decoded as Record<string, unknown>;
}

function readHeader(value: Record<string, unknown>): JwtHeader {
  if (value.alg !== "RS256" || typeof value.kid !== "string" || !value.kid) {
    throw new Error("JWT must use RS256 and include a key id.");
  }
  return { alg: value.alg, kid: value.kid };
}

function hasAudience(claim: unknown, expected: string): boolean {
  return (
    claim === expected ||
    (Array.isArray(claim) &&
      claim.every((candidate): candidate is string => typeof candidate === "string") &&
      claim.includes(expected))
  );
}

function numericClaim(claims: JwtClaims, name: string, required = false): number | undefined {
  if (!(name in claims)) {
    if (required) {
      throw new Error(`JWT ${name} claim is required.`);
    }
    return undefined;
  }
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`JWT ${name} claim must be a finite number.`);
  }
  return value;
}

export function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "");
  return match?.[1];
}

function splitCacheControlDirectives(value: string): string[] {
  const directives: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      directives.push(value.slice(start, index));
      start = index + 1;
    }
  }
  directives.push(value.slice(start));
  return directives;
}

function cacheControlDirectiveName(value: string): string | undefined {
  return /^[ \t]*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)/u.exec(value)?.[1]?.toLowerCase();
}

export function resolveHttpCacheExpiry(response: Response, now: number): number {
  const cacheControl = response.headers.get("cache-control");
  if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:=|,|$))/iu.test(cacheControl ?? "")) {
    return now;
  }
  const ageHeader = response.headers.get("age");
  const ageSeconds = ageHeader && /^\d+$/u.test(ageHeader) ? Number.parseInt(ageHeader, 10) : 0;
  const maxAgeDirectives = splitCacheControlDirectives(cacheControl ?? "").filter(
    (directive) => cacheControlDirectiveName(directive) === "max-age",
  );
  if (maxAgeDirectives.length > 0) {
    if (maxAgeDirectives.length !== 1) {
      return now;
    }
    const maxAge = /^[ \t]*max-age[ \t]*=[ \t]*(?:"(\d+)"|(\d+))[ \t]*$/iu.exec(
      maxAgeDirectives[0]!,
    );
    if (!maxAge) {
      return now;
    }
    const maxAgeSeconds = Number(maxAge[1] ?? maxAge[2]);
    if (!Number.isSafeInteger(maxAgeSeconds)) {
      return now;
    }
    return (
      now + Math.min(MAX_HTTP_CACHE_AGE_SECONDS, Math.max(0, maxAgeSeconds - ageSeconds)) * 1_000
    );
  }
  const expiresHeader = response.headers.get("expires");
  if (expiresHeader === null) {
    return now + Math.max(0, 60 * 60 - ageSeconds) * 1_000;
  }
  const expires = Date.parse(expiresHeader);
  return Number.isFinite(expires) && expires > now
    ? Math.min(expires, now + MAX_HTTP_CACHE_AGE_SECONDS * 1_000)
    : now;
}

export function createCachedJwtKeyResolver<T>(params: {
  fetchKeys(signal: AbortSignal): Promise<RemoteJwtKeySet<T>>;
  keyId(value: T): string | undefined;
  now?: (() => number) | undefined;
  refreshCooldownMs?: number | undefined;
  timeoutMs?: number | undefined;
  unknownKeyMessage: string;
}) {
  const now = params.now ?? Date.now;
  const refreshCooldownMs = params.refreshCooldownMs ?? DEFAULT_UNKNOWN_KEY_COOLDOWN_MS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_KEY_FETCH_TIMEOUT_MS;
  let cached: RemoteJwtKeySet<T> | undefined;
  let fetchInFlight: Promise<RemoteJwtKeySet<T>> | undefined;
  let refreshInFlight: Promise<RemoteJwtKeySet<T>> | undefined;
  let refreshCooldownUntil = 0;
  let fetchFailureCooldownUntil = 0;
  let fetchFailureError: unknown;
  const negativeKeyIds = new Map<string, number>();

  const rejectUnknownKey = (kid: string, expiresAt: number): never => {
    for (const [candidate, candidateExpiry] of negativeKeyIds) {
      if (candidateExpiry <= now()) {
        negativeKeyIds.delete(candidate);
      }
    }
    if (negativeKeyIds.size >= MAX_NEGATIVE_KEY_IDS) {
      const oldest = negativeKeyIds.keys().next().value;
      if (oldest) {
        negativeKeyIds.delete(oldest);
      }
    }
    negativeKeyIds.set(kid, expiresAt);
    throw new Error(params.unknownKeyMessage);
  };

  const fetchKeys = async (): Promise<RemoteJwtKeySet<T>> => {
    if (fetchInFlight) {
      return await fetchInFlight;
    }
    if (fetchFailureCooldownUntil > now()) {
      throw fetchFailureError;
    }
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("JWT signing key fetch timed out."));
      }, timeoutMs);
    });
    const keyFetch = Promise.resolve().then(() => params.fetchKeys(controller.signal));
    fetchInFlight = Promise.race([keyFetch, timedOut])
      .then((keySet) => {
        cached = keySet.expiresAt > now() ? keySet : undefined;
        fetchFailureCooldownUntil = 0;
        fetchFailureError = undefined;
        for (const value of keySet.values) {
          const keyId = params.keyId(value);
          if (keyId) {
            negativeKeyIds.delete(keyId);
          }
        }
        return keySet;
      })
      .catch((error: unknown) => {
        fetchFailureCooldownUntil = now() + refreshCooldownMs;
        fetchFailureError = error;
        throw error;
      })
      .finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
        fetchInFlight = undefined;
      });
    return await fetchInFlight;
  };

  return async (header: JwtHeader): Promise<T> => {
    const currentTime = now();
    const freshCache = cached && cached.expiresAt > currentTime ? cached : undefined;
    if (!freshCache && cached) {
      const refreshed = await fetchKeys();
      const refreshedKey = refreshed.values.find(
        (candidate) => params.keyId(candidate) === header.kid,
      );
      if (refreshedKey) {
        return refreshedKey;
      }
      refreshCooldownUntil = now() + refreshCooldownMs;
      return rejectUnknownKey(header.kid, refreshCooldownUntil);
    }

    const negativeExpiry = negativeKeyIds.get(header.kid);
    if (negativeExpiry && negativeExpiry > currentTime) {
      throw new Error(params.unknownKeyMessage);
    }
    negativeKeyIds.delete(header.kid);

    const keySet = freshCache ?? (await fetchKeys());
    const key = keySet.values.find((candidate) => params.keyId(candidate) === header.kid);
    if (key) {
      return key;
    }

    if (!freshCache) {
      return rejectUnknownKey(header.kid, now() + refreshCooldownMs);
    }

    let refreshed: RemoteJwtKeySet<T>;
    if (refreshInFlight) {
      refreshed = await refreshInFlight;
    } else {
      if (refreshCooldownUntil > now()) {
        return rejectUnknownKey(header.kid, refreshCooldownUntil);
      }
      refreshInFlight = Promise.resolve()
        .then(fetchKeys)
        .then(
          (refreshedKeySet) => {
            refreshCooldownUntil = now() + refreshCooldownMs;
            return refreshedKeySet;
          },
          (error: unknown) => {
            refreshCooldownUntil = now() + refreshCooldownMs;
            throw error;
          },
        )
        .finally(() => {
          refreshInFlight = undefined;
        });
      refreshed = await refreshInFlight;
    }

    const rotatedKey = refreshed.values.find((candidate) => params.keyId(candidate) === header.kid);
    if (!rotatedKey) {
      return rejectUnknownKey(header.kid, refreshCooldownUntil);
    }
    return rotatedKey;
  };
}

export async function verifySignedJwt(params: {
  audience: string;
  clockSkewSeconds?: number | undefined;
  issuers: readonly string[];
  now?: (() => number) | undefined;
  resolveKey(header: JwtHeader): Promise<KeyObject>;
  token: string;
}): Promise<JwtClaims> {
  const parts = params.token.split(".");
  if (parts.length !== 3) {
    throw new Error("JWT must contain three parts.");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = readHeader(decodeJsonPart(encodedHeader));
  const claims = decodeJsonPart(encodedClaims);
  const key = await params.resolveKey(header);
  const signature = decodeBase64UrlPart(encodedSignature, "JWT signature");
  if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, signature)) {
    throw new Error("JWT signature is invalid.");
  }

  if (typeof claims.iss !== "string" || !params.issuers.includes(claims.iss)) {
    throw new Error("JWT issuer is invalid.");
  }
  if (!hasAudience(claims.aud, params.audience)) {
    throw new Error("JWT audience is invalid.");
  }

  const now = Math.floor((params.now?.() ?? Date.now()) / 1000);
  const skew = params.clockSkewSeconds ?? 300;
  if (!Number.isFinite(skew) || skew < 0) {
    throw new Error("JWT clock skew must be a finite non-negative number.");
  }
  const expiresAt = numericClaim(claims, "exp", true)!;
  if (expiresAt <= now - skew) {
    throw new Error("JWT is expired.");
  }
  const notBefore = numericClaim(claims, "nbf");
  if (notBefore !== undefined && notBefore > now + skew) {
    throw new Error("JWT is not active.");
  }

  return claims;
}
