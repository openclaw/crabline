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
