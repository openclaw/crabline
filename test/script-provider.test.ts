import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureErrorMessage } from "../src/core/errors.js";
import { ScriptProviderAdapter } from "../src/providers/builtin/script.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir, writeText } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const createContext = async (watchTrailingNewline = true): Promise<ProviderContext> => {
  const directory = await createTempDir();
  directories.push(directory);

  const probeScript = path.join(directory, "probe.mjs");
  const sendScript = path.join(directory, "send.mjs");
  const waitScript = path.join(directory, "wait.mjs");
  const watchScript = path.join(directory, "watch.mjs");

  await writeText(
    probeScript,
    'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({healthy:true,details:["ok"]})));',
  );
  await writeText(
    sendScript,
    'let raw="";process.stdin.on("data",(c)=>raw+=c);process.stdin.on("end",()=>{const input=JSON.parse(raw);process.stdout.write(JSON.stringify({accepted:true,messageId:"sent-1",threadId:input.outbound.target.id}));});',
  );
  await writeText(
    waitScript,
    'let raw="";process.stdin.on("data",(c)=>raw+=c);process.stdin.on("end",()=>{const input=JSON.parse(raw);process.stdout.write(JSON.stringify({message:{author:"assistant",id:"inbound-1",sentAt:new Date().toISOString(),text:`ACK ${input.wait.nonce}`,threadId:input.wait.target.id}}));});',
  );
  await writeText(
    watchScript,
    `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({author:"assistant",id:"watch-1",sentAt:new Date().toISOString(),text:"watch payload",threadId:"thread-1"})${watchTrailingNewline ? '+ "\\n"' : ""}));`,
  );

  return {
    config: {
      adapter: "script",
      capabilities: ["probe", "send", "roundtrip", "agent"],
      env: [],
      platform: "slack",
      script: {
        commands: {
          probe: `node ${probeScript}`,
          send: `node ${sendScript}`,
          waitForInbound: `node ${waitScript}`,
          watch: `node ${watchScript}`,
        },
      },
      status: "active",
    },
    fixture: {
      env: [],
      id: "fixture",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "roundtrip",
      provider: "scripted",
      retries: 0,
      tags: [],
      target: { id: "thread-1", metadata: {} },
      timeoutMs: 1000,
    },
    manifestPath: path.join(directory, "crabline.yaml"),
    providerId: "scripted",
    userName: "crabline",
  };
};

