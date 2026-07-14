import { AsyncLocalStorage } from "node:async_hooks";
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
      request.once("error", fail);
      if (params.body !== undefined) {
        request.write(params.body);
      }
      request.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
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

type CaptureWrite = (
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
) => boolean;

const writeCaptureStorage = new AsyncLocalStorage<WriteCapture>();
let activeWriteCaptureCount = 0;
let originalStdoutWrite: typeof process.stdout.write | undefined;
let originalStderrWrite: typeof process.stderr.write | undefined;

const createCaptureWriter =
  (stream: "stderr" | "stdout") =>
  (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const capture = writeCaptureStorage.getStore();
    if (!capture?.active) {
      const target = stream === "stdout" ? process.stdout : process.stderr;
      const originalWrite = (
        stream === "stdout" ? originalStdoutWrite : originalStderrWrite
      ) as CaptureWrite;
      return originalWrite.call(target, chunk, encodingOrCallback, callback);
    }
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk, encoding ?? "utf8") : Buffer.from(chunk);
    capture[stream].push(bytes.toString("utf8"));
    const completion = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (completion) {
      queueMicrotask(() => completion(null));
    }
    return true;
  };

export const createWriteCapture = (): {
  restore: () => void;
  run: <T>(operation: () => Promise<T> | T) => Promise<T>;
  stderr: string[];
  stdout: string[];
} => {
  const capture: WriteCapture = { active: true, stderr: [], stdout: [] };
  if (activeWriteCaptureCount === 0) {
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = createCaptureWriter("stdout") as typeof process.stdout.write;
    process.stderr.write = createCaptureWriter("stderr") as typeof process.stderr.write;
  }
  activeWriteCaptureCount += 1;

  return {
    restore() {
      if (!capture.active) {
        return;
      }
      capture.active = false;
      activeWriteCaptureCount -= 1;
      if (activeWriteCaptureCount === 0) {
        process.stdout.write = originalStdoutWrite!;
        process.stderr.write = originalStderrWrite!;
        originalStdoutWrite = undefined;
        originalStderrWrite = undefined;
      }
    },
    async run<T>(operation: () => Promise<T> | T): Promise<T> {
      if (!capture.active) {
        throw new Error("Cannot run a restored output capture.");
      }
      return await writeCaptureStorage.run(capture, operation);
    },
    stderr: capture.stderr,
    stdout: capture.stdout,
  };
};

export const captureWrites = async <T>(
  operation: () => Promise<T> | T,
): Promise<{
  result: T;
  stderr: string[];
  stdout: string[];
}> => {
  const capture = createWriteCapture();

  try {
    const result = await capture.run(operation);
    return { result, stderr: capture.stderr, stdout: capture.stdout };
  } finally {
    capture.restore();
  }
};
