import { describe, expect, it } from "vitest";
import { createCachedJwtKeyResolver, resolveHttpCacheExpiry } from "../src/providers/signed-jwt.js";

describe("signed JWT remote key cache", () => {
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
});
