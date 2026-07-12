import { WebSocket, type WebSocketServer } from "ws";
import { DEFAULT_SERVER_SHUTDOWN_GRACE_MS } from "./http.js";

export async function closeWebSocketServer(
  server: WebSocketServer,
  graceMs = DEFAULT_SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const forceCloseTimer = setTimeout(() => {
      for (const client of server.clients) {
        client.terminate();
      }
    }, graceMs);
    forceCloseTimer.unref();

    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });

    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, "Server shutting down");
      } else if (client.readyState !== WebSocket.CLOSED) {
        client.terminate();
      }
    }
  });
}
