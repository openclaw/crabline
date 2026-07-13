import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  postWebhookRequest,
  postWebhookRequestWithResponse,
  validateWebhookTarget,
  WebhookDnsLookupPool,
} from "../src/servers/webhook-target.js";

async function validate(address: string) {
  return await validateWebhookTarget({
    allowLoopbackHttp: false,
    restrictPrivateAddresses: true,
    url: new URL(`https://${address}/webhook`),
  });
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
});
