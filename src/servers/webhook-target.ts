import { lookup } from "node:dns/promises";
import {
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
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

export type WebhookResponse = {
  headers: IncomingHttpHeaders;
  status: number;
};

export const MAX_CONCURRENT_WEBHOOK_DNS_LOOKUPS = 8;

const BLOCKED_IPV4_ADDRESSES = createBlockedIpv4Addresses();
const BLOCKED_IPV6_ADDRESSES = createBlockedIpv6Addresses();
const GLOBAL_IPV4_EXCEPTIONS = createGlobalIpv4Exceptions();
const GLOBAL_IPV6_EXCEPTIONS = createGlobalIpv6Exceptions();
const ALLOCATED_GLOBAL_IPV6_RANGES = createAllocatedGlobalIpv6Ranges();
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;
const IPV4ONLY_ADDRESSES = new Set(["192.0.0.170", "192.0.0.171"]);

type WebhookDnsLookupResult = ReadonlyArray<{ address: string; family: number }>;
type WebhookDnsLookup = (hostname: string) => Promise<WebhookDnsLookupResult>;
type Nat64PrefixLength = (typeof RFC6052_PREFIX_LENGTHS)[number];
type Nat64Prefix = {
  bytes: readonly number[];
  length: Nat64PrefixLength;
};

type PendingWebhookDnsLookup = {
  hostname: string;
  onAbort: () => void;
  reject(error: unknown): void;
  resolve(addresses: WebhookDnsLookupResult): void;
  settled: boolean;
  signal: AbortSignal | undefined;
  slotHeld: boolean;
  started: boolean;
};

export class WebhookDnsLookupPool {
  readonly #pending: PendingWebhookDnsLookup[] = [];
  #active = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly lookupHostname: WebhookDnsLookup = async (hostname) =>
      await lookup(hostname, { all: true, verbatim: true }),
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("Webhook DNS lookup concurrency must be a positive safe integer.");
    }
  }

  resolve(hostname: string, signal?: AbortSignal): Promise<WebhookDnsLookupResult> {
    return new Promise<WebhookDnsLookupResult>((resolve, reject) => {
      const pending: PendingWebhookDnsLookup = {
        hostname,
        onAbort: () => {
          if (pending.settled) {
            return;
          }
          pending.settled = true;
          if (!pending.started) {
            const index = this.#pending.indexOf(pending);
            if (index >= 0) {
              this.#pending.splice(index, 1);
            }
          }
          signal?.removeEventListener("abort", pending.onAbort);
          reject(abortSignalError(signal));
          this.#pump();
        },
        reject,
        resolve,
        settled: false,
        signal,
        slotHeld: false,
        started: false,
      };
      if (signal?.aborted) {
        pending.onAbort();
        return;
      }
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      this.#pending.push(pending);
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#active < this.maxConcurrent) {
      const pending = this.#pending.shift();
      if (!pending) {
        return;
      }
      if (pending.settled) {
        continue;
      }
      pending.started = true;
      pending.slotHeld = true;
      this.#active += 1;
      let lookupPromise: Promise<WebhookDnsLookupResult>;
      try {
        lookupPromise = this.lookupHostname(pending.hostname);
      } catch (error) {
        lookupPromise = Promise.reject(error);
      }
      void lookupPromise
        .then(
          (addresses) => {
            if (!pending.settled) {
              pending.settled = true;
              pending.resolve(addresses);
            }
          },
          (error: unknown) => {
            if (!pending.settled) {
              pending.settled = true;
              pending.reject(error);
            }
          },
        )
        .finally(() => {
          pending.signal?.removeEventListener("abort", pending.onAbort);
          this.#releaseSlot(pending);
        });
    }
  }

  #releaseSlot(pending: PendingWebhookDnsLookup): void {
    if (!pending.slotHeld) {
      return;
    }
    pending.slotHeld = false;
    this.#active -= 1;
    this.#pump();
  }
}

const webhookDnsLookupPool = new WebhookDnsLookupPool(MAX_CONCURRENT_WEBHOOK_DNS_LOOKUPS);

function abortSignalError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Webhook DNS lookup aborted", "AbortError");
}

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
    ["2410::", 12],
    ["2600::", 12],
    ["2610::", 23],
    ["2620::", 23],
    ["2630::", 12],
    ["2800::", 12],
    ["2a00::", 12],
    ["2a10::", 12],
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

