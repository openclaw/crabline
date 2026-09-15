import { once } from "node:events";
import { connect } from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { startDiscordServer, startMattermostServer } from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

describe.each([
  { provider: "discord", start: startDiscordServer, websocketPath: "/gateway" },
  { provider: "mattermost", start: startMattermostServer, websocketPath: "/api/v4/websocket" },
])("$provider WebSocket upgrades", ({ start, websocketPath }) => {
  it.each(["//[", "//[]/gateway", "http://[::1"])(
    "rejects malformed target %s and continues accepting clients",
    async (target) => {
      const directory = await createTempDir();
      try {
        const server = await start({ recorderPath: path.join(directory, "events.jsonl") });
        try {
          const url = new URL(server.manifest.baseUrl);
          const raw = connect({ host: url.hostname, port: Number(url.port) });
          const closed = once(raw, "close");
          try {
            await once(raw, "connect");
            let received = "";
            raw.on("data", (chunk: Buffer) => {
              received += chunk.toString("latin1");
            });
            let timedOut = false;
            raw.setTimeout(1_000, () => {
              timedOut = true;
              raw.destroy();
            });
            raw.write(
              `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
            );
            await closed;
            expect(timedOut).toBe(false);
            expect(received).toBe(
              "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
          } finally {
            raw.destroy();
            await closed;
          }

          const client = new WebSocket(`${url.origin.replace(/^http/u, "ws")}${websocketPath}`);
          try {
            await once(client, "open");
            expect(client.readyState).toBe(WebSocket.OPEN);
          } finally {
            const clientClosed = once(client, "close");
            client.close();
            await clientClosed;
          }
        } finally {
          await server.close();
        }
      } finally {
        await disposeTempDir(directory);
      }
    },
  );
});