describe("script provider", () => {
  it("probes, sends, waits, and watches", async () => {
    const context = await createContext();
    const provider = new ScriptProviderAdapter(context);

    expect((await provider.probe(context)).healthy).toBe(true);
    expect(
      await provider.send({
        ...context,
        mode: "roundtrip",
        nonce: "mp-fixture-abc-1234abcd",
        text: "payload",
      }),
    ).toEqual({
      accepted: true,
      messageId: "sent-1",
      threadId: "thread-1",
    });

    const inbound = await provider.waitForInbound({
      ...context,
      nonce: "mp-fixture-abc-1234abcd",
      since: new Date().toISOString(),
      timeoutMs: 1000,
    });
    expect(inbound?.text).toContain("ACK mp-fixture-abc-1234abcd");

    const iterator = provider.watch?.({ ...context });
    const watched = iterator ? await iterator[Symbol.asyncIterator]().next() : undefined;
    expect(watched?.value?.id).toBe("watch-1");
  });

  it("yields a final watch message without a trailing newline", async () => {
    const context = await createContext(false);
    const provider = new ScriptProviderAdapter(context);
    const iterator = provider.watch?.({ ...context });
    const watched = iterator ? await iterator[Symbol.asyncIterator]().next() : undefined;

    expect(watched?.value?.id).toBe("watch-1");
  });

  it("allows normal watch completion after stdout closes", async () => {
    const context = await createContext();
    const watchScript = path.join(path.dirname(context.manifestPath), "watch-delayed-exit.mjs");
    await writeText(watchScript, "process.stdout.end();setTimeout(()=>process.exit(0),1100);");
    context.config.script!.commands.watch = `node ${watchScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(provider.watch(context).next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("preserves UTF-8 code points split across watch stdout chunks", async () => {
    const context = await createContext();
    const watchScript = path.join(path.dirname(context.manifestPath), "watch-split-utf8.mjs");
    await writeText(
      watchScript,
      'const line=Buffer.from(JSON.stringify({author:"assistant",id:"watch-split",sentAt:new Date().toISOString(),text:"split \\u{1f98a} output",threadId:"thread-1"})+"\\n");const split=line.indexOf(0xf0)+2;process.stdout.write(line.subarray(0,split));setTimeout(()=>process.stdout.write(line.subarray(split)),25);',
    );
    context.config.script!.commands.watch = `node ${watchScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(provider.watch(context).next()).resolves.toMatchObject({
      done: false,
      value: {
        id: "watch-split",
        text: "split \u{1f98a} output",
      },
    });
  });

  it("preserves UTF-8 code points split across watch stderr chunks", async () => {
    const context = await createContext();
    const watchScript = path.join(path.dirname(context.manifestPath), "watch-split-stderr.mjs");
    await writeText(
      watchScript,
      "process.stderr.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>{process.stderr.write(Buffer.from([0xa6,0x8a]));process.exitCode=7;},25);",
    );
    context.config.script!.commands.watch = `node ${watchScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(provider.watch(context).next()).rejects.toThrow(/\u{1f98a}/u);
  });

  it("stops the watch subprocess when iteration ends early", async () => {
    const context = await createContext();
    const watchScript = path.join(path.dirname(context.manifestPath), "watch-leaking.mjs");
    await writeText(
      watchScript,
      'process.stdout.write(JSON.stringify({author:"assistant",id:String(process.pid),sentAt:new Date().toISOString(),text:"watch payload",threadId:"thread-1"})+"\\n");setInterval(()=>{},1000);',
    );
    const provider = new ScriptProviderAdapter({
      ...context,
      config: {
        ...context.config,
        script: {
          ...context.config.script!,
          commands: {
            ...context.config.script!.commands,
            watch: `node ${watchScript}`,
          },
        },
      },
    });
    const iterator = provider.watch?.({ ...context })?.[Symbol.asyncIterator]();
    const watched = iterator ? await iterator.next() : undefined;
    const pid = Number(watched?.value?.id);
    expect(Number.isInteger(pid)).toBe(true);

    await iterator?.return?.();

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`watch subprocess ${pid} is still running`);
  });

  it("cancels a silent watch while next is pending", async () => {
    const context = await createContext();
    const directory = path.dirname(context.manifestPath);
    const pidPath = path.join(directory, "silent-watch.pid");
    const watchScript = path.join(directory, "watch-silent.mjs");
    await writeText(
      watchScript,
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`,
    );
    context.config.script!.commands.watch = `node ${watchScript}`;
    const provider = new ScriptProviderAdapter(context);
    const iterator = provider.watch(context);
    const pending = iterator.next();

    let pid = 0;
    await expect
      .poll(async () => {
        try {
          pid = Number(await readFile(pidPath, "utf8"));
          return Number.isInteger(pid) && pid > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);

    await expect(iterator.return()).resolves.toMatchObject({ done: true });
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(waitForProcessExit(pid, 2000)).resolves.toBe(true);
  });

  it("does not spawn commands for already-aborted signals", async () => {
    const context = await createContext();
    const markerPath = path.join(path.dirname(context.manifestPath), "aborted-spawned");
    const command = `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(markerPath)},"spawned")`)}`;
    context.config.script!.commands.waitForInbound = command;
    context.config.script!.commands.watch = command;
    const provider = new ScriptProviderAdapter(context);
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce",
        signal: controller.signal,
        since: new Date().toISOString(),
        timeoutMs: 100,
      }),
    ).rejects.toThrow("already aborted");
    await expect(provider.watch({ ...context, signal: controller.signal }).next()).rejects.toThrow(
      "already aborted",
    );
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "stops descendants that hold watch pipes after the leader exits",
    async () => {
      const context = await createContext();
      const watchScript = path.join(path.dirname(context.manifestPath), "watch-descendant.mjs");
      await writeText(
        watchScript,
        'import {spawn} from "node:child_process";const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","ignore"]});descendant.unref();process.stdout.write(JSON.stringify({author:"assistant",id:String(descendant.pid),raw:{leaderPid:process.pid},sentAt:new Date().toISOString(),text:"watch payload",threadId:"thread-1"})+"\\n");',
      );
      context.config.script!.commands.watch = `exec node ${JSON.stringify(watchScript)}`;
      const provider = new ScriptProviderAdapter(context);
      const iterator = provider.watch(context);
      let descendantPid = 0;
      let descendantExited = false;
      try {
        const watched = await iterator.next();
        descendantPid = Number(watched.value?.id);
        const leaderPid = Number(
          (watched.value?.raw as { leaderPid?: number } | undefined)?.leaderPid,
        );
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(Number.isInteger(leaderPid)).toBe(true);
        await expect(waitForProcessExit(leaderPid, 2000)).resolves.toBe(true);

        const returnPromise = iterator.return();
        let timeout: NodeJS.Timeout | undefined;
        const stopped = await Promise.race([
          returnPromise.then(() => true),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), 1000);
          }),
        ]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (!stopped) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The descendant may have exited at the timeout boundary.
          }
          await returnPromise;
          throw new Error("watch cleanup waited for a descendant-held pipe");
        }

        descendantExited = await waitForProcessExit(descendantPid, 2000);
        expect(descendantExited).toBe(true);
      } finally {
        if (descendantPid > 0 && !descendantExited) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The expected cleanup path already stopped the descendant.
          }
        }
        await iterator.return();
      }
    },
  );

  it("enforces command deadlines in the parent process", async () => {
    const context = await createContext();
    const sendScript = path.join(path.dirname(context.manifestPath), "send-hanging.mjs");
    await writeText(sendScript, "process.stdin.resume();setInterval(()=>{},1000);");
    context.fixture.timeoutMs = 100;
    context.config.script!.commands.send = `node ${sendScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      }),
    ).rejects.toThrow(/timed out after 100ms/u);
  });

  it("allows wait commands to report timeout at their documented deadline", async () => {
    const context = await createContext();
    const waitScript = path.join(path.dirname(context.manifestPath), "wait-timeout.mjs");
    await writeText(
      waitScript,
      'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{const input=JSON.parse(raw);setTimeout(()=>process.stdout.write(JSON.stringify({timeout:true})),input.wait.timeoutMs);});',
    );
    context.config.script!.commands.waitForInbound = `node ${waitScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce",
        since: new Date().toISOString(),
        timeoutMs: 50,
      }),
    ).resolves.toBeNull();
  });

  it("passes excluded inbound IDs to stateless wait commands", async () => {
    const context = await createContext();
    const waitScript = path.join(path.dirname(context.manifestPath), "wait-exclusions.mjs");
    await writeText(
      waitScript,
      'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{const input=JSON.parse(raw);process.stdout.write(JSON.stringify({message:{author:"assistant",id:"inbound-after-exclusions",sentAt:new Date().toISOString(),text:JSON.stringify(input.wait.excludeIds),threadId:"thread-1"}}));});',
    );
    context.config.script!.commands.waitForInbound = `node ${waitScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.waitForInbound({
        ...context,
        excludeIds: ["seen-1", "seen-2"],
        nonce: "nonce",
        since: new Date().toISOString(),
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ text: '["seen-1","seen-2"]' });
  });

  it("passes the accepted outbound thread ID to wait commands", async () => {
    const context = await createContext();
    const waitScript = path.join(path.dirname(context.manifestPath), "wait-thread.mjs");
    await writeText(
      waitScript,
      'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{const input=JSON.parse(raw);process.stdout.write(JSON.stringify({message:{author:"assistant",id:"inbound-thread",sentAt:new Date().toISOString(),text:input.wait.threadId,threadId:input.wait.threadId}}));});',
    );
    context.config.script!.commands.waitForInbound = `node ${waitScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce",
        since: new Date().toISOString(),
        threadId: "accepted-thread",
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ text: "accepted-thread", threadId: "accepted-thread" });
  });

  it("rejects inbound messages returned during the wait exit grace", async () => {
    const context = await createContext();
    const waitScript = path.join(path.dirname(context.manifestPath), "wait-late-message.mjs");
    await writeText(
      waitScript,
      'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{const input=JSON.parse(raw);setTimeout(()=>process.stdout.write(JSON.stringify({message:{author:"assistant",id:"late-inbound",sentAt:new Date().toISOString(),text:`ACK ${input.wait.nonce}`,threadId:input.wait.target.id}})),input.wait.timeoutMs+50);});',
    );
    context.config.script!.commands.waitForInbound = `node ${waitScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce",
        since: new Date().toISOString(),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/u);
  });

  it("rejects commands that exceed the output limit", async () => {
    const context = await createContext();
    const sendScript = path.join(path.dirname(context.manifestPath), "send-noisy.mjs");
    await writeText(
      sendScript,
      'process.stdin.resume();process.stdout.write("x".repeat(1024*1024+1));',
    );
    context.config.script!.commands.send = `node ${sendScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      }),
    ).rejects.toThrow(/exceeded 1048576 bytes of output/u);
  });

  it("validates script JSON result contracts at runtime", async () => {
    const context = await createContext();
    const probeScript = path.join(path.dirname(context.manifestPath), "probe-invalid.mjs");
    await writeText(
      probeScript,
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({healthy:"yes"})));',
    );
    context.config.script!.commands.probe = `node ${probeScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(provider.probe(context)).rejects.toThrow(/returned invalid result.*healthy/isu);

    const waitScript = path.join(path.dirname(context.manifestPath), "wait-invalid.mjs");
    await writeText(
      waitScript,
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("{}"));',
    );
    context.config.script!.commands.waitForInbound = `node ${waitScript}`;

    await expect(
      provider.waitForInbound({
        ...context,
        nonce: "nonce",
        since: new Date().toISOString(),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/either a message or timeout: true/u);
  });

  it("reports watch subprocess failures after emitted messages", async () => {
    const context = await createContext();
    const watchScript = path.join(path.dirname(context.manifestPath), "watch-failing.mjs");
    await writeText(
      watchScript,
      'process.stdout.write(JSON.stringify({author:"assistant",id:"watch-before-failure",sentAt:new Date().toISOString(),text:"watch payload",threadId:"thread-1"})+"\\n");process.stderr.write("watch exploded");process.exitCode=7;',
    );
    context.config.script!.commands.watch = `node ${watchScript}`;
    const provider = new ScriptProviderAdapter(context);
    const iterator = provider.watch(context)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "watch-before-failure" },
    });
    await expect(iterator.next()).rejects.toThrow(/watch exploded/u);
  });

  it("reports watch subprocess spawn failures without crashing", async () => {
    const context = await createContext();
    const sentinel = "redact-me";
    const command = `CRABLINE_PRIVATE_VALUE=${sentinel} node watch.mjs`;
    context.config.script!.commands.send = command;
    context.config.script!.commands.watch = command;
    context.config.script!.shell = path.join(path.dirname(context.manifestPath), "missing-shell");
    const provider = new ScriptProviderAdapter(context);

    for (const operation of [
      () =>
        provider.send({
          ...context,
          mode: "send" as const,
          nonce: "nonce",
          text: "payload",
        }),
      () => provider.watch(context).next(),
    ]) {
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        failure = error;
      }
      expect(ensureErrorMessage(failure)).toMatch(/failed to start/u);
      expect(inspect(failure, { depth: null })).not.toContain(command);
      expect(inspect(failure, { depth: null })).not.toContain(sentinel);
    }
  });

  it("redacts every configured command from diagnostics", async () => {
    const context = await createContext();
    const configuredWatchCommand = "node /private/watch-command.mjs --opaque-value";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-other-command.mjs");
    await writeText(
      failingScript,
      `process.stderr.write(${JSON.stringify(configuredWatchCommand)});process.exitCode=7;`,
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
    context.config.script!.commands.watch = configuredWatchCommand;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);

    expect(ensureErrorMessage(failure)).toContain("[configured script command]");
    expect(inspect(failure, { depth: null })).not.toContain(configuredWatchCommand);
  });

  it("redacts bare positional command arguments from diagnostics", async () => {
    const context = await createContext();
    const sentinel = "bare-positional-secret";
    const failingScript = path.join(
      path.dirname(context.manifestPath),
      "send-positional-secret.mjs",
    );
    await writeText(
      failingScript,
      "process.stderr.write(`failed with ${process.argv[2]}`);process.exitCode=7;",
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} ${JSON.stringify(sentinel)}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    const message = ensureErrorMessage(failure);

    expect(message).toContain("failed with [redacted command value]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it("redacts attached option and dash-prefixed command values", async () => {
    const context = await createContext();
    const optionSentinel = "attached-option-secret";
    const positionalSentinel = "-dash-positional-secret";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-option-secret.mjs");
    await writeText(
      failingScript,
      "process.stderr.write(`${process.argv[2]} ${process.argv[3]}`);process.exitCode=7;",
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} --label=${optionSentinel} ${positionalSentinel}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    const message = ensureErrorMessage(failure);

    expect(message).toContain("--label=[redacted command value]");
    expect(message).toContain("[redacted command value]");
    expect(inspect(failure, { depth: null })).not.toContain(optionSentinel);
    expect(inspect(failure, { depth: null })).not.toContain(positionalSentinel);
  });

  it("redacts short command values when diagnostics append punctuation", async () => {
    const context = await createContext();
    const sentinel = "abc123";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-short-secret.mjs");
    await writeText(
      failingScript,
      `process.stderr.write(${JSON.stringify(`${sentinel}-invalid`)});process.exitCode=7;`,
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} --label=${sentinel}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);

    expect(ensureErrorMessage(failure)).toContain("[redacted command value]-invalid");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it("redacts values parsed from attached short options", async () => {
    const context = await createContext();
    const sentinel = "short-option-secret";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-short-option.mjs");
    await writeText(
      failingScript,
      "process.stderr.write(process.argv[2].slice(2));process.exitCode=7;",
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} -p${sentinel}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);

    expect(ensureErrorMessage(failure)).toContain("[redacted command value]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it("redacts values parsed from bare double-dash arguments", async () => {
    const context = await createContext();
    const sentinel = "double-dash-secret";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-double-dash.mjs");
    await writeText(
      failingScript,
      "process.stderr.write(process.argv[2].slice(2));process.exitCode=7;",
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} --${sentinel}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);

    expect(ensureErrorMessage(failure)).toContain("[redacted command value]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it("redacts command values before overlapping payload fragments", async () => {
    const context = await createContext();
    const payloadValue = "fixture-fragment";
    const commandValue = `prefix-${payloadValue}-suffix`;
    const failingScript = path.join(path.dirname(context.manifestPath), "send-overlap.mjs");
    await writeText(failingScript, "process.stderr.write(process.argv[2]);process.exitCode=7;");
    context.fixture.target.metadata = {
      [["private", "Value"].join("")]: payloadValue,
    };
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} ${commandValue}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);

    expect(ensureErrorMessage(failure)).toContain("[redacted command value]");
    expect(inspect(failure, { depth: null })).not.toContain(commandValue);
  });

  it.each(["--opaque:fixture-value", "-opaque.fixture-value"])(
    "suppresses diagnostics for unsupported option syntax %s",
    async (argument) => {
      const context = await createContext();
      const sentinel = "fixture-value";
      const failingScript = path.join(
        path.dirname(context.manifestPath),
        "send-unsupported-option.mjs",
      );
      await writeText(
        failingScript,
        `process.stderr.write(${JSON.stringify(sentinel)});process.exitCode=7;`,
      );
      context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} ${argument}`;
      const provider = new ScriptProviderAdapter(context);

      const failure = await provider
        .send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        })
        .catch((error: unknown) => error);

      expect(ensureErrorMessage(failure)).toContain("[script diagnostics redacted]");
      expect(inspect(failure, { depth: null })).not.toContain(sentinel);
    },
  );

  it("suppresses diagnostics when positional arguments require shell expansion", async () => {
    const context = await createContext();
    const sentinel = "expanded-positional-secret";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-expanded-secret.mjs");
    await writeText(
      failingScript,
      `process.stderr.write(${JSON.stringify(sentinel)});process.exitCode=7;`,
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} secret-*`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    const message = ensureErrorMessage(failure);

    expect(message).toContain("[script diagnostics redacted]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it.each([
    {
      commandPrefix: ":\n",
      name: "newlines",
      suffix: "",
    },
    {
      commandPrefix: "",
      name: "brace expansion",
      suffix: " opaque-{one,two}",
    },
  ])("suppresses diagnostics for unsafe shell $name", async ({ commandPrefix, suffix }) => {
    const context = await createContext();
    const sentinel = "unsafe-shell-secret";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-unsafe-shell.mjs");
    await writeText(
      failingScript,
      `process.stderr.write(${JSON.stringify(sentinel)});process.exitCode=7;`,
    );
    context.config.script!.commands.send = `${commandPrefix}node ${JSON.stringify(failingScript)}${suffix}`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    const message = ensureErrorMessage(failure);

    expect(message).toContain("[script diagnostics redacted]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it("suppresses diagnostics when quoted arguments use shell continuations", async () => {
    const context = await createContext();
    const sentinel = "continued-positional-secret";
    const failingScript = path.join(
      path.dirname(context.manifestPath),
      "send-continued-secret.mjs",
    );
    await writeText(
      failingScript,
      `process.stderr.write(${JSON.stringify(sentinel)});process.exitCode=7;`,
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)} "continued\\\nsecret"`;
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);
    const message = ensureErrorMessage(failure);

    expect(message).toContain("[script diagnostics redacted]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
  });

  it("redacts the sensitive environment snapshot used for a subprocess", async () => {
    const context = await createContext();
    const envName = ["CRABLINE", "ACCESS", "TOKEN"].join("_");
    const originalValue = process.env[envName];
    const inheritedValue = "inherited-before-spawn";
    const replacementValue = "changed-after-spawn";
    const failingScript = path.join(path.dirname(context.manifestPath), "send-delayed-env.mjs");
    await writeText(
      failingScript,
      `setTimeout(()=>{process.stderr.write(process.env[${JSON.stringify(envName)}]);process.exitCode=7;},25);`,
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
    const provider = new ScriptProviderAdapter(context);
    process.env[envName] = inheritedValue;

    try {
      const pending = provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      });
      process.env[envName] = replacementValue;
      const failure = await pending.catch((error: unknown) => error);

      expect(ensureErrorMessage(failure)).toContain("[redacted environment value]");
      expect(inspect(failure, { depth: null })).not.toContain(inheritedValue);
    } finally {
      if (originalValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalValue;
      }
    }
  });

  it("wraps synchronous spawn validation failures", async () => {
    const context = await createContext();
    const command = "node private-command.mjs";
    context.config.script!.commands.send = command;
    context.config.script!.shell = "invalid\u0000shell";
    const provider = new ScriptProviderAdapter(context);

    const failure = await provider
      .send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      })
      .catch((error: unknown) => error);

    expect(ensureErrorMessage(failure)).toContain("Script command failed to start");
    expect(inspect(failure, { depth: null })).not.toContain(command);
  });

  it("validates watched JSON message contracts", async () => {
    const context = await createContext();
    const watchScript = path.join(path.dirname(context.manifestPath), "watch-invalid.mjs");
    await writeText(
      watchScript,
      'process.stdout.write(JSON.stringify({author:"bot",id:"watch-1",sentAt:new Date().toISOString(),text:"watch payload",threadId:"thread-1"})+"\\n");',
    );
    context.config.script!.commands.watch = `node ${watchScript}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(provider.watch(context).next()).rejects.toThrow(
      /returned invalid result.*author/isu,
    );
  });

  it("redacts configured command text from script errors", async () => {
    const context = await createContext();
    const sentinel = "redact-me";
    const inlineEnvName = ["DB", "PWD"].join("");
    const failingScript = path.join(path.dirname(context.manifestPath), "send-secret.mjs");
    await writeText(
      failingScript,
      'process.stderr.write(process.env[["DB","PWD"].join("")]);process.exitCode=7;',
    );
    const command = `${inlineEnvName}+=${sentinel} node ${JSON.stringify(failingScript)}`;
    context.config.script!.commands.send = command;
    const provider = new ScriptProviderAdapter(context);

    let sendError: unknown;
    try {
      await provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      });
    } catch (error) {
      sendError = error;
    }

    expect(ensureErrorMessage(sendError)).toContain("Script command failed");
    expect(ensureErrorMessage(sendError)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(sendError)).not.toContain(command);
    expect(ensureErrorMessage(sendError)).not.toContain(sentinel);

    const watchScript = path.join(path.dirname(context.manifestPath), "watch-secret.mjs");
    await writeText(watchScript, "process.stderr.write(process.argv[2]);process.exitCode=8;");
    const watchCommand = `node ${JSON.stringify(watchScript)} "--access-token=${sentinel}"`;
    context.config.script!.commands.watch = watchCommand;

    let watchError: unknown;
    try {
      await provider.watch(context).next();
    } catch (error) {
      watchError = error;
    }

    expect(ensureErrorMessage(watchError)).toContain("Script watch command failed");
    expect(ensureErrorMessage(watchError)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(watchError)).not.toContain(watchCommand);
    expect(ensureErrorMessage(watchError)).not.toContain(sentinel);

    const powershellCommand =
      `node ${JSON.stringify(watchScript)} ${sentinel} ` +
      `'${"${env:"}${inlineEnvName}}=${sentinel}'`;
    context.config.script!.commands.watch = powershellCommand;

    let powershellError: unknown;
    try {
      await provider.watch(context).next();
    } catch (error) {
      powershellError = error;
    }

    expect(ensureErrorMessage(powershellError)).toContain("[script diagnostics redacted]");
    expect(ensureErrorMessage(powershellError)).not.toContain(sentinel);
  });

  it("redacts secret values carried in the script payload", async () => {
    const context = await createContext();
    const sentinel = 'configured\n"payload"\\secret';
    const shared = { value: sentinel };
    const numericMarker = Number(["123", "456", "789"].join(""));
    const malformedMetadata = context.fixture.target.metadata as unknown as Record<string, unknown>;
    malformedMetadata.public = shared;
    malformedMetadata.accessToken = shared;
    malformedMetadata[["api", "Key"].join("")] = numericMarker;
    const failingScript = path.join(path.dirname(context.manifestPath), "send-payload-secret.mjs");
    await writeText(
      failingScript,
      'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{const input=JSON.parse(raw);const numeric=Object.values(input.fixture.target.metadata).find((value)=>typeof value==="number");process.stderr.write(`${JSON.stringify(input.fixture.target.metadata.public.value)} ${numeric}`);process.exitCode=7;});',
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
    const provider = new ScriptProviderAdapter(context);

    let failure: unknown;
    try {
      await provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      });
    } catch (error) {
      failure = error;
    }

    expect(ensureErrorMessage(failure)).toContain("[redacted configured value]");
    expect(inspect(failure, { depth: null })).not.toContain(sentinel);
    expect(inspect(failure, { depth: null })).not.toContain(JSON.stringify(sentinel));
    expect(inspect(failure, { depth: null })).not.toContain(String(numericMarker));
  });

  it("redacts the immutable payload snapshot sent to delayed commands", async () => {
    const context = await createContext();
    const originalValue = "sent-before-mutation";
    const replacementValue = "replacement-after-spawn";
    const sensitiveKey = ["access", "Token"].join("");
    context.fixture.target.metadata[sensitiveKey] = originalValue;
    const directory = path.dirname(context.manifestPath);
    const sendScript = path.join(directory, "send-delayed-payload-redaction.mjs");
    const watchScript = path.join(directory, "watch-delayed-payload-redaction.mjs");
    const delayedFailure =
      'let raw="";process.stdin.on("data",(chunk)=>raw+=chunk);process.stdin.on("end",()=>{const input=JSON.parse(raw);setTimeout(()=>{process.stderr.write(input.fixture.target.metadata[["access","Token"].join("")]);process.exitCode=7;},25);});';
    await writeText(sendScript, delayedFailure);
    await writeText(watchScript, delayedFailure);
    context.config.script!.commands.send = `node ${JSON.stringify(sendScript)}`;
    context.config.script!.commands.watch = `node ${JSON.stringify(watchScript)}`;
    const provider = new ScriptProviderAdapter(context);

    const sending = provider.send({
      ...context,
      mode: "send",
      nonce: "nonce",
      text: "payload",
    });
    context.fixture.target.metadata[sensitiveKey] = replacementValue;
    const sendError = await sending.catch((error: unknown) => error);

    expect(ensureErrorMessage(sendError)).toContain("[redacted configured value]");
    expect(inspect(sendError, { depth: null })).not.toContain(originalValue);

    context.fixture.target.metadata[sensitiveKey] = originalValue;
    const watching = provider.watch(context).next();
    context.fixture.target.metadata[sensitiveKey] = replacementValue;
    const watchError = await watching.catch((error: unknown) => error);

    expect(ensureErrorMessage(watchError)).toContain("[redacted configured value]");
    expect(inspect(watchError, { depth: null })).not.toContain(originalValue);
  });

  it("redacts inherited secret values from script diagnostics", async () => {
    const context = await createContext();
    const sentinel = "fixture-redaction-value\nsecond-line\n";
    const envName = ["GITHUB", "PAT"].join("");
    const keySentinel = "fixture-key-value";
    const keyEnvName = ["SIGNING", "KEY"].join("_");
    const compoundSentinel = "fixture-compound-value";
    const compoundEnvName = ["ACCESS", "TOKEN"].join("");
    const shortSentinel = "123";
    const shortEnvName = ["DB", "PWD"].join("_");
    const originalValues = new Map([
      [envName, process.env[envName]],
      [keyEnvName, process.env[keyEnvName]],
      [compoundEnvName, process.env[compoundEnvName]],
      [shortEnvName, process.env[shortEnvName]],
    ]);
    process.env[envName] = sentinel;
    process.env[keyEnvName] = keySentinel;
    process.env[compoundEnvName] = compoundSentinel;
    process.env[shortEnvName] = shortSentinel;

    try {
      const failingScript = path.join(path.dirname(context.manifestPath), "send-env-secret.mjs");
      await writeText(
        failingScript,
        'process.stderr.write(`failed: ${JSON.stringify(process.env[["GITHUB","PAT"].join("")])} ${process.env[["SIGNING","KEY"].join("_")]} ${process.env[["ACCESS","TOKEN"].join("")]} ${process.env[["DB","PWD"].join("_")]}`);process.exitCode=7;',
      );
      context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
      const provider = new ScriptProviderAdapter(context);

      let sendError: unknown;
      try {
        await provider.send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        });
      } catch (error) {
        sendError = error;
      }

      expect(ensureErrorMessage(sendError)).toContain(
        "failed: [redacted environment value] [redacted environment value] [redacted environment value] [redacted environment value]",
      );
      expect(ensureErrorMessage(sendError)).not.toContain("fixture-redaction-value");
      expect(ensureErrorMessage(sendError)).not.toContain("second-line");
      expect(ensureErrorMessage(sendError)).not.toContain(keySentinel);
      expect(ensureErrorMessage(sendError)).not.toContain(compoundSentinel);
      expect(ensureErrorMessage(sendError)).not.toContain(shortSentinel);

      const watchScript = path.join(path.dirname(context.manifestPath), "watch-env-secret.mjs");
      await writeText(
        watchScript,
        'process.stderr.write(`watch: ${process.env[["GITHUB","PAT"].join("")]} ${process.env[["SIGNING","KEY"].join("_")]} ${process.env[["ACCESS","TOKEN"].join("")]} ${process.env[["DB","PWD"].join("_")]}`);process.exitCode=8;',
      );
      context.config.script!.commands.watch = `node ${JSON.stringify(watchScript)}`;

      let watchError: unknown;
      try {
        await provider.watch(context).next();
      } catch (error) {
        watchError = error;
      }

      expect(ensureErrorMessage(watchError)).toContain(
        "watch: [redacted environment value] [redacted environment value] [redacted environment value] [redacted environment value]",
      );
      expect(ensureErrorMessage(watchError)).not.toContain("fixture-redaction-value");
      expect(ensureErrorMessage(watchError)).not.toContain("second-line");
      expect(ensureErrorMessage(watchError)).not.toContain(keySentinel);
      expect(ensureErrorMessage(watchError)).not.toContain(compoundSentinel);
      expect(ensureErrorMessage(watchError)).not.toContain(shortSentinel);
    } finally {
      for (const [name, originalValue] of originalValues) {
        if (originalValue === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = originalValue;
        }
      }
    }
  });

  it("redacts inherited JWT environment values from script diagnostics", async () => {
    const context = await createContext();
    const envName = ["CI", "JOB", "JWT"].join("_");
    const sentinel = "header.payload.signature";
    const originalValue = process.env[envName];
    process.env[envName] = sentinel;

    try {
      const failingScript = path.join(path.dirname(context.manifestPath), "send-jwt-secret.mjs");
      await writeText(
        failingScript,
        `process.stderr.write(process.env[${JSON.stringify(envName)}]);process.exitCode=7;`,
      );
      context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
      const provider = new ScriptProviderAdapter(context);

      const failure = await provider
        .send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        })
        .catch((error: unknown) => error);

      expect(ensureErrorMessage(failure)).toContain("[redacted environment value]");
      expect(inspect(failure, { depth: null })).not.toContain(sentinel);
    } finally {
      if (originalValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalValue;
      }
    }
  });

  it("redacts URL userinfo and Authorization credential forms", async () => {
    const context = await createContext();
    const urlEnvName = "CRABLINE_DATABASE_URL";
    const headerEnvName = "CRABLINE_HTTP_HEADER";
    const originalValues = new Map([
      [urlEnvName, process.env[urlEnvName]],
      [headerEnvName, process.env[headerEnvName]],
    ]);
    process.env[urlEnvName] = "https://sample:test-token-placeholder@service.test/database";
    process.env[headerEnvName] = "Authorization: Bearer placeholder";

    try {
      const failingScript = path.join(path.dirname(context.manifestPath), "send-auth-forms.mjs");
      await writeText(
        failingScript,
        `process.stderr.write([
          process.env.${urlEnvName},
          process.env.${headerEnvName},
          "Authorization=Basic sample",
          "API_TOKEN=dummy",
          "API_TOKEN=Bearer secret-token",
          "--client-secret fake"
        ].join("\\n"));process.exitCode=7;`,
      );
      context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
      const provider = new ScriptProviderAdapter(context);
      const failure = await provider
        .send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        })
        .catch((error: unknown) => error);
      const message = ensureErrorMessage(failure);

      expect(message).toContain("https://[redacted credentials]@service.test/database");
      expect(message).toContain("Authorization: Bearer [redacted credential]");
      expect(message).toContain("Authorization=Basic [redacted credential]");
      expect(message).toContain("API_TOKEN=[redacted credential]");
      expect(message).toContain("--client-secret [redacted credential]");
      for (const secret of [
        "sample",
        "test-token-placeholder",
        "placeholder",
        "dummy",
        "secret-token",
        "fake",
      ]) {
        expect(message).not.toContain(secret);
      }
    } finally {
      for (const [name, originalValue] of originalValues) {
        if (originalValue === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = originalValue;
        }
      }
    }
  });

  it("redacts environment secrets before configured command substrings", async () => {
    const context = await createContext();
    const envName = ["SCRIPT", "TOKEN"].join("_");
    const marker = "overlap-prefix-configured-fragment-overlap-suffix";
    const originalValue = process.env[envName];
    process.env[envName] = marker;

    try {
      const failingScript = path.join(path.dirname(context.manifestPath), "send-overlap.mjs");
      await writeText(
        failingScript,
        `process.stderr.write(process.env[${JSON.stringify(envName)}]);process.exitCode=7;`,
      );
      context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
      context.config.script!.commands.watch = "configured-fragment";
      const provider = new ScriptProviderAdapter(context);

      const failure = await provider
        .send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        })
        .catch((error: unknown) => error);
      const message = ensureErrorMessage(failure);

      expect(message).toContain("[redacted environment value]");
      expect(message).not.toContain("overlap-prefix");
      expect(message).not.toContain("overlap-suffix");
    } finally {
      if (originalValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalValue;
      }
    }
  });

  it("uses stdout diagnostics when stderr is only whitespace", async () => {
    const context = await createContext();
    const failingScript = path.join(path.dirname(context.manifestPath), "send-stdout-error.mjs");
    await writeText(
      failingScript,
      'process.stderr.write("\\n");process.stdout.write("useful failure");process.exitCode=7;',
    );
    context.config.script!.commands.send = `node ${JSON.stringify(failingScript)}`;
    const provider = new ScriptProviderAdapter(context);

    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      }),
    ).rejects.toThrow(/useful failure/u);
  });

  it("preserves inherited path values in script diagnostics", async () => {
    const context = await createContext();
    const envName = ["GO", "PATH"].join("");
    const pathValue = "/tmp/crabline-go-path";
    const extensionEnvName = ["PATH", "EXT"].join("");
    const extensionValue = ".COM;.EXE";
    const previousDirectoryEnvName = ["OLD", "PWD"].join("");
    const originalValues = new Map([
      [envName, process.env[envName]],
      [extensionEnvName, process.env[extensionEnvName]],
    ]);
    process.env[envName] = pathValue;
    process.env[extensionEnvName] = extensionValue;

    try {
      const failingScript = path.join(path.dirname(context.manifestPath), "send-path-error.mjs");
      await writeText(
        failingScript,
        'process.stderr.write(`path: ${process.env[["GO","PATH"].join("")]} ${process.env[["PATH","EXT"].join("")]}`);process.exitCode=7;',
      );
      context.config.script!.commands.send =
        `${previousDirectoryEnvName}=/tmp/previous-directory ` +
        `node ${JSON.stringify(failingScript)} "--path-prefix=/var/lib/crabline-prefix"`;
      const provider = new ScriptProviderAdapter(context);

      await expect(
        provider.send({
          ...context,
          mode: "send",
          nonce: "nonce",
          text: "payload",
        }),
      ).rejects.toThrow(`path: ${pathValue} ${extensionValue}`);
    } finally {
      for (const [name, originalValue] of originalValues) {
        if (originalValue === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = originalValue;
        }
      }
    }
  });

  it("fails when required commands are missing", async () => {
    const context = await createContext();
    const provider = new ScriptProviderAdapter({
      ...context,
      config: {
        ...context.config,
        script: { commands: {} },
      },
    });

    await expect(
      provider.send({
        ...context,
        mode: "send",
        nonce: "nonce",
        text: "payload",
      }),
    ).rejects.toThrow(/missing send command/);
    await expect(provider.watch?.({ ...context })?.next()).rejects.toThrow(/missing watch command/);
  });
});
