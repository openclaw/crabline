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

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function parseRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (body.length === 0) {
    return {};
  }
  const contentType = request.headers["content-type"] ?? "";
  const includesJson = Array.isArray(contentType)
    ? contentType.some((entry) => entry.includes("json"))
    : contentType.includes("json");
  if (includesJson) {
    return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  }
  const params = new URLSearchParams(body.toString("utf8"));
  return Object.fromEntries(params.entries());
}

export function queryRecord(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startHttpJsonServer(params: {
  handle: (request: IncomingMessage) => Promise<Response>;
  host: string;
  port: number;
  serverName: string;
}): Promise<{ baseUrl: string; close(): Promise<void>; server: Server }> {
  const server = createServer(async (request, response) => {
    try {
      await writeResponse(response, await params.handle(request));
    } catch (error) {
      await writeResponse(
        response,
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
    baseUrl: `http://${params.host.includes(":") ? `[${params.host}]` : params.host}:${address.port}`,
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
