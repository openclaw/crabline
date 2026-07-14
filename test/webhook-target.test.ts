import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  postWebhookRequest,
  postWebhookRequestWithResponse,
  validateWebhookTarget,
  WebhookDnsLookupPool,
} from "../src/servers/webhook-target.js";

async function validate(address: string) {
  return await validateWebhookTarget({
    allowLoopbackHttp: false,
    dnsLookupPool: new WebhookDnsLookupPool(1, async (hostname) =>
      hostname === "ipv4only.arpa" ? [{ address: "192.0.0.170", family: 4 }] : [],
    ),
    restrictPrivateAddresses: true,
    url: new URL(`https://${address}/webhook`),
  });
}

function rfc6052Address(prefixLength: 32 | 40 | 48 | 56 | 64 | 96, ipv4: string): string {
  const prefix = [0x20, 0x01, 0x48, 0x60, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22];
  const ipv4Bytes = ipv4.split(".").map(Number);
  const bytes = Array.from({ length: 16 }, () => 0);
  const prefixBytes = prefixLength / 8;
  bytes.splice(0, prefixBytes, ...prefix.slice(0, prefixBytes));
  if (prefixLength === 96) {
    bytes.splice(12, 4, ...ipv4Bytes);
  } else {
    const leadingIpv4Bytes = 8 - prefixBytes;
    bytes.splice(prefixBytes, leadingIpv4Bytes, ...ipv4Bytes.slice(0, leadingIpv4Bytes));
    bytes[8] = 0;
    bytes.splice(9, 4 - leadingIpv4Bytes, ...ipv4Bytes.slice(leadingIpv4Bytes));
  }
  return Array.from({ length: 8 }, (_, index) =>
    ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16),
  ).join(":");
}

