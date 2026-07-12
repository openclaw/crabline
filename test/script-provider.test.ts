import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptProviderAdapter } from "../src/providers/builtin/script.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir, writeText } from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

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
    context.config.script!.shell = path.join(
      path.dirname(context.manifestPath),
      "missing-shell",
    );
    const provider = new ScriptProviderAdapter(context);

    await expect(provider.watch(context).next()).rejects.toThrow(/failed to start/u);
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
