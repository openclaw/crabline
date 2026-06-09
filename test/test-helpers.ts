import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
