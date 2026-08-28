import { request, type IncomingMessage } from "node:http";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  CRABLINE_SERVER_CHANNELS,
  startCrablineServer,
  type StartedCrablineServer,
} from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const io = vi.hoisted(() => ({
  path: "",
  entered: () => {},
  blocked: Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (args[0] === io.path) {
        io.entered();
        await io.blocked;
      }
      return await actual.realpath(...args);
    },
  };
});

function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

describe("server recorder lifecycle", () => {
  it("fences a Telegram admin handler queued behind an observer after close", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "events.jsonl");
    const firstEntered = gate();
    const releaseFirst = gate();
    const secondObserved = gate();
    let observations = 0;
    const server = await startCrablineServer({
      channel: "telegram",
      recorderPath,
      async onEvent() {
        if (++observations === 1) {
          firstEntered.release();
          await releaseFirst.pending;
        } else {
          secondObserved.release();
        }
      },
    });
    const requests: ReturnType<typeof request>[] = [];
    const send = () => {
      const pending = request(server.manifest.endpoints.adminInboundUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-crabline-admin-token": server.manifest.adminToken,
        },
      });
      pending.on("error", () => {});
      pending.end(JSON.stringify({ chatId: "123456", text: "queued inbound" }));
      requests.push(pending);
    };
    let secondRequest: IncomingMessage | undefined;
    const port = Number(new URL(server.manifest.baseUrl).port);
    const onRequest = (message: unknown) => {
      const candidate = (message as { request: IncomingMessage }).request;
      if (candidate.socket.localPort === port) {
        secondRequest = candidate;
      }
    };
    let lateIo = 0;
    let closing: Promise<void> | undefined;
    try {
      send();
      await firstEntered.pending;
      subscribe("http.server.request.start", onRequest);
      send();
      await expect.poll(() => secondRequest?.readableEnded).toBe(true);
      closing = server.close();
      expect(await closeWithinGrace(closing)).toBe("closed");
      await disposeTempDir(directory);
      io.path = recorderPath;
      io.entered = () => {
        lateIo++;
      };
      io.blocked = Promise.resolve();
      releaseFirst.release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(lateIo).toBe(0);
      expect(observations).toBe(1);
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      unsubscribe("http.server.request.start", onRequest);
      releaseFirst.release();
      for (const pending of requests) {
        pending.destroy();
      }
      if (lateIo > 0) {
        await secondObserved.pending;
      }
      io.path = "";
      await closing;
      await server.close().catch(() => {});
      await disposeTempDir(directory);
    }
  }, 20_000);

  it.each(CRABLINE_SERVER_CHANNELS)(
    "%s allows an observer to await concurrent and repeated close",
    async (channel) => {
      const directory = await createTempDir();
      const recorderPath = path.join(directory, "events.jsonl");
      const entered = gate();
      const releaseObserver = gate();
      let closing: Promise<void> | undefined;
      const server = await startCrablineServer({
        channel,
        recorderPath,
        async onEvent() {
          closing = Promise.all([server.close(), server.close()]).then(() => {});
          entered.release();
          await Promise.race([closing, releaseObserver.pending]);
        },
      });
      const pendingRequest = apiRequest(server);
      pendingRequest.on("error", () => {});
      try {
        pendingRequest.end();
        await entered.pending;
        expect(await closeWithinGrace(closing!)).toBe("closed");
        await server.close();
        expect((await readFile(recorderPath, "utf8")).trim().split("\n")).toHaveLength(1);
      } finally {
        releaseObserver.release();
        pendingRequest.destroy();
        await closing?.catch(() => {});
        await server.close().catch(() => {});
        await disposeTempDir(directory);
      }
    },
    20_000,
  );

  it("joins lock cleanup after an initial mtime-probe failure", async () => {
    const directory = await createTempDir();
    const recorderPath = path.join(directory, "events.jsonl");
    const lockPath = `${recorderPath}.lock`;
    const server = await startCrablineServer({ channel: "telegram", recorderPath });
    const entered = gate();
    const release = gate();
    const removed = gate();
    const utimes = fs.utimes.bind(fs);
    const rename = fs.rename.bind(fs);
    const utimesSpy = vi
      .spyOn(fs, "utimes")
      .mockImplementation((target, atime, mtime, callback) => {
        if (String(target) === lockPath) {
          callback(Object.assign(new Error("synthetic mtime-probe failure"), { code: "EIO" }));
          return;
        }
        utimes(target, atime, mtime, callback);
      });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation((source, target, callback) => {
      if (String(source) === lockPath) {
        entered.release();
        void release.pending.then(() =>
          rename(source, target, (error) => {
            callback(error);
            removed.release();
          }),
        );
        return;
      }
      rename(source, target, callback);
    });
    const pendingRequest = apiRequest(server);
    pendingRequest.on("error", () => {});
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      pendingRequest.end();
      await entered.pending;
      pendingRequest.destroy();
      closing = server.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(closed).toBe(false);
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      release.release();
      await closing;
      await removed.pending;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.release();
      pendingRequest.destroy();
      await removed.pending;
      await (closing ?? server.close());
      utimesSpy.mockRestore();
      renameSpy.mockRestore();
      await disposeTempDir(directory);
    }
  }, 20_000);

  it("allows Telegram admin observers to close without waiting on their own admission", async () => {
    const directory = await createTempDir();
    const entered = gate();
    const releaseObserver = gate();
    let closing: Promise<void> | undefined;
    const server = await startCrablineServer({
      channel: "telegram",
      recorderPath: path.join(directory, "events.jsonl"),
      async onEvent() {
        closing = server.close();
        entered.release();
        await Promise.race([closing, releaseObserver.pending]);
      },
    });
    const pendingRequest = request(server.manifest.endpoints.adminInboundUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": server.manifest.adminToken,
      },
    });
    pendingRequest.on("error", () => {});
    try {
      pendingRequest.end(JSON.stringify({ chatId: "123456", text: "synthetic inbound" }));
      await entered.pending;
      expect(await closeWithinGrace(closing!)).toBe("closed");
      await server.close();
    } finally {
      releaseObserver.release();
      pendingRequest.destroy();
      await closing?.catch(() => {});
      await server.close().catch(() => {});
      await disposeTempDir(directory);
    }
  }, 20_000);

  it("allows Discord Gateway observers to close and callers to repeat close", async () => {
    const directory = await createTempDir();
    const entered = gate();
    const releaseObserver = gate();
    let closing: Promise<void> | undefined;
    const server = await startCrablineServer({
      channel: "discord",
      recorderPath: path.join(directory, "events.jsonl"),
      async onEvent() {
        closing = server.close();
        entered.release();
        await Promise.race([closing, releaseObserver.pending]);
      },
    });
    const socket = new WebSocket(server.manifest.endpoints.gatewayUrl);
    socket.on("error", () => {});
    socket.once("open", () => socket.send(JSON.stringify({ op: 1, d: null })));
    try {
      await entered.pending;
      expect(await closeWithinGrace(closing!)).toBe("closed");
      await server.close();
    } finally {
      releaseObserver.release();
      socket.terminate();
      await closing?.catch(() => {});
      await server.close().catch(() => {});
      await disposeTempDir(directory);
    }
  }, 20_000);

  it.each(["discord", "mattermost"] as const)(
    "%s drains persistence and closes HTTP when WebSocket close fails",
    async (channel) => {
      const directory = await createTempDir();
      const entered = gate();
      const release = gate();
      const observed = gate();
      const recorderPath = path.join(directory, "events.jsonl");
      io.path = recorderPath;
      io.entered = entered.release;
      io.blocked = release.pending;
      const server = await startCrablineServer({
        channel,
        recorderPath,
        onEvent: observed.release,
      });
      const port = Number(new URL(server.manifest.baseUrl).port);
      const pendingRequest = apiRequest(server);
      pendingRequest.on("error", () => {});
      let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
      let closing: Promise<unknown> | undefined;
      let replacement: StartedCrablineServer | undefined;
      let settled = false;
      try {
        pendingRequest.end();
        await entered.pending;
        closeSpy = vi
          .spyOn(WebSocketServer.prototype, "close")
          .mockImplementationOnce((callback) =>
            callback?.(new Error("synthetic WebSocket close failure")),
          );
        closing = server
          .close()
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect.soft(settled).toBe(false);
        release.release();
        expect(await closing).toMatchObject({ message: "synthetic WebSocket close failure" });
        replacement = await startCrablineServer({ channel, port, recorderPath });
      } finally {
        release.release();
        closeSpy?.mockRestore();
        pendingRequest.destroy();
        await observed.pending;
        await closing;
        await server.close().catch(() => {});
        await replacement?.close();
        io.path = "";
        await disposeTempDir(directory);
      }
    },
    20_000,
  );
});

function apiRequest(server: StartedCrablineServer) {
  const m = server.manifest;
  const apiPath =
    m.provider === "telegram" || m.provider === "zalo"
      ? `/bot${m.botToken}/getMe`
      : m.provider === "whatsapp"
        ? `/${m.graphVersion}/${m.phoneNumberId}`
        : {
            discord: "/api/v10/users/@me",
            mattermost: "/api/v4/users/me",
            matrix: "/_matrix/client/versions",
            signal: "/api/v1/check",
            slack: "/api/auth.test",
          }[m.provider];
  const token = "botToken" in m ? m.botToken : "accessToken" in m ? m.accessToken : "";
  return request(`${m.baseUrl}${apiPath}`, {
    headers: { authorization: `${m.provider === "discord" ? "Bot" : "Bearer"} ${token}` },
  });
}

async function closeWithinGrace(closing: Promise<void>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closing.then(
        () => "closed",
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