describe("webhook target validation", () => {
  it.each([
    "0.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks non-global IPv4 address %s", async (address) => {
    await expect(validate(address)).resolves.toEqual({ error: "private-address" });
  });

  it.each([
    "[::]",
    "[::1]",
    "[::ffff:5db8:d822]",
    "[::ffff:c000:201]",
    "[64:ff9b::7f00:1]",
    "[64:ff9b::a9fe:a9fe]",
    "[64:ff9b::c000:201]",
    "[64:ff9b:1::1]",
    "[100::1]",
    "[100:0:0:1::1]",
    "[2001::1]",
    "[2001:2::1]",
    "[2001:db8::1]",
    "[2002::1]",
    "[3800::1]",
    "[3ffe::1]",
    "[3fff::1]",
    "[4000::1]",
    "[5f00::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[ff00::1]",
  ])("blocks non-global IPv6 address %s", async (address) => {
    await expect(validate(address)).resolves.toEqual({ error: "private-address" });
  });

  it.each([
    ["93.184.216.34", "93.184.216.34", 4],
    ["192.0.0.9", "192.0.0.9", 4],
    ["[64:ff9b::5db8:d822]", "64:ff9b::5db8:d822", 6],
    ["[2001:1::1]", "2001:1::1", 6],
    ["[2001:4860:4860::8888]", "2001:4860:4860::8888", 6],
    ["[2404:6800::1]", "2404:6800::1", 6],
    ["[2410::1]", "2410::1", 6],
    ["[2606:4700:4700::1111]", "2606:4700:4700::1111", 6],
    ["[2610::1]", "2610::1", 6],
    ["[2620:4f:8000::1]", "2620:4f:8000::1", 6],
    ["[2630::1]", "2630::1", 6],
    ["[2a10::1]", "2a10::1", 6],
  ] as const)("allows globally reachable address %s", async (host, address, family) => {
    await expect(validate(host)).resolves.toEqual({
      addresses: [{ address, family }],
    });
  });

  it("only exempts loopback HTTP from private-address blocking", async () => {
    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: true,
        restrictPrivateAddresses: true,
        url: new URL("http://127.0.0.1/webhook"),
      }),
    ).resolves.toEqual({ addresses: [{ address: "127.0.0.1", family: 4 }] });
    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: true,
        restrictPrivateAddresses: true,
        url: new URL("https://10.0.0.1/webhook"),
      }),
    ).resolves.toEqual({ error: "private-address" });
  });

  it.each(["ftp://93.184.216.34/webhook", "ws://93.184.216.34/webhook"])(
    "rejects unsupported webhook protocol %s",
    async (url) => {
      await expect(
        validateWebhookTarget({
          allowLoopbackHttp: true,
          restrictPrivateAddresses: true,
          url: new URL(url),
        }),
      ).resolves.toEqual({ error: "https-required" });
    },
  );

  it("rejects DNS answers that can rebind from public to private addresses", async () => {
    const dnsLookupPool = new WebhookDnsLookupPool(1, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: false,
        dnsLookupPool,
        restrictPrivateAddresses: true,
        url: new URL("https://rebind.example.test/webhook"),
      }),
    ).resolves.toEqual({ error: "private-address" });
  });

  it.each([32, 40, 48, 56, 64, 96] as const)(
    "blocks private IPv4 targets embedded under a network-specific /%i NAT64 prefix",
    async (prefixLength) => {
      const dnsLookupPool = new WebhookDnsLookupPool(1, async (hostname) =>
        hostname === "ipv4only.arpa"
          ? [
              { address: rfc6052Address(prefixLength, "192.0.0.170"), family: 6 },
              { address: rfc6052Address(prefixLength, "192.0.0.171"), family: 6 },
            ]
          : [],
      );
      const privateAddress = rfc6052Address(prefixLength, "127.0.0.1");
      const publicAddress = rfc6052Address(prefixLength, "93.184.216.34");
      const normalizedPublicAddress = new URL(
        `https://[${publicAddress}]/webhook`,
      ).hostname.replace(/^\[(.*)\]$/u, "$1");

      await expect(
        validateWebhookTarget({
          allowLoopbackHttp: false,
          dnsLookupPool,
          restrictPrivateAddresses: true,
          url: new URL(`https://[${privateAddress}]/webhook`),
        }),
      ).resolves.toEqual({ error: "private-address" });
      await expect(
        validateWebhookTarget({
          allowLoopbackHttp: false,
          dnsLookupPool,
          restrictPrivateAddresses: true,
          url: new URL(`https://[${publicAddress}]/webhook`),
        }),
      ).resolves.toEqual({
        addresses: [{ address: normalizedPublicAddress, family: 6 }],
      });
    },
  );

  it("fails closed for IPv6 targets when NAT64 prefix discovery fails", async () => {
    const dnsLookupPool = new WebhookDnsLookupPool(1, async () => {
      throw new Error("resolver unavailable");
    });

    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: false,
        dnsLookupPool,
        restrictPrivateAddresses: true,
        url: new URL("https://[2001:4860:4860::8888]/webhook"),
      }),
    ).resolves.toEqual({ error: "private-address" });
  });

  it("fails closed when NAT64 discovery does not return the complete reserved pair", async () => {
    const dnsLookupPool = new WebhookDnsLookupPool(1, async (hostname) =>
      hostname === "ipv4only.arpa"
        ? [{ address: rfc6052Address(96, "192.0.0.170"), family: 6 }]
        : [],
    );

    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: false,
        dnsLookupPool,
        restrictPrivateAddresses: true,
        url: new URL("https://[2001:4860:4860::8888]/webhook"),
      }),
    ).resolves.toEqual({ error: "private-address" });
  });

  it("blocks private IPv4 embeddings under overlapping discovered NAT64 prefixes", async () => {
    const dnsLookupPool = new WebhookDnsLookupPool(1, async (hostname) =>
      hostname === "ipv4only.arpa"
        ? [
            { address: rfc6052Address(32, "192.0.0.170"), family: 6 },
            { address: rfc6052Address(32, "192.0.0.171"), family: 6 },
            { address: rfc6052Address(96, "192.0.0.170"), family: 6 },
            { address: rfc6052Address(96, "192.0.0.171"), family: 6 },
          ]
        : [],
    );

    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: false,
        dnsLookupPool,
        restrictPrivateAddresses: true,
        url: new URL(`https://[${rfc6052Address(96, "127.0.0.1")}]/webhook`),
      }),
    ).resolves.toEqual({ error: "private-address" });
  });

  it("skips address resolution when private-target restriction is disabled", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("resolution should not run");
    });

    await expect(
      validateWebhookTarget({
        allowLoopbackHttp: false,
        dnsLookupPool: { resolve },
        restrictPrivateAddresses: false,
        url: new URL("https://[2001:4860:4860::8888]/webhook"),
      }),
    ).resolves.toEqual({ addresses: undefined });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("bounds DNS lookup concurrency and cancels queued registrations", async () => {
    const started: string[] = [];
    const releases = new Map<
      string,
      (addresses: Array<{ address: string; family: number }>) => void
    >();
    const pool = new WebhookDnsLookupPool(
      2,
      async (hostname) =>
        await new Promise((resolve) => {
          started.push(hostname);
          releases.set(hostname, resolve);
        }),
    );
    const first = pool.resolve("first.test");
    const second = pool.resolve("second.test");
    const controller = new AbortController();
    const third = pool.resolve("third.test", controller.signal);

    expect(started).toEqual(["first.test", "second.test"]);
    controller.abort();
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toEqual(["first.test", "second.test"]);

    releases.get("first.test")?.([{ address: "93.184.216.34", family: 4 }]);
    releases.get("second.test")?.([{ address: "93.184.216.35", family: 4 }]);
    await expect(first).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(second).resolves.toEqual([{ address: "93.184.216.35", family: 4 }]);
  });

  it("keeps actual DNS concurrency bounded while active callers abort", async () => {
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const releases = new Map<
      string,
      (addresses: Array<{ address: string; family: number }>) => void
    >();
    const pool = new WebhookDnsLookupPool(
      2,
      async (hostname) =>
        await new Promise((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          started.push(hostname);
          releases.set(hostname, (addresses) => {
            active -= 1;
            resolve(addresses);
          });
        }),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = pool.resolve("first.test", firstController.signal);
    const second = pool.resolve("second.test", secondController.signal);
    const third = pool.resolve("third.test");
    const fourth = pool.resolve("fourth.test");

    expect(started).toEqual(["first.test", "second.test"]);
    firstController.abort();
    secondController.abort();
    await Promise.all([
      expect(first).rejects.toMatchObject({ name: "AbortError" }),
      expect(second).rejects.toMatchObject({ name: "AbortError" }),
    ]);
    expect(started).toEqual(["first.test", "second.test"]);
    expect(maximumActive).toBe(2);

    releases.get("first.test")?.([{ address: "93.184.216.34", family: 4 }]);
    await vi.waitFor(() => expect(started).toEqual(["first.test", "second.test", "third.test"]));
    expect(maximumActive).toBe(2);

    releases.get("second.test")?.([{ address: "93.184.216.35", family: 4 }]);
    await vi.waitFor(() =>
      expect(started).toEqual(["first.test", "second.test", "third.test", "fourth.test"]),
    );
    expect(maximumActive).toBe(2);

    releases.get("third.test")?.([{ address: "93.184.216.36", family: 4 }]);
    releases.get("fourth.test")?.([{ address: "93.184.216.37", family: 4 }]);
    await expect(third).resolves.toEqual([{ address: "93.184.216.36", family: 4 }]);
    await expect(fourth).resolves.toEqual([{ address: "93.184.216.37", family: 4 }]);
  });

  it("does not reuse sockets for DNS-pinned webhook delivery", async () => {
    const remotePorts: number[] = [];
    const receiver = createServer((request, response) => {
      remotePorts.push(request.socket.remotePort ?? 0);
      request.resume();
      response.end("ok");
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook receiver.");
    }
    const pinnedAddress = { address: "127.0.0.1", family: 4 as const };
    const url = new URL(`http://dns-pinning.invalid:${address.port}/webhook`);

    try {
      await postWebhookRequest({ address: pinnedAddress, body: "{}", timeoutMs: 1_000, url });
      await postWebhookRequest({ address: pinnedAddress, body: "{}", timeoutMs: 1_000, url });
      expect(remotePorts).toHaveLength(2);
      expect(new Set(remotePorts).size).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("returns webhook status and response headers without reading the body", async () => {
    const receiver = createServer((_request, response) => {
      response.writeHead(302, {
        location: "/redirected",
        "x-slack-no-retry": "1",
      });
      response.write("ignored body");
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve webhook receiver.");
    }

    try {
      await expect(
        postWebhookRequestWithResponse({
          address: { address: "127.0.0.1", family: 4 },
          body: "{}",
          timeoutMs: 1_000,
          url: new URL(`http://response.invalid:${address.port}/webhook`),
        }),
      ).resolves.toMatchObject({
        headers: {
          location: "/redirected",
          "x-slack-no-retry": "1",
        },
        status: 302,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    "Connection",
    "Content-Length",
    "Expect",
    "Host",
    "Keep-Alive",
    "Proxy-Connection",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
  ])("rejects sender-controlled custom webhook header %s", async (name) => {
    await expect(
      postWebhookRequest({
        body: "{}",
        headerEntries: [[name, "unsafe"]],
        timeoutMs: 100,
        url: new URL("http://127.0.0.1:1/webhook"),
      }),
    ).rejects.toThrow(`Webhook header "${name}" is controlled by the sender.`);
  });
});
