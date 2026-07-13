import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createCachedJwtKeyResolver,
  resolveHttpCacheExpiry,
  verifySignedJwt,
} from "../src/providers/signed-jwt.js";

function signedJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

describe("signed JWT remote key cache", () => {
  it("requires canonical base64url, numeric nbf, and a future expiry boundary", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_700_000_000_000;
    const verify = (token: string) =>
      verifySignedJwt({
        audience: "crabline",
        clockSkewSeconds: 0,
        issuers: ["issuer"],
        now: () => now,
        resolveKey: async () => keys.publicKey,
        token,
      });
    const claims = {
      aud: "crabline",
      exp: Math.floor(now / 1000) + 1,
      iss: "issuer",
    };
    const valid = signedJwt(keys.privateKey, claims);

    await expect(verify(valid)).resolves.toMatchObject(claims);
    const [header, payload, signature] = valid.split(".") as [string, string, string];
    await expect(verify(`${header}=.${payload}.${signature}`)).rejects.toThrow(/base64url/u);
    await expect(verify(`${header}.${payload}.${signature}=`)).rejects.toThrow(/base64url/u);
    await expect(
      verify(signedJwt(keys.privateKey, { ...claims, nbf: "1700000000" })),
    ).rejects.toThrow(/nbf claim must be a finite number/u);
    await expect(
      verify(
        signedJwt(keys.privateKey, {
          ...claims,
          exp: Math.floor(now / 1000),
        }),
      ),
    ).rejects.toThrow(/expired/u);
  });

  it("rejects malformed registered claim types", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_700_000_000_000;
    const claims = {
      aud: "crabline",
      exp: Math.floor(now / 1000) + 60,
      iss: "issuer",
    };
    const verify = (overrides: Record<string, unknown>) =>
      verifySignedJwt({
        audience: "crabline",
        issuers: ["issuer"],
        now: () => now,
        resolveKey: async () => keys.publicKey,
        token: signedJwt(keys.privateKey, { ...claims, ...overrides }),
      });

    for (const iss of [["issuer"], 1, true, { value: "issuer" }]) {
      await expect(verify({ iss })).rejects.toThrow(/issuer is invalid/u);
    }
    for (const aud of [["crabline", 1], ["crabline", null], { value: "crabline" }]) {
      await expect(verify({ aud })).rejects.toThrow(/audience is invalid/u);
    }
  });

  it("rejects non-finite and negative clock skew", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_700_000_000_000;
    const token = signedJwt(keys.privateKey, {
      aud: "crabline",
      exp: 0,
      iss: "issuer",
    });

    for (const clockSkewSeconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ]) {
      await expect(
        verifySignedJwt({
          audience: "crabline",
          clockSkewSeconds,
          issuers: ["issuer"],
          now: () => now,
          resolveKey: async () => keys.publicKey,
          token,
        }),
      ).rejects.toThrow(/clock skew must be a finite non-negative number/u);
    }
  });

  it("does not cache responses marked no-cache or no-store", () => {
    const now = 1_700_000_000_000;

    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { "cache-control": "public, max-age=3600, no-cache" },
        }),
        now,
      ),
    ).toBe(now);
    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { "cache-control": "no-store, max-age=3600" },
        }),
        now,
      ),
    ).toBe(now);
  });

  it("subtracts response Age from cache freshness", () => {
    const now = 1_700_000_000_000;

    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { age: "120", "cache-control": "public, max-age=3600" },
        }),
        now,
      ),
    ).toBe(now + 3_480_000);
    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { age: "7200", "cache-control": "public, max-age=3600" },
        }),
        now,
      ),
    ).toBe(now);
    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { age: "172800", "cache-control": "public, max-age=604800" },
        }),
        now,
      ),
    ).toBe(now + 86_400_000);
  });

  it("clamps absurd cache lifetimes and rejects unsafe max-age values", () => {
    const now = 1_700_000_000_000;

    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { "cache-control": "public, max-age=999999" },
        }),
        now,
      ),
    ).toBe(now + 86_400_000);
    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { "cache-control": `public, max-age=${"9".repeat(400)}` },
        }),
        now,
      ),
    ).toBe(now);
  });

  it("accepts quoted max-age delta-seconds with optional whitespace", () => {
    const now = 1_700_000_000_000;

    for (const cacheControl of [
      'public, max-age="3600"',
      'public, max-age = "3600"',
      'public,\tmax-age\t=\t"3600"\t',
    ]) {
      expect(
        resolveHttpCacheExpiry(
          new Response(null, { headers: { "cache-control": cacheControl } }),
          now,
        ),
      ).toBe(now + 3_600_000);
    }
  });

  it("fails closed on malformed max-age instead of using fallback freshness", () => {
    const now = 1_700_000_000_000;
    const expires = new Date(now + 60 * 60 * 1_000).toUTCString();

    for (const cacheControl of [
      "public, max-age",
      "public, max-age=invalid",
      'public, max-age="3600',
      'public, max-age=" 3600 "',
      "public, max-age=3600, max-age=7200",
    ]) {
      expect(
        resolveHttpCacheExpiry(
          new Response(null, { headers: { "cache-control": cacheControl, expires } }),
          now,
        ),
      ).toBe(now);
    }
  });

  it("distinguishes absent Expires from invalid or stale values", () => {
    const now = 1_700_000_000_000;

    expect(resolveHttpCacheExpiry(new Response(), now)).toBe(now + 3_600_000);
    expect(
      resolveHttpCacheExpiry(new Response(null, { headers: { expires: "not-a-date" } }), now),
    ).toBe(now);
    expect(
      resolveHttpCacheExpiry(
        new Response(null, { headers: { expires: new Date(now - 1_000).toUTCString() } }),
        now,
      ),
    ).toBe(now);
  });

  it("clamps far-future Expires cache lifetimes", () => {
    const now = 1_700_000_000_000;

    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: { expires: new Date(now + 7 * 24 * 60 * 60 * 1_000).toUTCString() },
        }),
        now,
      ),
    ).toBe(now + 86_400_000);
  });

  it("single-flights unknown-key refreshes and applies a global cooldown", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        await Promise.resolve();
        return {
          expiresAt: now + 60_000,
          values: ["known"],
        };
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await Promise.all([
      expect(resolveKey({ alg: "RS256", kid: "missing-a" })).rejects.toThrow("unknown key"),
      expect(resolveKey({ alg: "RS256", kid: "missing-b" })).rejects.toThrow("unknown key"),
    ]);
    expect(fetches).toBe(2);

    await expect(resolveKey({ alg: "RS256", kid: "missing-c" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(2);

    now += 10_001;
    await expect(resolveKey({ alg: "RS256", kid: "missing-c" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(3);
  });

  it("starts the unknown-key cooldown after refresh completion", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        if (fetches === 2) {
          now += 20_000;
        }
        return {
          expiresAt: now + 60_000,
          values: ["known"],
        };
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "missing-a" })).rejects.toThrow("unknown key");
    await expect(resolveKey({ alg: "RS256", kid: "missing-b" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(2);
  });

  it("refetches cache-control no-store key sets for each verification", async () => {
    const now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        return {
          expiresAt: now,
          values: ["known"],
        };
      },
      keyId: (value) => value,
      now: () => now,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    expect(fetches).toBe(2);

    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toThrow("unknown key");
    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toThrow("unknown key");
    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    expect(fetches).toBe(4);
  });

  it("bounds remote key fetch latency even when the loader ignores aborts", async () => {
    const resolveKey = createCachedJwtKeyResolver<string>({
      fetchKeys: async () => await new Promise(() => {}),
      keyId: (value) => value,
      timeoutMs: 5,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toThrow("timed out");
  });

  it("backs off failed key fetches", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const fetchError = new Error("JWKS unavailable");
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        throw fetchError;
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toBe(fetchError);
    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toBe(fetchError);
    expect(fetches).toBe(1);

    now += 10_001;
    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toBe(fetchError);
    expect(fetches).toBe(2);
  });

  it("backs off synchronously thrown key fetches and clears their timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchError = new Error("JWKS unavailable");
      let fetches = 0;
      const resolveKey = createCachedJwtKeyResolver<string>({
        fetchKeys() {
          fetches += 1;
          throw fetchError;
        },
        keyId: (value) => value,
        now: () => 1_700_000_000_000,
        refreshCooldownMs: 10_000,
        timeoutMs: 5_000,
        unknownKeyMessage: "unknown key",
      });

      await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toBe(fetchError);
      await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toBe(fetchError);
      expect(fetches).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off failed unknown-key refreshes while a positive cache remains fresh", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const fetchError = new Error("JWKS unavailable");
    const resolveKey = createCachedJwtKeyResolver<string>({
      fetchKeys() {
        fetches += 1;
        if (fetches > 1) {
          throw fetchError;
        }
        return Promise.resolve({
          expiresAt: now + 60_000,
          values: ["known"],
        });
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "missing-a" })).rejects.toBe(fetchError);
    await expect(resolveKey({ alg: "RS256", kid: "missing-b" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(2);

    now += 10_001;
    await expect(resolveKey({ alg: "RS256", kid: "missing-c" })).rejects.toBe(fetchError);
    expect(fetches).toBe(3);
  });

  it("invalidates negative entries when a refreshed key set contains them", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        return {
          expiresAt: now + (fetches < 3 ? 1_000 : 60_000),
          values: fetches < 3 ? ["known"] : ["known", "rotated"],
        };
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "rotated" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(2);

    now += 2_000;
    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "rotated" })).resolves.toBe("rotated");
    expect(fetches).toBe(3);
  });

  it("refreshes an expired positive key set before consulting negative entries", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        return {
          expiresAt: now + 1_000,
          values: fetches < 3 ? ["known"] : ["known", "rotated"],
        };
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "rotated" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(2);

    now += 1_001;
    await expect(resolveKey({ alg: "RS256", kid: "rotated" })).resolves.toBe("rotated");
    expect(fetches).toBe(3);
  });

  it("throttles negatives after an expired refresh returns an uncacheable key set", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        fetches += 1;
        return {
          expiresAt: fetches < 3 ? now + 1_000 : now,
          values: ["known"],
        };
      },
      keyId: (value) => value,
      now: () => now,
      refreshCooldownMs: 10_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(2);

    now += 1_001;
    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toThrow("unknown key");
    await expect(resolveKey({ alg: "RS256", kid: "missing" })).rejects.toThrow("unknown key");
    expect(fetches).toBe(3);
  });
});
