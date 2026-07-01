import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  adminAuthError,
  closeServer,
  hasAdminToken,
  jsonResponse,
  parseRequestBody,
  queryRecord,
  readInteger,
  readTrimmedString,
  type ServerRequestEvent,
  writeResponse,
} from "./http.js";

type SignalServerState = {
  account: string;
  adminToken: string;
  clients: Set<ServerResponse>;
  nextTimestamp: number;
  pendingEvents: string[];
  recorderPath: string;
};

export type SignalServerManifest = {
  account: string;
  adminToken: string;
  baseUrl: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
    eventsUrl: string;
    rpcUrl: string;
  };
  env: Record<string, never>;
  provider: "signal";
  recorderPath: string;
  version: 1;
};

export type StartedSignalServer = {
  close(): Promise<void>;
  manifest: SignalServerManifest;
};

export type StartSignalServerParams = {
  account?: string | undefined;
  adminToken?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  recorderPath?: string | undefined;
};

async function appendEvent(state: SignalServerState, event: ServerRequestEvent): Promise<void> {
  await fs.mkdir(path.dirname(state.recorderPath), { recursive: true });
  await fs.appendFile(state.recorderPath, `${JSON.stringify(event)}\n`, "utf8");
}

function rpcResponse(id: unknown, result: unknown): Response {
  return jsonResponse({ id: id ?? null, jsonrpc: "2.0", result });
}

function emitSignalEvent(state: SignalServerState, payload: unknown): void {
  const event = `event: receive\ndata: ${JSON.stringify(payload)}\n\n`;
  if (state.clients.size === 0) {
    state.pendingEvents.push(event);
    return;
  }
  for (const client of state.clients) {
    client.write(event);
  }
}

async function handleAdminInbound(params: {
  body: Record<string, unknown>;
  state: SignalServerState;
}): Promise<Response> {
  const text = readTrimmedString(params.body.text);
  const sourceNumber = readTrimmedString(params.body.sourceNumber ?? params.body.senderId);
  if (!text || !sourceNumber) {
    return jsonResponse({ error: "sourceNumber and text are required", ok: false }, 400);
  }
  const timestamp = readInteger(params.body.timestamp) ?? params.state.nextTimestamp++;
  const groupId = readTrimmedString(params.body.groupId);
  const payload = {
    envelope: {
      sourceName: readTrimmedString(params.body.sourceName ?? params.body.senderName),
      sourceNumber,
      timestamp,
      dataMessage: {
        message: text,
        timestamp,
        ...(groupId ? { groupInfo: { groupId } } : {}),
      },
    },
  };
  emitSignalEvent(params.state, payload);
  return jsonResponse({ event: payload, ok: true });
}

async function handleRpc(params: {
  body: Record<string, unknown>;
  state: SignalServerState;
}): Promise<Response> {
  const method = readTrimmedString(params.body.method);
  if (!method) {
    return jsonResponse(
      {
        error: { code: -32600, message: "Invalid Request" },
        id: params.body.id ?? null,
        jsonrpc: "2.0",
      },
      400,
    );
  }
  if (method === "version") {
    return rpcResponse(params.body.id, { version: "crabline-signal-1" });
  }
  if (["send", "sendReaction", "sendReceipt", "sendTyping"].includes(method)) {
    const timestamp = params.state.nextTimestamp++;
    return rpcResponse(params.body.id, method === "sendTyping" ? {} : { timestamp });
  }
  return jsonResponse({
    error: { code: -32601, message: `Method not found: ${method}` },
    id: params.body.id ?? null,
    jsonrpc: "2.0",
  });
}

async function handleRequest(params: {
  request: IncomingMessage;
  response: ServerResponse;
  state: SignalServerState;
}): Promise<void> {
  const url = new URL(params.request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/v1/events" && params.request.method === "GET") {
    await appendEvent(params.state, {
      at: new Date().toISOString(),
      method: "GET",
      path: url.pathname,
      query: queryRecord(url),
      type: "api",
    });
    params.response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    params.response.flushHeaders();
    params.state.clients.add(params.response);
    for (const event of params.state.pendingEvents.splice(0)) {
      params.response.write(event);
    }
    params.response.once("close", () => params.state.clients.delete(params.response));
    return;
  }

  let fetchResponse: Response;
  if (url.pathname === "/crabline/signal/inbound" && params.request.method === "POST") {
    if (!hasAdminToken(params.request, params.state.adminToken)) {
      fetchResponse = adminAuthError();
    } else {
      const body = await parseRequestBody(params.request);
      await appendEvent(params.state, {
        at: new Date().toISOString(),
        body,
        method: "POST",
        path: url.pathname,
        query: queryRecord(url),
        type: "admin",
      });
      fetchResponse = await handleAdminInbound({ body, state: params.state });
    }
  } else if (url.pathname === "/api/v1/check" && params.request.method === "GET") {
    await appendEvent(params.state, {
      at: new Date().toISOString(),
      method: "GET",
      path: url.pathname,
      query: queryRecord(url),
      type: "api",
    });
    fetchResponse = jsonResponse({ ok: true });
  } else if (url.pathname === "/api/v1/rpc" && params.request.method === "POST") {
    const body = await parseRequestBody(params.request);
    await appendEvent(params.state, {
      at: new Date().toISOString(),
      body,
      method: "POST",
      path: url.pathname,
      query: queryRecord(url),
      type: "api",
    });
    fetchResponse = await handleRpc({ body, state: params.state });
  } else {
    fetchResponse = new Response("not found", { status: 404 });
  }
  await writeResponse(params.response, fetchResponse);
}

export async function startSignalServer(
  params: StartSignalServerParams = {},
): Promise<StartedSignalServer> {
  const state: SignalServerState = {
    account: params.account ?? "+15550000000",
    adminToken: params.adminToken ?? randomBytes(24).toString("base64url"),
    clients: new Set(),
    nextTimestamp: Date.now(),
    pendingEvents: [],
    recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "signal.jsonl"),
  };
  const host = params.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handleRequest({ request, response, state }).catch(async (error) => {
      if (!response.headersSent) {
        await writeResponse(
          response,
          jsonResponse(
            { error: error instanceof Error ? error.message : String(error), ok: false },
            500,
          ),
        );
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to resolve Signal local server address.");
  }
  const baseUrl = `http://${host}:${address.port}`;
  return {
    async close() {
      for (const client of state.clients) {
        client.end();
      }
      await closeServer(server);
    },
    manifest: {
      account: state.account,
      adminToken: state.adminToken,
      baseUrl,
      endpoints: {
        adminInboundUrl: `${baseUrl}/crabline/signal/inbound`,
        apiRoot: baseUrl,
        eventsUrl: `${baseUrl}/api/v1/events`,
        rpcUrl: `${baseUrl}/api/v1/rpc`,
      },
      env: {},
      provider: "signal",
      recorderPath: state.recorderPath,
      version: 1,
    },
  };
}