function parseIpv6Hextets(address: string): number[] | undefined {
  const sections = address.split("::");
  if (sections.length > 2) {
    return undefined;
  }
  const parseSection = (section: string): number[] =>
    section
      ? section.split(":").flatMap((value) => {
          if (!value.includes(".")) {
            return [Number.parseInt(value, 16)];
          }
          const octets = value.split(".").map(Number);
          return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
        })
      : [];
  const leading = parseSection(sections[0]!);
  const trailing = parseSection(sections[1] ?? "");
  const omitted = sections.length === 2 ? 8 - leading.length - trailing.length : 0;
  const hextets = [...leading, ...Array.from({ length: omitted }, () => 0), ...trailing];
  return hextets.length === 8 ? hextets : undefined;
}

function ipv6Bytes(address: string): number[] | undefined {
  if (isIP(address) !== 6) {
    return undefined;
  }
  const hextets = parseIpv6Hextets(address);
  if (!hextets) {
    return undefined;
  }
  return hextets.flatMap((value) => [value >> 8, value & 0xff]);
}

function extractRfc6052Ipv4(bytes: readonly number[], prefixLength: Nat64PrefixLength): string {
  if (prefixLength === 96) {
    return bytes.slice(12, 16).join(".");
  }
  const prefixBytes = prefixLength / 8;
  const leadingIpv4Bytes = 8 - prefixBytes;
  return [...bytes.slice(prefixBytes, 8), ...bytes.slice(9, 9 + (4 - leadingIpv4Bytes))].join(".");
}

function prefixMatches(bytes: readonly number[], prefix: Nat64Prefix): boolean {
  const prefixBytes = prefix.length / 8;
  return prefix.bytes.slice(0, prefixBytes).every((value, index) => bytes[index] === value);
}

function nat64PrefixKey(prefix: Nat64Prefix): string {
  return `${prefix.length}:${prefix.bytes.slice(0, prefix.length / 8).join(".")}`;
}

function discoverNat64Prefixes(addresses: WebhookDnsLookupResult): Nat64Prefix[] | undefined {
  const candidates = new Map<string, { addresses: Set<string>; prefix: Nat64Prefix }>();
  let ipv6Answers = 0;
  for (const entry of addresses) {
    if (entry.family !== 6) {
      continue;
    }
    ipv6Answers++;
    const bytes = ipv6Bytes(normalizeHostname(entry.address));
    if (!bytes) {
      continue;
    }
    for (const length of RFC6052_PREFIX_LENGTHS) {
      if (length !== 96 && bytes[8] !== 0) {
        continue;
      }
      if (!IPV4ONLY_ADDRESSES.has(extractRfc6052Ipv4(bytes, length))) {
        continue;
      }
      const prefix = { bytes, length };
      const key = nat64PrefixKey(prefix);
      const candidate = candidates.get(key) ?? { addresses: new Set(), prefix };
      candidate.addresses.add(extractRfc6052Ipv4(bytes, length));
      candidates.set(key, candidate);
    }
  }
  if (ipv6Answers === 0) {
    return [];
  }
  const prefixes = [...candidates.values()]
    .filter((candidate) =>
      [...IPV4ONLY_ADDRESSES].every((address) => candidate.addresses.has(address)),
    )
    .map((candidate) => candidate.prefix);
  return prefixes.length > 0 ? prefixes : undefined;
}

const WELL_KNOWN_NAT64_PREFIX: Nat64Prefix = {
  bytes: ipv6Bytes("64:ff9b::")!,
  length: 96,
};

function embeddedNat64Ipv4Addresses(
  address: string,
  nat64Prefixes: readonly Nat64Prefix[],
): string[] {
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return [];
  }
  const addresses: string[] = [];
  for (const prefix of [WELL_KNOWN_NAT64_PREFIX, ...nat64Prefixes]) {
    if (prefixMatches(bytes, prefix)) {
      addresses.push(extractRfc6052Ipv4(bytes, prefix.length));
    }
  }
  return addresses;
}

