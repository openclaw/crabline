import { describe, expect, it } from "vitest";
import { validateWebhookTarget } from "../src/servers/webhook-target.js";

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
    ["[2606:4700:4700::1111]", "2606:4700:4700::1111", 6],
  ] as const)("allows globally reachable address %s", async (host, address, family) => {
    await expect(validate(host)).resolves.toEqual({
      addresses: [{ address, family }],
    });
  });
});
