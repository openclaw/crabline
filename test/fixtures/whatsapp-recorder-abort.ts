import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { inspect } from "node:util";
import { deflateSync, Inflate } from "node:zlib";
import {
  encodeBinaryNode,
  initAuthCreds,
  makeWASocket,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "baileys";
import { startWhatsAppServer, type StartedWhatsAppServer } from "../../src/servers/whatsapp.js";
import type { ServerRequestEvent } from "../../src/servers/http.js";
import { WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES } from "../../src/servers/whatsapp-wire/binary-node.js";
import { createTempDir, disposeTempDir } from "../test-helpers.js";

function fence<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing milestone: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function memoryKeys(): SignalKeyStore {
  const values = new Map<string, unknown>();
  return {
    async get(type, ids) {
      const result: Record<string, unknown> = {};
      for (const id of ids) {
        const value = values.get(`${type}.${id}`);
        if (value !== undefined) {
          result[id] = value;
        }
      }
      return result as { [id: string]: SignalDataTypeMap[typeof type] };
    },
    async set(data) {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value === null) {
            values.delete(`${type}.${id}`);
          } else {
            values.set(`${type}.${id}`, value);
          }
        }
      }
    },
  };
}

const logger = {
  child: () => logger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  level: "silent",
  trace: () => undefined,
  warn: () => undefined,
};
const marker = {
  attrs: { id: "pre-aborted-recorder-marker", to: "s.whatsapp.net", type: "get", xmlns: "w:p" },
  content: [{ attrs: {}, tag: "ping" }],
  tag: "iq",
};
const encoded = encodeBinaryNode(marker);
const compressed = deflateSync(encoded.subarray(1));
const observerSentinel = new Error("pre-aborted-recorder-observer-sentinel");
const milestones: string[] = [];
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
  process.exitCode = 1;
  process.stderr.write(`UNHANDLED ${inspect(reason, { depth: 5 })}\n`);
});

function milestone(name: string) {
  milestones.push(name);
  process.stdout.write(`milestone: ${name}\n`);
}

function isMarker(event: ServerRequestEvent): boolean {
  const body = event.body as { attrs?: { id?: string } } | undefined;
  return event.method === "WEBSOCKET" && body?.attrs?.id === marker.attrs.id;
}

type InflateResult = { buffer: Buffer; engine: Inflate };
type InflateCallback = (error: Error | null, result?: InflateResult) => void;
type NativeInflate = Inflate & {
  cb: InflateCallback;
  _info: boolean;
  _maxOutputLength: number;
};

// Observe construction, then gate only this instance's real completion delivery.
// Node's native owner/callback shape is deliberately checked, never mocked globally.
function holdNativeInflate() {
  const delivered = fence();
  const failed = fence<Error>();
  let armed = true;
  let captures = 0;
  let callbacks = 0;
  let invocations = 0;
  let input: Buffer | undefined;
  let engine: NativeInflate | undefined;
  let original: InflateCallback | undefined;
  let held: Parameters<InflateCallback> | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    failed.resolve(error);
  };
  const hook = createHook({
    init(_id, type, _trigger, resource: object) {
      if (!armed || type !== "ZLIB") {
        return;
      }
      queueMicrotask(() => {
        if (!armed) {
          return;
        }
        try {
          const handle = resource as { buffer?: unknown; [key: symbol]: unknown };
          assert(Buffer.isBuffer(handle.buffer), "Native ZLIB resource has no input Buffer");
          if (!handle.buffer.equals(compressed)) {
            return;
          }
          const owners = Object.getOwnPropertySymbols(handle).filter(
            (symbol) => symbol.description === "owner_symbol",
          );
          assert.equal(owners.length, 1, "Native ZLIB owner_symbol shape changed");
          const owner = handle[owners[0]!];
          assert(owner instanceof Inflate, "Matching native ZLIB owner is not Inflate");
          const candidate = owner as NativeInflate;
          const { _info: info, _maxOutputLength: maxOutputLength } = candidate;
          assert.equal(info, true, "Native Inflate info option changed");
          assert.equal(maxOutputLength, WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES);
          assert.equal(typeof candidate.cb, "function", "Native Inflate cb shape changed");
          assert.equal(++captures, 1, "More than one matching native Inflate instance");
          input = Buffer.from(handle.buffer);
          engine = candidate;
          original = candidate.cb;
          candidate.cb = (...args) => {
            callbacks += 1;
            if (held) {
              fail(new Error("Native Inflate delivered more than one callback"));
              return;
            }
            held = args;
            delivered.resolve();
          };
        } catch (error) {
          fail(new Error("Native Inflate instance seam failed", { cause: error }));
        }
      });
    },
  }).enable();
  return {
    ready: Promise.race([
      delivered.promise,
      failed.promise.then((error) => {
        throw error;
      }),
    ]),
    verify() {
      assert.equal(failure, undefined, failure?.stack);
      assert.equal(captures, 1);
      assert.equal(callbacks, 1);
      assert.deepEqual(input, compressed);
      assert(held, "Native Inflate completion was not captured");
      assert.equal(held[0], null, "Actual native Inflate failed");
      assert(held[1], "Actual native Inflate did not return info");
      assert.equal(held[1].engine, engine);
      assert.equal(engine?.bytesWritten, compressed.length);
      assert.deepEqual(held[1].buffer, encoded.subarray(1));
    },
    release() {
      if (engine && original) {
        engine.cb = original;
        if (held && invocations === 0) {
          invocations += 1;
          original.apply(engine, held);
        }
      }
    },
    stop() {
      armed = false;
      hook.disable();
      this.release();
    },
    proof() {
      this.verify();
      assert.equal(invocations, 1);
      assert.equal(engine?.cb, original, "Native Inflate callback was not restored");
      return {
        captures,
        callbacks,
        invocations,
        inputBytes: input?.length,
        bytesWritten: engine?.bytesWritten,
      };
    },
  };
}

