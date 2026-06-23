import { spawn } from "node:child_process";
import path from "node:path";
import { CrablineError, ensureErrorMessage } from "../../core/errors.js";
import type {
  ProviderAdapter,
  ProviderContext,
  SendContext,
  WaitContext,
  WatchContext,
} from "../types.js";

type ScriptPayload = {
  fixture: ProviderContext["fixture"];
  provider: {
    config: ProviderContext["config"];
    id: string;
    manifestPath: string;
  };
};

type ScriptProbeResult = {
  details?: string[];
  healthy: boolean;
};

type ScriptSendResult = {
  accepted: boolean;
  messageId: string;
  threadId: string;
};

type ScriptInboundResult = {
  message?: {
    author: "assistant" | "system" | "user";
    id: string;
    raw?: unknown;
    sentAt: string;
    text: string;
    threadId: string;
  };
  timeout?: boolean;
};

function runScript<T>(command: string, payload: unknown, cwd?: string, shell?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      env: process.env,
      shell: shell ?? true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new CrablineError(
            `Script command failed: ${command}\n${stderr.trim() || stdout.trim()}`,
            {
              kind: "connectivity",
            },
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(
          new CrablineError(
            `Script command did not return valid JSON: ${command}\n${ensureErrorMessage(error)}`,
            { kind: "config" },
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export class ScriptProviderAdapter implements ProviderAdapter {
  readonly id;
  readonly platform;
  readonly status = "bridge" as const;
  readonly supports;
  readonly #config;

  constructor(context: ProviderContext) {
    if (!context.config.script) {
      throw new CrablineError(`Provider "${context.providerId}" is missing script configuration.`, {
        kind: "config",
      });
    }

    this.id = context.providerId;
    this.platform = context.config.platform;
    this.supports = [...context.config.capabilities];
    this.#config = context.config.script;
  }

  normalizeTarget(target: ProviderContext["fixture"]["target"]) {
    const normalized = {
      id: target.id,
      metadata: target.metadata,
    } as ReturnType<ProviderAdapter["normalizeTarget"]>;
    if (target.channelId) {
      normalized.channelId = target.channelId;
    }
    if (target.threadId) {
      normalized.threadId = target.threadId;
    }
    return normalized;
  }

  async probe(context: ProviderContext) {
    const command = this.#config.commands.probe;
    if (!command) {
      return {
        details: ["probe command not configured"],
        healthy: false,
      };
    }

    const result = await runScript<ScriptProbeResult>(
      command,
      createPayload(context),
      this.#config.cwd,
      this.#config.shell,
    );
    return {
      details: result.details ?? [],
      healthy: result.healthy,
    };
  }

  async send(context: SendContext) {
    const command = this.#config.commands.send;
    if (!command) {
      throw new CrablineError(`Provider "${this.id}" is missing send command.`, {
        kind: "config",
      });
    }

    return runScript<ScriptSendResult>(
      command,
      {
        ...createPayload(context),
        outbound: {
          mode: context.mode,
          nonce: context.nonce,
          target: this.normalizeTarget(context.fixture.target),
          text: context.text,
        },
      },
      this.#config.cwd,
      this.#config.shell,
    );
  }

  async waitForInbound(context: WaitContext) {
    const command = this.#config.commands.waitForInbound;
    if (!command) {
      return null;
    }

    const result = await runScript<ScriptInboundResult>(
      command,
      {
        ...createPayload(context),
        wait: {
          nonce: context.nonce,
          since: context.since,
          target: this.normalizeTarget(context.fixture.target),
          timeoutMs: context.timeoutMs,
        },
      },
      this.#config.cwd,
      this.#config.shell,
    );

    if (result.timeout || !result.message) {
      return null;
    }

    return {
      ...result.message,
      provider: this.id,
    };
  }

  async *watch(context: WatchContext) {
    const command = this.#config.commands.watch;
    if (!command) {
      throw new CrablineError(`Provider "${this.id}" is missing watch command.`, {
        kind: "config",
      });
    }

    const child = spawn(command, {
      cwd: this.#config.cwd ? path.resolve(this.#config.cwd) : process.cwd(),
      env: process.env,
      shell: this.#config.shell ?? true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.stdin.end(
      JSON.stringify({
        ...createPayload(context),
        watch: {
          since: context.since,
          target: this.normalizeTarget(context.fixture.target),
        },
      }),
    );

    let buffer = "";
    const childClosed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    });

    try {
      for await (const chunk of child.stdout) {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const parsed = JSON.parse(line) as ScriptInboundResult["message"];
          if (!parsed) {
            continue;
          }
          yield {
            ...parsed,
            provider: this.id,
          };
        }
      }

      if (buffer.trim()) {
        const parsed = JSON.parse(buffer) as ScriptInboundResult["message"];
        if (parsed) {
          yield {
            ...parsed,
            provider: this.id,
          };
        }
      }
    } finally {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // The process group may have already exited with the shell.
          }
        }
      }
      await childClosed;
    }
  }
}

function createPayload(context: ProviderContext): ScriptPayload {
  return {
    fixture: context.fixture,
    provider: {
      config: context.config,
      id: context.providerId,
      manifestPath: context.manifestPath,
    },
  };
}
