import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

export const createTempDir = async (): Promise<string> => mkdtemp(path.join(tmpdir(), "crabline-"));

export const disposeTempDir = async (directory: string): Promise<void> => {
  await rm(directory, { force: true, recursive: true });
};

export const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

export const writeText = async (filePath: string, value: string): Promise<void> => {
  await writeFile(filePath, value, "utf8");
};

export async function requestHttp(params: {
  agent?: import("node:http").Agent;
  body?: Buffer | string;
  headers?: Record<string, string>;
  method: string;
  requestImpl?: typeof httpRequest;
  timeoutMs?: number;
  url: string;
}): Promise<{ body: string; headers: import("node:http").IncomingHttpHeaders; status: number }> {
  return await new Promise((resolve, reject) => {
    const timeoutMs = params.timeoutMs ?? 2_000;
    let settled = false;
    let request: import("node:http").ClientRequest | undefined;
    const timeout = setTimeout(() => {
      const error = new Error(`HTTP request timed out after ${timeoutMs} ms.`);
      request?.destroy(error);
      fail(error);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timeout);
      settled = true;
    };
    const fail = (error: Error) => {
      if (!settled) {
        finish();
        reject(error);
      }
    };
    try {
      request = (params.requestImpl ?? httpRequest)(
        params.url,
        {
          agent: params.agent,
          headers: params.headers,
          method: params.method,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("aborted", () => {
            fail(new Error("HTTP response was aborted before completion."));
          });
          response.once("error", fail);
          response.once("end", () => {
            if (settled) {
              return;
            }
            finish();
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
              status: response.statusCode ?? 0,
            });
          });
          response.once("close", () => {
            if (!response.complete) {
              fail(new Error("HTTP response closed before completion."));
            }
          });
        },
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.once("error", fail);
    if (params.body !== undefined) {
      request.write(params.body);
    }
    request.end();
  });
}

export async function settleCleanup(operations: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple test cleanup operations failed.");
  }
}

type WriteCapture = {
  active: boolean;
  stderr: string[];
  stdout: string[];
};

const writeCaptures: WriteCapture[] = [];
let originalStdoutWrite: typeof process.stdout.write | undefined;
let originalStderrWrite: typeof process.stderr.write | undefined;

const createCaptureWriter =
  (stream: "stderr" | "stdout") =>
  (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const capture = writeCaptures.findLast((entry) => entry.active);
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    capture?.[stream].push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8"),
    );
    const completion = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (completion) {
      queueMicrotask(() => completion(null));
    }
    return true;
  };

export const captureWrites = (): {
  restore: () => void;
  stderr: string[];
  stdout: string[];
} => {
  const capture: WriteCapture = { active: true, stderr: [], stdout: [] };
  if (writeCaptures.length === 0) {
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = createCaptureWriter("stdout") as typeof process.stdout.write;
    process.stderr.write = createCaptureWriter("stderr") as typeof process.stderr.write;
  }
  writeCaptures.push(capture);

  return {
    restore() {
      if (!capture.active) {
        return;
      }
      capture.active = false;
      while (writeCaptures.at(-1)?.active === false) {
        writeCaptures.pop();
      }
      if (writeCaptures.length === 0) {
        process.stdout.write = originalStdoutWrite!;
        process.stderr.write = originalStderrWrite!;
        originalStdoutWrite = undefined;
        originalStderrWrite = undefined;
      }
    },
    stderr: capture.stderr,
    stdout: capture.stdout,
  };
};
