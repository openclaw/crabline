import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type StartedWebhookServer = {
  close(): Promise<void>;
  endpointUrl: string;
};

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readRequestBody(request);

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

export async function startWebhookServer(params: {
  handle(request: Request): Promise<Response>;
  host: string;
  methods?: readonly string[] | undefined;
  path: string;
  port: number;
}): Promise<StartedWebhookServer> {
  const methods = new Set(params.methods ?? ["POST"]);
  const server = createServer(async (request, response) => {
    try {
      const fetchRequest = await toFetchRequest(request);
      const pathname = new URL(fetchRequest.url).pathname;
      if (!methods.has(fetchRequest.method) || pathname !== params.path) {
        await writeFetchResponse(response, new Response("not found", { status: 404 }));
        return;
      }

      await writeFetchResponse(response, await params.handle(fetchRequest));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFetchResponse(response, new Response(message, { status: 500 }));
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
    endpointUrl: `http://${params.host}:${address.port}${params.path}`,
  };
}
