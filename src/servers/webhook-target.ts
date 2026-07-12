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

const BLOCKED_WEBHOOK_ADDRESSES = createBlockedWebhookAddresses();

function createBlockedWebhookAddresses(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv4");
    const octets = address.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    blockList.addSubnet(`::ffff:${high.toString(16)}:${low.toString(16)}`, 96 + prefix, "ipv6");
  }
  for (const [address, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  return blockList;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/u, "$1").replace(/%25/gu, "%");
}

function isBlockedWebhookAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(normalized)?.[1];
  if (mappedIpv4) {
    return BLOCKED_WEBHOOK_ADDRESSES.check(mappedIpv4, "ipv4");
  }
  const family = isIP(normalized);
  return family === 4
    ? BLOCKED_WEBHOOK_ADDRESSES.check(normalized, "ipv4")
    : family === 6
      ? BLOCKED_WEBHOOK_ADDRESSES.check(normalized, "ipv6")
      : false;
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