function isBlockedWebhookAddress(
  address: string,
  nat64Prefixes: readonly Nat64Prefix[] = [],
): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    return (
      !GLOBAL_IPV4_EXCEPTIONS.check(normalized, "ipv4") &&
      BLOCKED_IPV4_ADDRESSES.check(normalized, "ipv4")
    );
  }
  if (family === 6) {
    if (
      embeddedNat64Ipv4Addresses(normalized, nat64Prefixes).some((embeddedIpv4) =>
        isBlockedWebhookAddress(embeddedIpv4),
      )
    ) {
      return true;
    }
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

async function resolveWebhookAddresses(
  hostname: string,
  signal?: AbortSignal,
  dnsLookupPool: Pick<WebhookDnsLookupPool, "resolve"> = webhookDnsLookupPool,
): Promise<WebhookAddress[]> {
  const normalized = normalizeHostname(hostname);
  const family = isIP(normalized);
  if (family === 4 || family === 6) {
    return [{ address: normalized, family }];
  }
  return (await dnsLookupPool.resolve(normalized, signal)).flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  );
}

export async function validateWebhookTarget(params: {
  allowLoopbackHttp: boolean;
  dnsLookupPool?: Pick<WebhookDnsLookupPool, "resolve"> | undefined;
  restrictPrivateAddresses: boolean;
  signal?: AbortSignal | undefined;
  url: URL;
}): Promise<ValidatedWebhookTarget> {
  const allowThisLoopbackHttp =
    params.url.protocol === "http:" &&
    params.allowLoopbackHttp &&
    isLoopbackHost(params.url.hostname);
  if (params.url.protocol !== "https:" && !allowThisLoopbackHttp) {
    return { error: "https-required" };
  }
  if (!params.restrictPrivateAddresses) {
    return { addresses: undefined };
  }

  let addresses: WebhookAddress[];
  try {
    addresses = await resolveWebhookAddresses(
      params.url.hostname,
      params.signal,
      params.dnsLookupPool,
    );
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    return { error: "unresolvable" };
  }
  if (addresses.length === 0) {
    return { error: "unresolvable" };
  }
  if (allowThisLoopbackHttp) {
    return addresses.every((entry) => isLoopbackHost(entry.address))
      ? { addresses }
      : { error: "private-address" };
  }
  if (addresses.some((entry) => isBlockedWebhookAddress(entry.address))) {
    return { error: "private-address" };
  }
  if (addresses.some((entry) => entry.family === 6)) {
    let nat64Prefixes: Nat64Prefix[] | undefined;
    try {
      nat64Prefixes = discoverNat64Prefixes(
        await (params.dnsLookupPool ?? webhookDnsLookupPool).resolve(
          "ipv4only.arpa",
          params.signal,
        ),
      );
    } catch (error) {
      if (params.signal?.aborted) {
        throw error;
      }
      return { error: "private-address" };
    }
    if (!nat64Prefixes) {
      return { error: "private-address" };
    }
    if (addresses.some((entry) => isBlockedWebhookAddress(entry.address, nat64Prefixes))) {
      return { error: "private-address" };
    }
  }
  return { addresses };
}

type PostWebhookRequestParams = {
  activeRequests?: Set<ClientRequest> | undefined;
  address?: WebhookAddress | undefined;
  body: string;
  headerEntries?: ReadonlyArray<readonly [string, string]> | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: URL;
};

async function sendWebhookRequest(
  params: PostWebhookRequestParams,
  resolveOnHeaders: boolean,
): Promise<WebhookResponse> {
  return await new Promise<WebhookResponse>((resolve, reject) => {
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
        agent: false,
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
        const result = {
          headers: incoming.headers,
          status: incoming.statusCode ?? 0,
        };
        if (resolveOnHeaders) {
          finish(() => {
            incoming.destroy();
            resolve(result);
          });
          return;
        }
        incoming.resume();
        incoming.once("error", (error) => finish(() => reject(error)));
        incoming.once("end", () => finish(() => resolve(result)));
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

export async function postWebhookRequestWithResponse(
  params: PostWebhookRequestParams,
): Promise<WebhookResponse> {
  return await sendWebhookRequest(params, true);
}

export async function postWebhookRequest(params: PostWebhookRequestParams): Promise<number> {
  return (await sendWebhookRequest(params, false)).status;
}
