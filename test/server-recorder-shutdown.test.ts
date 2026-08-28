import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  startCrablineServer,
  startTelegramServer,
  type StartedCrablineServer,
} from "../src/index.js";
import { createServerRecorder } from "../src/servers/recorder.js";

const persistence = vi.hoisted(() => ({
  filePath: "",
  beforeSync: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (String(args[0]) === persistence.filePath) {
        const sync = file.sync.bind(file);
        file.sync = async () => {
          await persistence.beforeSync?.();
          await sync();
        };
      }
      return file;
    },
  };
});
afterEach(() => {
  persistence.filePath = "";
  persistence.beforeSync = undefined;
});

it.each([
  "discord",
  "mattermost",
  "matrix",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
  "zalo",
] as const)(
  "%s drains persistence from an aborted request before successful close",
  async (channel) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "crabline-recorder-drain-")),
    );
    persistence.filePath = path.join(directory, "events.jsonl");
    const entered = deferred();
    const release = deferred();
    const observed = deferred();
    persistence.beforeSync = async () => {
      entered.resolve();
      await release.promise;
    };
    const server = await startCrablineServer({
      channel,
      onEvent: () => observed.resolve(),
      recorderPath: persistence.filePath,
    });
    const controller = new AbortController();
    const probe = nativeProbe(server);
    const response = fetch(probe.url, {
      ...probe.init,
      signal: controller.signal,
    }).catch(() => undefined);
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        response.then(() => {
          throw new Error("Probe ended before reaching persistence.");
        }),
      ]);
      controller.abort();
      await response;
      closing = server.close().then(() => {
        closed = true;
      });
      await delay(350);
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect((await readFile(persistence.filePath, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.race([observed.promise, delay(1000)]);
      await (closing ?? server.close());
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it.each(["reentrant", "stalled"] as const)(
  "closes with a %s event observer",
  async (mode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "crabline-observer-close-"));
    const entered = deferred();
    const release = deferred();
    let closing: Promise<void> | undefined;
    const server = await startTelegramServer({
      recorderPath: path.join(directory, "events.jsonl"),
      async onEvent() {
        entered.resolve();
        if (mode === "reentrant") {
          closing = server.close();
          await closing;
        } else {
          await release.promise;
        }
      },
    });
    const response = fetch(`${server.manifest.baseUrl}/bot${server.manifest.botToken}/getMe`).catch(
      () => undefined,
    );
    try {
      await entered.promise;
      const started = performance.now();
      await (closing ??= server.close());
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      release.resolve();
      await response;
      await (closing ?? server.close());
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it("rejects late recorder admissions without recreating artifacts after close", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crabline-recorder-closed-"));
  const recorder = createServerRecorder({
    recorderPath: path.join(directory, "missing", "events.jsonl"),
    onEvent: undefined,
  });
  await recorder.close();
  await rm(directory, { recursive: true, force: true });
  await expect(
    recorder.record({
      at: new Date().toISOString(),
      method: "GET",
      path: "/late",
      query: {},
      type: "api",
    }),
  ).rejects.toThrow("Server recorder is closed");
  await expect(readFile(path.join(directory, "missing", "events.jsonl"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeProbe(server: StartedCrablineServer): { url: string; init?: RequestInit } {
  const manifest = server.manifest;
  switch (manifest.provider) {
    case "discord":
      return {
        url: `${manifest.endpoints.apiRoot}/v10/users/@me`,
        init: { headers: { authorization: `Bot ${manifest.botToken}` } },
      };
    case "mattermost":
      return {
        url: `${manifest.endpoints.apiRoot}/users/me`,
        init: { headers: { authorization: `Bearer ${manifest.botToken}` } },
      };
    case "matrix":
      return {
        url: `${manifest.endpoints.clientApiRoot}/account/whoami`,
        init: { headers: { authorization: `Bearer ${manifest.accessToken}` } },
      };
    case "signal":
      return {
        url: manifest.endpoints.rpcUrl,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "version" }),
        },
      };
    case "slack":
      return {
        url: `${manifest.endpoints.apiRoot}auth.test`,
        init: { headers: { authorization: `Bearer ${manifest.botToken}` } },
      };
    case "telegram":
    case "zalo":
      return { url: `${manifest.baseUrl}/bot${manifest.botToken}/getMe` };
    case "whatsapp":
      return {
        url: manifest.endpoints.phoneNumberUrl,
        init: { headers: { authorization: `Bearer ${manifest.accessToken}` } },
      };
  }
}
