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
  timeoutMs?: number;
  url: string;
}): Promise<{ body: string; headers: import("node:http").IncomingHttpHeaders; status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      params.url,
      {
        agent: params.agent,
        headers: params.headers,
        method: params.method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once("error", reject);
    request.setTimeout(params.timeoutMs ?? 2_000, () => {
      request.destroy(new Error(`HTTP request timed out after ${params.timeoutMs ?? 2_000} ms.`));
    });
    if (params.body !== undefined) {
      request.write(params.body);
    }
    request.end();
  });
}

export const captureWrites = (): {
  restore: () => void;
  stderr: string[];
  stdout: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  return {
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
    stderr,
    stdout,
  };
};
