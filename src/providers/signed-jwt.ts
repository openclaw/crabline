import { verify, type KeyObject } from "node:crypto";

type JwtHeader = {
  alg: string;
  kid: string;
};

export type JwtClaims = Record<string, unknown>;

function decodeJsonPart(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
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
  return claim === expected || (Array.isArray(claim) && claim.includes(expected));
}

function numericClaim(claims: JwtClaims, name: string): number | undefined {
  const value = claims[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "");
  return match?.[1];
}

export function resolveHttpCacheExpiry(response: Response, now: number): number {
  const cacheControl = response.headers.get("cache-control");
  const maxAge = /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl ?? "");
  if (maxAge) {
    return now + Number(maxAge[1]) * 1_000;
  }
  const expires = Date.parse(response.headers.get("expires") ?? "");
  return Number.isFinite(expires) && expires > now ? expires : now + 60 * 60 * 1_000;
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
  const signature = Buffer.from(encodedSignature, "base64url");
  if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, signature)) {
    throw new Error("JWT signature is invalid.");
  }

  if (!params.issuers.includes(String(claims.iss ?? ""))) {
    throw new Error("JWT issuer is invalid.");
  }
  if (!hasAudience(claims.aud, params.audience)) {
    throw new Error("JWT audience is invalid.");
  }

  const now = Math.floor((params.now?.() ?? Date.now()) / 1000);
  const skew = params.clockSkewSeconds ?? 300;
  const expiresAt = numericClaim(claims, "exp");
  if (expiresAt === undefined || expiresAt < now - skew) {
    throw new Error("JWT is expired.");
  }
  const notBefore = numericClaim(claims, "nbf");
  if (notBefore !== undefined && notBefore > now + skew) {
    throw new Error("JWT is not active.");
  }

  return claims;
}
