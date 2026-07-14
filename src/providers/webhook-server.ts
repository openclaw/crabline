import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isCanonicalHttpPath } from "../core/http-path.js";
import {
  advertisedHostForBindAddress,
  assertLoopbackBindAddress,
  closeServer,
  drainRequestBody,
  formatUrlHost,
  writeFetchResponseHeaders,
} from "../servers/http.js";

export type StartedWebhookServer = {
  close(): Promise<void>;
  endpointUrl: string;
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;

class RequestBodyTooLargeError extends Error {}
class RequestBodyTimeoutError extends Error {}
class ResponseDeliveryClosedError extends Error {}

async function readRequestBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  bodyTimeoutMs: number,
): Promise<Buffer> {
  if (request.aborted) {
    throw new Error("request body aborted");
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      drainRequestBodyWithDeadline(request, bodyTimeoutMs);
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.length;
      if (bodyBytes > maxBodyBytes) {
        fail(new RequestBodyTooLargeError());
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
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("request body aborted"));
    const timeout = setTimeout(() => {
      fail(new RequestBodyTimeoutError());
    }, bodyTimeoutMs);

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    if (request.aborted) {
      onAborted();
    }
  });
}

function drainRequestBodyWithDeadline(request: IncomingMessage, bodyTimeoutMs: number): void {
  if (request.destroyed || request.readableEnded) {
    return;
  }
  const socket = request.socket;
  const timeout = setTimeout(() => socket.destroy(), bodyTimeoutMs);
  timeout.unref();
  const cleanup = () => {
    clearTimeout(timeout);
    request.off("end", cleanup);
    socket.off("close", cleanup);
  };
  request.once("end", cleanup);
  socket.once("close", cleanup);
  drainRequestBody(request);
}

async function toFetchRequest(
  request: IncomingMessage,
  url: URL,
  maxBodyBytes: number,
  bodyTimeoutMs: number,
): Promise<Request> {
  const requestBody = await readRequestBody(request, maxBodyBytes, bodyTimeoutMs);
  const body =
    request.method === "GET" || request.method === "HEAD" || requestBody.length === 0
      ? undefined
      : requestBody;

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
  writeFetchResponseHeaders(response, fetchResponse);

  const reader = fetchResponse.body?.getReader();
  let cancellation: Promise<void> | undefined;
  let rejectStopped!: (error: Error) => void;
  let stoppedError: Error | undefined;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  void stopped.catch(() => {});

  const cancelBody = (reason: Error) => {
    if (!reader || cancellation) {
      return;
    }
    cancellation = reader.cancel(reason).catch(() => {});
  };
  const stop = (error: Error) => {
    if (stoppedError) {
      return;
    }
    stoppedError = error;
    cancelBody(error);
    rejectStopped(error);
  };
  const onClose = () => {
    if (!response.writableFinished) {
      stop(new ResponseDeliveryClosedError("Webhook response delivery closed before completion."));
    }
  };
  const onError = (error: Error) => stop(error);
  response.once("close", onClose);
  response.once("error", onError);

  try {
    if (
      response.destroyed ||
      response.req?.aborted ||
      response.req?.socket.destroyed ||
      response.socket?.destroyed
    ) {
      throw new ResponseDeliveryClosedError("Webhook response delivery closed before it started.");
    }

    if (reader) {
      while (true) {
        const chunk = await Promise.race([reader.read(), stopped]);
        if (chunk.done) {
          break;
        }
        if (chunk.value.byteLength > 0 && !response.write(chunk.value)) {
          let onDrain!: () => void;
          const drained = new Promise<void>((resolve) => {
            onDrain = resolve;
            response.once("drain", onDrain);
          });
          try {
            await Promise.race([drained, stopped]);
          } finally {
            response.off("drain", onDrain);
          }
        }
      }
    }

    let onFinish!: () => void;
    const finished = new Promise<void>((resolve) => {
      onFinish = resolve;
      response.once("finish", onFinish);
    });
    try {
      response.end();
      await Promise.race([finished, stopped]);
    } finally {
      response.off("finish", onFinish);
    }
  } catch (error) {
    cancelBody(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    response.off("close", onClose);
    response.off("error", onError);
  }
}

function clearUnsentResponseHeaders(response: ServerResponse<IncomingMessage>): void {
  if (response.headersSent) {
    return;
  }
  for (const name of response.getHeaderNames()) {
    response.removeHeader(name);
  }
}

export async function startWebhookServer(params: {
  handle(request: Request): Promise<Response>;
  bodyTimeoutMs?: number | undefined;
  host: string;
  maxBodyBytes?: number;
  methods?: readonly string[] | undefined;
  onError?: ((error: unknown) => void) | undefined;
  path: string;
  port: number;
  shutdownGraceMs?: number | undefined;
}): Promise<StartedWebhookServer> {
  if (!isCanonicalHttpPath(params.path)) {
    throw new Error("Webhook path must be a canonical URL pathname.");
  }
  const methods = new Set(params.methods ?? ["POST"]);
  const maxBodyBytes = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("Webhook maxBodyBytes must be a positive safe integer.");
  }
  const bodyTimeoutMs = params.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  let closing = false;
  const server = createServer(async (request, response) => {
    try {
      if (closing) {
        drainRequestBodyWithDeadline(request, bodyTimeoutMs);
        await writeFetchResponse(
          response,
          new Response("provider is shutting down", {
            headers: { connection: "close" },
            status: 503,
          }),
        );
        return;
      }
      const method = request.method ?? "GET";
      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (!methods.has(method) || url.pathname !== params.path) {
        drainRequestBodyWithDeadline(request, bodyTimeoutMs);
        await writeFetchResponse(response, new Response("not found", { status: 404 }));
        return;
      }

      const fetchRequest = await toFetchRequest(request, url, maxBodyBytes, bodyTimeoutMs);
      await writeFetchResponse(response, await params.handle(fetchRequest));
    } catch (error) {
      if (error instanceof ResponseDeliveryClosedError) {
        response.destroy();
        return;
      }
      const status =
        error instanceof RequestBodyTooLargeError
          ? 413
          : error instanceof RequestBodyTimeoutError
            ? 408
            : 500;
      if (status === 500) {
        try {
          params.onError?.(error);
        } catch {
          // Error reporting must not change the public response.
        }
      }
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      clearUnsentResponseHeaders(response);
      try {
        await writeFetchResponse(
          response,
          new Response(
            status === 413
              ? "request body too large"
              : status === 408
                ? "request body timeout"
                : "internal server error",
            {
              ...(status === 408 || status === 413 ? { headers: { connection: "close" } } : {}),
              status,
            },
          ),
        );
      } catch {
        response.destroy();
      }
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
  try {
    assertLoopbackBindAddress(params.host, address.address, "Webhook server");
  } catch (error) {
    await closeServer(server, params.shutdownGraceMs);
    throw error;
  }
  const advertisedHost = advertisedHostForBindAddress(params.host, address.address);

  let closingPromise: Promise<void> | null = null;
  return {
    async close() {
      closing = true;
      closingPromise ??= closeServer(server, params.shutdownGraceMs);
      await closingPromise;
    },
    endpointUrl: `http://${formatUrlHost(advertisedHost)}:${address.port}${params.path}`,
  };
}
