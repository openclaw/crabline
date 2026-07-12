import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  startMattermostServer,
  startWhatsAppServer,
  type StartedCrablineServer,
} from "../src/index.js";
import { startHttpJsonServer } from "../src/servers/http.js";

const servers: StartedCrablineServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("provider server shutdown", () => {
  it("forces active HTTP connections after the shutdown grace", async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const server = await startHttpJsonServer({
      async handle() {
        markRequestStarted();
        return await new Promise<Response>(() => undefined);
      },
      host: "127.0.0.1",
      port: 0,
      serverName: "shutdown test",
    });

    const pendingRequest = request(server.baseUrl);
    const requestClosed = new Promise<void>((resolve) => {
      pendingRequest.once("error", () => resolve());
      pendingRequest.once("close", () => resolve());
    });
    pendingRequest.end();
    await requestStarted;

    const startedAt = Date.now();
    await server.close();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await requestClosed;
  });

  it("terminates unresponsive Mattermost and WhatsApp WebSockets after the grace", async () => {
    const mattermost = await startMattermostServer();
    const whatsapp = await startWhatsAppServer();
    servers.push(mattermost, whatsapp);

    const mattermostSocket = await openRawWebSocket(mattermost.manifest.endpoints.websocketUrl);
    const whatsappSocket = await openRawWebSocket(whatsapp.manifest.endpoints.baileysWebSocketUrl);
    sockets.push(mattermostSocket, whatsappSocket);
    const socketsClosed = Promise.all([
      waitForSocketClose(mattermostSocket),
      waitForSocketClose(whatsappSocket),
    ]);

    const startedAt = Date.now();
    await Promise.all([mattermost.close(), whatsapp.close()]);
    await socketsClosed;
    servers.length = 0;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(mattermostSocket.destroyed).toBe(true);
    expect(whatsappSocket.destroyed).toBe(true);
  });
});

async function openRawWebSocket(websocketUrl: string): Promise<Socket> {
  const url = new URL(websocketUrl);
  const socket = connect(Number(url.port), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("\r\n\r\n")) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
  return socket;
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for socket close.")), 500);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