async function run() {
  const directory = await createTempDir();
  const recorderPath = path.join(directory, "pre-aborted.jsonl");
  const observerEntered = fence();
  const observerRelease = fence();
  const observerSettled = fence<unknown>();
  const clientClosed = fence();
  let observerStarted = false;
  let observerReleased = false;
  let server: StartedWhatsAppServer | undefined;
  let socket: ReturnType<typeof makeWASocket> | undefined;
  let inflate: ReturnType<typeof holdNativeInflate> | undefined;
  let closeMs: number | undefined;
  let durableRecords = 0;
  try {
    server = await startWhatsAppServer({
      recorderPath,
      onEvent(event) {
        if (!isMarker(event)) {
          return;
        }
        assert.equal(observerStarted, false, "Marker observer entered twice");
        observerStarted = true;
        observerEntered.resolve();
        const observation = (async () => {
          await observerRelease.promise;
          throw observerSentinel;
        })();
        // This fence observes only our callback, never the escaped outer recorder promise.
        void observation.then(observerSettled.resolve, observerSettled.resolve);
        return observation;
      },
    });
    socket = makeWASocket({
      auth: {
        creds: {
          ...initAuthCreds(),
          me: { id: "15550000001:0@s.whatsapp.net", name: "Crabline Test Bot" },
        },
        keys: memoryKeys(),
      },
      browser: ["crabline", "test", "1.0"],
      connectTimeoutMs: 2_000,
      defaultQueryTimeoutMs: 750,
      fireInitQueries: false,
      keepAliveIntervalMs: 10_000,
      logger,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      syncFullHistory: false,
      waWebSocketUrl: server.manifest.endpoints.baileysWebSocketUrl,
      version: [2, 3000, 1035194821],
    });
    const clientOpen = fence();
    socket.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        clientOpen.resolve();
      }
      if (update.connection === "close") {
        clientClosed.resolve();
      }
    });
    await within(clientOpen.promise, "Baileys connection ready");
    milestone("client-ready");
    const barrier = await within(
      socket.query({ ...marker, attrs: { ...marker.attrs, id: "pre-abort-iq-barrier" } }),
      "IQ readiness barrier",
    );
    assert.equal(barrier?.attrs.id, "pre-abort-iq-barrier");
    assert.equal(barrier.attrs.type, "result");
    milestone("iq-barrier");

    inflate = holdNativeInflate();
    await Promise.all([
      within(
        socket.sendRawMessage(Buffer.concat([Buffer.from([2]), compressed])),
        "encrypted compressed send",
      ),
      within(inflate.ready, "actual native Inflate completion held"),
    ]);
    inflate.verify();
    assert.equal(observerStarted, false);
    milestone("native-inflate-held");

    const started = performance.now();
    const closing = server.close();
    const closeBound = within(closing, "close while observer held (1000ms)", 1_000);
    const concurrent = server.close();
    assert.equal(concurrent, closing);
    milestone("close-started-before-decode-release");
    inflate.release();
    milestone("native-decode-released");
    await Promise.all([closeBound, within(observerEntered.promise, "marker observer entered")]);
    closeMs = performance.now() - started;
    assert(closeMs < 1_000, `Close exceeded lifecycle bound: ${closeMs}ms`);
    assert.equal(observerReleased, false);
    milestone("closed-with-observer-held");
    await within(server.close(), "repeated close", 1_000);
    milestone("repeated-close");
    const events = (await readFile(recorderPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ServerRequestEvent);
    const matches = events.filter(isMarker);
    durableRecords = matches.length;
    assert.equal(durableRecords, 1);
    assert.deepEqual(matches[0]?.body, marker);
    milestone("one-durable-marker");

    observerReleased = true;
    observerRelease.resolve();
    assert.equal(
      await within(observerSettled.promise, "observer rejection settlement"),
      observerSentinel,
    );
    milestone("observer-rejected-and-settled");
  } finally {
    inflate?.stop();
    observerRelease.resolve();
    // Unstick both gates before joining owned work or removing its recorder directory.
    const cleanup = await Promise.allSettled([
      ...(server ? [within(server.close(), "cleanup server close", 1_000)] : []),
      ...(socket
        ? [
            within(
              (async () => {
                await socket.end(undefined);
                await clientClosed.promise;
              })(),
              "owned Baileys teardown",
            ),
          ]
        : []),
      ...(observerStarted ? [within(observerSettled.promise, "cleanup observer settlement")] : []),
    ]);
    const errors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    assert.equal(errors.length, 0, `Cleanup did not settle: ${inspect(errors)}`);
    if (observerStarted) {
      await within(observerSettled.promise, "observer settlement after serialized handler drain");
    }
    milestone("owned-work-settled");
    await checkpoint();
    milestone("event-loop-checkpoint");
    await disposeTempDir(directory);
    milestone("temporary-directory-removed");
  }
  const native = inflate?.proof();
  process.stdout.write(
    `proof: ${JSON.stringify({ node: process.version, execPath: process.execPath, milestones, native, closeMs, durableRecords, unhandledRejections: unhandled.length })}\n`,
  );
  assert.equal(
    unhandled.length,
    0,
    `Expected zero TOTAL unhandledRejection events; received ${inspect(unhandled)}`,
  );
}

process.stdout.write(`runtime: ${process.execPath} ${process.version}\n`);
await run().catch((error: unknown) => {
  process.stderr.write(`${inspect(error, { depth: 5 })}\n`);
  process.stderr.write(`Completed milestones: ${milestones.join(", ")}\n`);
  process.exitCode = 1;
});
