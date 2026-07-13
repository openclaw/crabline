import { EXIT_CODES, type ExitCode } from "./exit-codes.js";

export type FailureKind =
  | "config"
  | "auth"
  | "connectivity"
  | "outbound"
  | "inbound"
  | "timeout"
  | "assertion";

const KIND_TO_EXIT: Record<FailureKind, ExitCode> = {
  config: EXIT_CODES.CONFIG,
  auth: EXIT_CODES.AUTH,
  connectivity: EXIT_CODES.CONNECTIVITY,
  outbound: EXIT_CODES.OUTBOUND,
  inbound: EXIT_CODES.INBOUND,
  timeout: EXIT_CODES.TIMEOUT,
  assertion: EXIT_CODES.ASSERTION,
};

export class CrablineError extends Error {
  readonly exitCode: ExitCode;
  readonly hasExplicitExitCode: boolean;
  readonly kind: FailureKind | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; exitCode?: ExitCode; kind?: FailureKind },
  ) {
    super(message, options);
    this.name = "CrablineError";
    this.hasExplicitExitCode = options?.exitCode !== undefined;
    this.kind = options?.kind;
    this.exitCode =
      options?.exitCode === EXIT_CODES.SUCCESS
        ? EXIT_CODES.FAILURE
        : (options?.exitCode ?? (options?.kind ? KIND_TO_EXIT[options.kind] : EXIT_CODES.FAILURE));
  }
}

export function ensureErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      return typeof message === "string" ? message : String(message);
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}
