import { lookup } from "node:dns/promises";
import { request as requestHttp, type ClientRequest, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import { isLoopbackHost } from "./http.js";

export type WebhookAddress = {
  address: string;
  family: 4 | 6;
};

export type WebhookTargetError = "https-required" | "private-address" | "unresolvable";

export type ValidatedWebhookTarget =
  | { addresses: WebhookAddress[] | undefined }
  | { error: WebhookTargetError };

const BLOCKED_IPV4_ADDRESSES = createBlockedIpv4Addresses();
const BLOCKED_IPV6_ADDRESSES = createBlockedIpv6Addresses();
const GLOBAL_IPV4_EXCEPTIONS = createGlobalIpv4Exceptions();
const GLOBAL_IPV6_EXCEPTIONS = createGlobalIpv6Exceptions();
const ALLOCATED_GLOBAL_IPV6_RANGES = createAllocatedGlobalIpv6Ranges();

function createBlockedIpv4Addresses(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv4");
  }
  return blockList;
}

function createBlockedIpv6Addresses(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["100:0:0:1::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  return blockList;
}

function createGlobalIpv4Exceptions(): BlockList {
  const blockList = new BlockList();
  // These are globally reachable assignments inside 192.0.0.0/24.
  for (const address of ["192.0.0.9", "192.0.0.10"] as const) {
    blockList.addAddress(address, "ipv4");
  }
  return blockList;
}

function createGlobalIpv6Exceptions(): BlockList {
  const blockList = new BlockList();
  // These are globally reachable assignments inside 2001::/23.
  for (const [address, prefix] of [
    ["2001:1::1", 128],
    ["2001:1::2", 128],
    ["2001:1::3", 128],
    ["2001:3::", 32],
    ["2001:4:112::", 48],
    ["2001:20::", 28],
    ["2001:30::", 28],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  return blockList;
}

function createAllocatedGlobalIpv6Ranges(): BlockList {
  const blockList = new BlockList();
  // IANA reserves unlisted portions of 2000::/3 for future allocation.
  for (const [address, prefix] of [
    ["2001:200::", 23],
    ["2001:400::", 23],
    ["2001:600::", 23],
    ["2001:800::", 22],
    ["2001:c00::", 23],
    ["2001:e00::", 23],
    ["2001:1200::", 23],
    ["2001:1400::", 22],
    ["2001:1800::", 23],
    ["2001:1a00::", 23],
    ["2001:1c00::", 22],
    ["2001:2000::", 19],
    ["2001:4000::", 23],
    ["2001:4200::", 23],
    ["2001:4400::", 23],
    ["2001:4600::", 23],
    ["2001:4800::", 23],
    ["2001:4a00::", 23],
    ["2001:4c00::", 23],
    ["2001:5000::", 20],
    ["2001:8000::", 19],
    ["2001:a000::", 20],
    ["2001:b000::", 20],
    ["2003::", 18],
    ["2400::", 12],
    ["2600::", 12],
    ["2800::", 12],
    ["2a00::", 12],
    ["2c00::", 12],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  blockList.addSubnet("64:ff9b::", 96, "ipv6");
  return blockList;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/u, "$1").replace(/%25/gu, "%");
}

function isBlockedWebhookAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    return (
      !GLOBAL_IPV4_EXCEPTIONS.check(normalized, "ipv4") &&
      BLOCKED_IPV4_ADDRESSES.check(normalized, "ipv4")
    );
  }
  if (family === 6) {
    if (GLOBAL_IPV6_EXCEPTIONS.check(normalized, "ipv6")) {
      return false;
    }
    return (
      BLOCKED_IPV6_ADDRESSES.check(normalized, "ipv6") ||
      !ALLOCATED_GLOBAL_IPV6_RANGES.check(normalized, "ipv6")
    );
  }
  return false;
}

async function resolveWebhookAddresses(hostname: string): Promise<WebhookAddress[]> {
  const normalized = normalizeHostname(hostname);
  const family = isIP(normalized);
  if (family === 4 || family === 6) {
    return [{ address: normalized, family }];
  }
  return (await lookup(normalized, { all: true, verbatim: true })).flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  );
}

export async function validateWebhookTarget(params: {
  allowLoopbackHttp: boolean;
  restrictPrivateAddresses: boolean;
  url: URL;
}): Promise<ValidatedWebhookTarget> {
  if (
    params.url.protocol === "http:" &&
    (!params.allowLoopbackHttp || !isLoopbackHost(params.url.hostname))
  ) {
    return { error: "https-required" };
  }
  if (params.url.protocol !== "http:" && params.url.protocol !== "https:") {
    return { error: "https-required" };
  }
  if (!params.restrictPrivateAddresses) {
    return { addresses: undefined };
  }

  let addresses: WebhookAddress[];
  try {
    addresses = await resolveWebhookAddresses(params.url.hostname);
  } catch {
    return { error: "unresolvable" };
  }
  if (addresses.length === 0) {
    return { error: "unresolvable" };
  }
  if (addresses.some((entry) => isBlockedWebhookAddress(entry.address))) {
    return { error: "private-address" };
  }
  return { addresses };
}

export async function postWebhookRequest(params: {
  activeRequests?: Set<ClientRequest> | undefined;
  address?: WebhookAddress | undefined;
  body: string;
  headerEntries?: ReadonlyArray<readonly [string, string]> | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: URL;
}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const address = params.address;
    let settled = false;
    let response: IncomingMessage | undefined;
    let deadline: NodeJS.Timeout;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      params.activeRequests?.delete(request);
      callback();
    };
    const send = params.url.protocol === "https:" ? requestHttps : requestHttp;
    const request = send(
      params.url,
      {
        ...(address ? { family: address.family } : {}),
        headers: {
          "content-length": String(Buffer.byteLength(params.body)),
          "content-type": "application/json",
          ...Object.fromEntries(params.headerEntries ?? []),
        },
        ...(address
          ? {
              lookup: (_hostname, _options, callback) =>
                callback(null, address.address, address.family),
            }
          : {}),
        method: "POST",
        signal: params.signal,
      },
      (incoming) => {
        response = incoming;
        incoming.resume();
        incoming.once("error", (error) => finish(() => reject(error)));
        incoming.once("end", () => finish(() => resolve(incoming.statusCode ?? 0)));
      },
    );
    params.activeRequests?.add(request);
    deadline = setTimeout(() => {
      const error = new DOMException(
        `Webhook delivery timed out after ${params.timeoutMs}ms`,
        "TimeoutError",
      );
      response?.destroy(error);
      request.destroy(error);
    }, params.timeoutMs);
    deadline.unref();
    request.once("error", (error) => finish(() => reject(error)));
    request.end(params.body);
  });
}
