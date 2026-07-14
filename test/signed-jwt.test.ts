import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createCachedJwtKeyResolver,
  JwtKeyInfrastructureError,
  resolveHttpCacheExpiry,
  verifySignedJwt,
} from "../src/providers/signed-jwt.js";

function signedJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", ...headerOverrides }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

describe("signed JWT remote key cache", () => {
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    1.5,
    2_147_483_648,
  ])("rejects invalid fetch timeouts: %s", (timeoutMs) => {
    expect(() =>
      createCachedJwtKeyResolver<string>({
        fetchKeys: async () => ({ expiresAt: 0, values: [] }),
        keyId: (value) => value,
        timeoutMs,
        unknownKeyMessage: "unknown key",
      }),
    ).toThrow("timeoutMs must be a positive integer no greater than 2147483647.");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, 2_147_483_648])(
    "rejects invalid refresh cooldowns: %s",
    (refreshCooldownMs) => {
      expect(() =>
        createCachedJwtKeyResolver<string>({
          fetchKeys: async () => ({ expiresAt: 0, values: [] }),
          keyId: (value) => value,
          refreshCooldownMs,
          unknownKeyMessage: "unknown key",
        }),
      ).toThrow("refreshCooldownMs must be a non-negative integer no greater than 2147483647.");
    },
  );

  it("accepts the maximum Node timer delay", () => {
    expect(() =>
      createCachedJwtKeyResolver<string>({
        fetchKeys: async () => ({ expiresAt: 0, values: [] }),
        keyId: (value) => value,
        refreshCooldownMs: 2_147_483_647,
        timeoutMs: 2_147_483_647,
        unknownKeyMessage: "unknown key",
      }),
    ).not.toThrow();
  });

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

  it("rejects critical JWS extensions before resolving a signing key", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_700_000_000_000;
    const resolveKey = vi.fn(async () => keys.publicKey);
    const claims = {
      aud: "crabline",
      exp: Math.floor(now / 1000) + 60,
      iss: "issuer",
    };
    const signedRequest = signedJwt(keys.privateKey, claims, {
      crit: ["custom"],
      custom: true,
    });

    await expect(
      verifySignedJwt({
        audience: "crabline",
        issuers: ["issuer"],
        now: () => now,
        resolveKey,
        ["token"]: signedRequest,
      }),
    ).rejects.toThrow(/critical header parameters are unsupported/u);
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it.each([[], "custom", [""], [1]])("rejects malformed JWS crit headers: %j", async (crit) => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_700_000_000_000;
    const signedRequest = signedJwt(
      keys.privateKey,
      {
        aud: "crabline",
        exp: Math.floor(now / 1000) + 60,
        iss: "issuer",
      },
      { crit },
    );

    await expect(
      verifySignedJwt({
        audience: "crabline",
        issuers: ["issuer"],
        now: () => now,
        resolveKey: async () => keys.publicKey,
        ["token"]: signedRequest,
      }),
    ).rejects.toThrow(/crit header must be a non-empty array/u);
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

  it("does not treat quoted no-cache or no-store values as directives", () => {
    const now = 1_700_000_000_000;

    for (const cacheControl of [
      'private="authorization, no-cache", max-age=3600',
      'x-metadata="quoted, no-store", max-age=3600',
    ]) {
      expect(
        resolveHttpCacheExpiry(
          new Response(null, { headers: { "cache-control": cacheControl } }),
          now,
        ),
      ).toBe(now + 3_600_000);
    }
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

  it("uses the greater of apparent Date age and Age header age", () => {
    const now = 1_700_000_000_000;

    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: {
            age: "120",
            "cache-control": "public, max-age=3600",
            date: new Date(now - 600_000).toUTCString(),
          },
        }),
        now,
      ),
    ).toBe(now + 3_000_000);
    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: {
            age: "900",
            "cache-control": "public, max-age=3600",
            date: new Date(now - 600_000).toUTCString(),
          },
        }),
        now,
      ),
    ).toBe(now + 2_700_000);
  });

  it("ignores malformed or future Date values when calculating apparent age", () => {
    const now = 1_700_000_000_000;

    for (const date of ["not-a-date", new Date(now + 600_000).toUTCString()]) {
      expect(
        resolveHttpCacheExpiry(
          new Response(null, {
            headers: {
              age: "120",
              "cache-control": "public, max-age=3600",
              date,
            },
          }),
          now,
        ),
      ).toBe(now + 3_480_000);
    }
  });

  it("expires cache entries when apparent response age reaches the freshness boundary", () => {
    const now = 1_700_000_000_000;

    expect(
      resolveHttpCacheExpiry(
        new Response(null, {
          headers: {
            "cache-control": "public, max-age=3600",
            date: new Date(now - 3_600_000).toUTCString(),
          },
        }),
        now,
      ),
    ).toBe(now);
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

  it("ignores extension directives whose HTTP token names start with max-age", () => {
    const now = 1_700_000_000_000;
    const expires = new Date(now + 30 * 60 * 1_000).toUTCString();

    for (const directive of [
      "max-age-fallback=3600",
      "max-age.fallback=3600",
      "max-age*fallback=3600",
    ]) {
      expect(
        resolveHttpCacheExpiry(
          new Response(null, { headers: { "cache-control": `public, ${directive}` } }),
          now,
        ),
      ).toBe(now + 3_600_000);
      expect(
        resolveHttpCacheExpiry(
          new Response(null, {
            headers: { "cache-control": `public, ${directive}`, expires },
          }),
          now,
        ),
      ).toBe(now + 1_800_000);
    }
  });

  it("fails closed on unterminated Cache-Control quotes and dangling escapes", () => {
    const now = 1_700_000_000_000;
    const expires = new Date(now + 60 * 60 * 1_000).toUTCString();

    for (const cacheControl of ['private="unterminated, max-age=0', 'private="dangling\\']) {
      expect(
        resolveHttpCacheExpiry(
          new Response(null, { headers: { "cache-control": cacheControl } }),
          now,
        ),
      ).toBe(now);
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

  it("keeps timed-out key loads shared until a late success settles", async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      let resolveFetch!: (keySet: { expiresAt: number; values: string[] }) => void;
      const resolveKey = createCachedJwtKeyResolver<string>({
        fetchKeys: async () => {
          fetches += 1;
          return await new Promise((resolve) => {
            resolveFetch = resolve;
          });
        },
        keyId: (value) => value,
        now: () => 1_700_000_000_000,
        timeoutMs: 10,
        unknownKeyMessage: "unknown key",
      });

      const first = resolveKey({ alg: "RS256", kid: "known" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/timed out/u) }),
      );

      const second = resolveKey({ alg: "RS256", kid: "known" });
      expect(fetches).toBe(1);
      resolveFetch({ expiresAt: 1_700_000_060_000, values: ["known"] });

      await expect(second).resolves.toBe("known");
      await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toBe("known");
      expect(fetches).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds each waiter while a timed-out key load remains unsettled", async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      let rejectFetch!: (error: Error) => void;
      const resolveKey = createCachedJwtKeyResolver<string>({
        fetchKeys: async () => {
          fetches += 1;
          return await new Promise((_, reject) => {
            rejectFetch = reject;
          });
        },
        keyId: (value) => value,
        now: () => 1_700_000_000_000,
        timeoutMs: 10,
        unknownKeyMessage: "unknown key",
      });

      const first = resolveKey({ alg: "RS256", kid: "missing" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/timed out/u) }),
      );

      const secondPromise = resolveKey({ alg: "RS256", kid: "missing" });
      const second = secondPromise.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(9);
      expect(fetches).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await second).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/timed out/u) }),
      );

      rejectFetch(new Error("late loader rejection"));
      await vi.runAllTicks();
      expect(fetches).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a permanently pending generation after cooldown and fences its late result", async () => {
    vi.useFakeTimers();
    try {
      type TestKey = { generation: number; kid: string };
      let now = 1_700_000_000_000;
      let fetches = 0;
      const loads: Array<{
        resolve(keySet: { expiresAt: number; values: TestKey[] }): void;
      }> = [];
      const resolveKey = createCachedJwtKeyResolver<TestKey>({
        fetchKeys: async () => {
          fetches += 1;
          return await new Promise((resolve) => {
            loads.push({ resolve });
          });
        },
        keyId: (value) => value.kid,
        now: () => now,
        refreshCooldownMs: 100,
        timeoutMs: 10,
        unknownKeyMessage: "unknown key",
      });

      const first = resolveKey({ alg: "RS256", kid: "known" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toBeInstanceOf(JwtKeyInfrastructureError);
      expect(fetches).toBe(1);

      now += 101;
      const replacement = resolveKey({ alg: "RS256", kid: "known" });
      await vi.runAllTicks();
      expect(fetches).toBe(2);
      loads[1]!.resolve({
        expiresAt: now + 60_000,
        values: [{ generation: 2, kid: "known" }],
      });
      await expect(replacement).resolves.toMatchObject({ generation: 2 });

      loads[0]!.resolve({
        expiresAt: now + 120_000,
        values: [{ generation: 1, kid: "known" }],
      });
      await vi.runAllTicks();
      await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toMatchObject({
        generation: 2,
      });
      expect(fetches).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a key set when any remote key id is invalid before caching valid peers", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const resolveKey = createCachedJwtKeyResolver<{ kid?: string }>({
      async fetchKeys() {
        fetches += 1;
        return {
          expiresAt: now + 60_000,
          values: fetches === 1 ? [{ kid: "known" }, {}] : [{ kid: "known" }],
        };
      },
      keyId: (value) => value.kid,
      now: () => now,
      refreshCooldownMs: 100,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "known" })).rejects.toThrow(
      JwtKeyInfrastructureError,
    );
    await expect(resolveKey({ alg: "RS256", kid: "known" })).rejects.toThrow(/key id is invalid/u);
    expect(fetches).toBe(1);

    now += 101;
    await expect(resolveKey({ alg: "RS256", kid: "known" })).resolves.toMatchObject({
      kid: "known",
    });
    expect(fetches).toBe(2);
  });

  it("rejects oversized remote key sets before positive caching", async () => {
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        return {
          expiresAt: 1_700_000_060_000,
          values: Array.from({ length: 129 }, (_, index) => `key-${index}`),
        };
      },
      keyId: (value) => value,
      now: () => 1_700_000_000_000,
      unknownKeyMessage: "unknown key",
    });

    await expect(resolveKey({ alg: "RS256", kid: "key-0" })).rejects.toThrow(/128-key limit/u);
  });

  it("classifies empty remote key sets as infrastructure failures", async () => {
    const resolveKey = createCachedJwtKeyResolver<string>({
      async fetchKeys() {
        return {
          expiresAt: 1_700_000_060_000,
          values: [],
        };
      },
      keyId: (value) => value,
      now: () => 1_700_000_000_000,
      unknownKeyMessage: "unknown key",
    });

    const failure = await resolveKey({ alg: "RS256", kid: "missing" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(JwtKeyInfrastructureError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/at least one key/u) });
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

    for (const failure of [
      await resolveKey({ alg: "RS256", kid: "missing" }).catch((error: unknown) => error),
      await resolveKey({ alg: "RS256", kid: "missing" }).catch((error: unknown) => error),
    ]) {
      expect(failure).toBeInstanceOf(JwtKeyInfrastructureError);
      expect(failure).toMatchObject({ cause: fetchError });
    }
    expect(fetches).toBe(1);

    now += 10_001;
    const retriedFailure = await resolveKey({ alg: "RS256", kid: "missing" }).catch(
      (error: unknown) => error,
    );
    expect(retriedFailure).toBeInstanceOf(JwtKeyInfrastructureError);
    expect(retriedFailure).toMatchObject({ cause: fetchError });
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

      for (const failure of [
        await resolveKey({ alg: "RS256", kid: "missing" }).catch((error: unknown) => error),
        await resolveKey({ alg: "RS256", kid: "missing" }).catch((error: unknown) => error),
      ]) {
        expect(failure).toBeInstanceOf(JwtKeyInfrastructureError);
        expect(failure).toMatchObject({ cause: fetchError });
      }
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
    for (const kid of ["missing-a", "missing-b"]) {
      const failure = await resolveKey({ alg: "RS256", kid }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(JwtKeyInfrastructureError);
      expect(failure).toMatchObject({ cause: fetchError });
    }
    expect(fetches).toBe(2);

    now += 10_001;
    const retriedFailure = await resolveKey({ alg: "RS256", kid: "missing-c" }).catch(
      (error: unknown) => error,
    );
    expect(retriedFailure).toBeInstanceOf(JwtKeyInfrastructureError);
    expect(retriedFailure).toMatchObject({ cause: fetchError });
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
