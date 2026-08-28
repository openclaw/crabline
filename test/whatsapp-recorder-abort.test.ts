import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it("observes recorder rejection when shutdown aborts during native Baileys inflation", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `console.log("child-started", process.execPath, process.version); await import(${JSON.stringify(new URL("./fixtures/whatsapp-recorder-abort.ts", import.meta.url).href)});`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, "close");
  let timer: NodeJS.Timeout | undefined;
  try {
    const [code, signal] = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Child did not exit; stdout: ${stdout}\nstderr: ${stderr}`)),
          // Use the recorder subprocess bound, reserving one second for forced teardown.
          30_000 - 1_000,
        );
      }),
    ]);
    process.stdout.write(stdout);
    expect({ code, signal }, `stdout: ${stdout}\nstderr: ${stderr}`).toEqual({
      code: 0,
      signal: null,
    });
    const line = stdout.split("\n").find((value) => value.startsWith("proof: "));
    expect(line).toBeDefined();
    const proof = JSON.parse(line!.slice("proof: ".length));
    expect(proof).toMatchObject({
      node: process.version,
      execPath: process.execPath,
      durableRecords: 1,
      native: { captures: 1, callbacks: 1, invocations: 1 },
      unhandledRejections: 0,
      milestones: [
        "client-ready",
        "iq-barrier",
        "native-inflate-held",
        "close-started-before-decode-release",
        "native-decode-released",
        "closed-with-observer-held",
        "repeated-close",
        "one-durable-marker",
        "observer-rejected-and-settled",
        "owned-work-settled",
        "event-loop-checkpoint",
        "temporary-directory-removed",
      ],
    });
    expect(proof.native.inputBytes).toBeGreaterThan(0);
    expect(proof.native.bytesWritten).toBe(proof.native.inputBytes);
    expect(proof.closeMs).toBeLessThan(1_000);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}, 30_000);
