import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CrablineError } from "../core/errors.js";

export type ServerRequestEvent = {
  at: string;
  body?: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
  type: "admin" | "api";
};

export const ADMIN_TOKEN_HEADER = "x-crabline-admin-token";
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export class InvalidJsonBodyError extends Error {
  constructor(cause: unknown) {
    super("Request body is not valid JSON.", { cause });
    this.name = "InvalidJsonBodyError";
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes} byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function drainRejectedRequest(request: IncomingMessage): void {
  const ignoreError = () => {};
  const cleanup = () => {
    request.off("close", cleanup);
    request.off("end", cleanup);
    request.off("error", ignoreError);
  };

  request.on("error", ignoreError);
  request.once("close", cleanup);
  request.once("end", cleanup);
  request.resume();
}

export async function readBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<Buffer> {
  const contentLengthHeader = request.headers["content-length"];
  const contentLengthValue = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader;
  if (contentLengthValue && /^\d+$/u.test(contentLengthValue)) {
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      drainRejectedRequest(request);
      throw new RequestBodyTooLargeError(maxBytes);
    }
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;

    const cleanup = () => {
      request.off("aborted", onAborted);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      drainRejectedRequest(request);
      cleanup();
      reject(error);
    };
    const onAborted = () => fail(new Error("Request body stream was aborted."));
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > maxBytes) {
        fail(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, length));
    };
    const onError = (error: Error) => fail(error);

    request.on("aborted", onAborted);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

export async function parseUnknownRequestBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  const body = await readBody(request, maxBytes);
  if (body.length === 0) {
    return {};
  }
  const contentType = request.headers["content-type"] ?? "";
  const includesJson = Array.isArray(contentType)
    ? contentType.some((entry) => entry.includes("json"))
    : contentType.includes("json");
  if (includesJson) {
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch (error) {
      throw new InvalidJsonBodyError(error);
    }
  }
  const params = new URLSearchParams(body.toString("utf8"));
  return Object.fromEntries(params.entries());
}

export async function parseRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return (await parseUnknownRequestBody(request, Number.MAX_SAFE_INTEGER)) as Record<
    string,
    unknown
  >;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function queryRecord(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

export function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export async function writeResponse(
  response: ServerResponse,
  fetchResponse: Response,
): Promise<void> {
  response.statusCode = fetchResponse.status;
  for (const [name, value] of fetchResponse.headers) {
    response.setHeader(name, value);
  }
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const closeIdleInterval = setInterval(() => server.closeIdleConnections(), 25);
    closeIdleInterval.unref();
    server.close((error) => {
      clearInterval(closeIdleInterval);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });
}

export async function startHttpJsonServer(params: {
  handle: (request: IncomingMessage) => Promise<Response>;
  handleError?: (error: unknown, request: IncomingMessage) => Response | undefined;
  host: string;
  port: number;
  serverName: string;
}): Promise<{ baseUrl: string; close(): Promise<void>; server: Server }> {
  const server = createServer(async (request, response) => {
    try {
      await writeResponse(response, await params.handle(request));
    } catch (error) {
      const handled = params.handleError?.(error, request);
      await writeResponse(
        response,
        handled ??
          jsonResponse(
            {
              error: error instanceof Error ? error.message : String(error),
              ok: false,
            },
            500,
          ),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, params.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new CrablineError(`Unable to resolve ${params.serverName} local server address.`, {
      kind: "connectivity",
    });
  }
  return {
    baseUrl: `http://${formatUrlHost(params.host)}:${address.port}`,
    async close() {
      await closeServer(server);
    },
    server,
  };
}

export function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

export function readTrimmedString(value: unknown): string | undefined {
  const stringValue = readString(value)?.trim();
  return stringValue ? stringValue : undefined;
}

export function readInteger(value: unknown): number | undefined {
  const stringValue = readTrimmedString(value);
  if (!stringValue || !/^-?\d+$/u.test(stringValue)) {
    return undefined;
  }
  return Number(stringValue);
}

function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const trimmed = authorization.trimStart();
  if (trimmed.slice(0, 7).toLowerCase() !== "bearer ") {
    return undefined;
  }
  return trimmed.slice(7);
}

export function hasAdminToken(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers[ADMIN_TOKEN_HEADER];
  const directToken = Array.isArray(header) ? header[0] : header;
  const providedToken = directToken ?? readBearerToken(request.headers.authorization);
  if (!providedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function adminAuthError(): Response {
  return new Response("unauthorized", {
    headers: { "www-authenticate": "Bearer" },
    status: 401,
  });
}
