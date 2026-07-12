import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type StartedWebhookServer = {
  close(): Promise<void>;
  endpointUrl: string;
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

async function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.length;
      if (bodyBytes > maxBodyBytes) {
        settled = true;
        request.resume();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

async function toFetchRequest(
  request: IncomingMessage,
  url: URL,
  maxBodyBytes: number,
): Promise<Request> {
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readRequestBody(request, maxBodyBytes);

  const init: RequestInit = {
    headers: request.headers as Record<string, string>,
  };
  if (request.method) {
    init.method = request.method;
  }
  if (body) {
    init.body = body;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function writeFetchResponse(
  response: ServerResponse<IncomingMessage>,
  fetchResponse: Response,
): Promise<void> {
  response.statusCode = fetchResponse.status;

  for (const [name, value] of fetchResponse.headers) {
    response.setHeader(name, value);
  }

  if (!fetchResponse.body) {
    response.end();
    return;
  }

  const body = Buffer.from(await fetchResponse.arrayBuffer());
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
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

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startWebhookServer(params: {
  handle(request: Request): Promise<Response>;
  host: string;
  maxBodyBytes?: number;
  methods?: readonly string[] | undefined;
  onError?: ((error: unknown) => void) | undefined;
  path: string;
  port: number;
}): Promise<StartedWebhookServer> {
  const methods = new Set(params.methods ?? ["POST"]);
  const maxBodyBytes = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (!methods.has(method) || url.pathname !== params.path) {
        request.resume();
        await writeFetchResponse(response, new Response("not found", { status: 404 }));
        return;
      }

      const fetchRequest = await toFetchRequest(request, url, maxBodyBytes);
      await writeFetchResponse(response, await params.handle(fetchRequest));
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 500;
      if (status === 500) {
        try {
          params.onError?.(error);
        } catch {
          // Error reporting must not change the public response.
        }
      }
      await writeFetchResponse(
        response,
        new Response(status === 413 ? "request body too large" : "internal server error", {
          status,
        }),
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
    throw new Error("Unable to resolve webhook server address.");
  }

  return {
    async close() {
      await closeServer(server);
    },
    endpointUrl: `http://${formatUrlHost(params.host)}:${address.port}${params.path}`,
  };
}
