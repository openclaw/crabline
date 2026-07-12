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
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const request = (params.requestImpl ?? httpRequest)(
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
          settled = true;
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
    request.setTimeout(params.timeoutMs ?? 2_000, () => {
      request.destroy(new Error(`HTTP request timed out after ${params.timeoutMs ?? 2_000} ms.`));
    });
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

export const captureWrites = (): {
  restore: () => void;
  stderr: string[];
  stdout: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  const capture =
    (target: string[]) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      target.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8"),
      );
      const completion = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (completion) {
        queueMicrotask(() => completion(null));
      }
      return true;
    };

  process.stdout.write = capture(stdout) as typeof process.stdout.write;
  process.stderr.write = capture(stderr) as typeof process.stderr.write;

  return {
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
    stderr,
    stdout,
  };
};
