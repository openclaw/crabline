import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CRABLINE_FAKE_PROVIDER_CHANNELS,
  CRABLINE_SERVER_CHANNELS,
  createOpenClawCrablineAgentDelivery,
  createOpenClawCrablineChannelReportNotes,
  createOpenClawCrablineFakeProviderBinding,
  createOpenClawCrablineProviderBinding,
  createOpenClawCrablineInbound,
  createOpenClawCrablineOutboundFromRecorderEvent as translateOpenClawCrablineOutbound,
  isCrablineFakeProviderChannel,
  isCrablineServerChannel,
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  probeOpenClawCrablineFakeProvider,
  probeOpenClawCrablineProvider,
  resolveOpenClawCrablineChannelDriverSelection,
  runOpenClawCrablineChannelDriverSmoke,
  runOpenClawCrablineProviderReadiness,
  startCrablineFakeProviderServer,
  startCrablineServer,
  startOpenClawCrablineAdapter,
  type CrablineFakeProviderManifest,
  type CrablineServerManifest,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineConversation,
} from "../src/index.js";
import {
  publishOpenClawCrablineArtifactGeneration,
  readOpenClawCrablineArtifactPointer,
} from "../src/openclaw/artifact-generation.js";
import { MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "../src/openclaw/bridges/matrix.js";
import { SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE } from "../src/openclaw/bridges/signal.js";
import {
  createOpenClawCrablineProviderBridge,
  isRecord,
  parseQaTarget,
  runOpenClawCrablineProviderProbe,
  type OpenClawCrablineProviderAdapter,
} from "../src/openclaw/shared.js";

type ProviderReadinessTestDependencies = {
  acquireLock?: () => Promise<{
    assertOwned(): Promise<void>;
    commitFileAtomically(params: {
      contents: string;
      destinationPath: string;
      stageFile(filePath: string, contents: string): Promise<void>;
    }): Promise<void>;
    release(): Promise<void>;
  }>;
  publishGeneration?: typeof publishOpenClawCrablineArtifactGeneration;
  releaseLock?: (lock: { release(): Promise<void> }) => Promise<void>;
  startAdapter?: typeof startOpenClawCrablineAdapter;
  syncParent?: (filePath: string) => Promise<void>;
};

const runProviderReadinessWithDependencies = runOpenClawCrablineProviderReadiness as unknown as (
  params: Parameters<typeof runOpenClawCrablineProviderReadiness>[0],
  dependencies: ProviderReadinessTestDependencies,
) => ReturnType<typeof runOpenClawCrablineProviderReadiness>;

function createOpenClawCrablineOutboundFromRecorderEvent(
  params: Parameters<typeof translateOpenClawCrablineOutbound>[0],
) {
  return translateOpenClawCrablineOutbound({
    ...params,
    event: isRecord(params.event) ? { ...params.event, accepted: true } : params.event,
  });
}

function startSmokeLockHolder(outputDir: string, channel: string): ChildProcessWithoutNullStreams {
  const lockModuleUrl = new URL("../src/openclaw/smoke-lock.ts", import.meta.url).href;
  const script = `
    import { acquireOpenClawCrablineSmokeRunLock } from ${JSON.stringify(lockModuleUrl)};
    const lock = await acquireOpenClawCrablineSmokeRunLock({
      channel: process.argv[2],
      outputDir: process.argv[1],
    });
    process.stdout.write("locked\\n");
    process.stdin.once("data", async () => {
      await lock.release();
    });
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, outputDir, channel],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

async function waitForSmokeLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for smoke lock holder. stderr: ${stderr}`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("locked\n")) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Smoke lock holder exited before acquiring the lock (code=${code}, signal=${signal}). stderr: ${stderr}`,
        ),
      );
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function readPublishedArtifactGeneration(
  outputDir: string,
  paths: {
    capabilityMatrixPath: string;
    manifestPath: string;
    providerReadinessArtifactPath: string;
  },
): Promise<string[]> {
  return await Promise.all(
    [paths.manifestPath, paths.capabilityMatrixPath, paths.providerReadinessArtifactPath].map(
      (filePath) => fs.readFile(path.join(outputDir, filePath), "utf8"),
    ),
  );
}

function recorderProbeLine(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    accepted: true,
    at: "2026-07-13T00:00:00.000Z",
    method: "GET",
    path: "/bot<redacted>/getMe",
    query: {},
    type: "api",
    ...extra,
  })}\n`;
}

function telegramProbeResult(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      first_name: "Crabline",
      id: 424_242,
      is_bot: true,
    },
    ...extra,
  };
}

const manifest: CrablineServerManifest = {
  adminToken: "crabline-admin-token",
  baseUrl: "http://127.0.0.1:1234",
  botToken: "424242:crabline-telegram-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:1234/crabline/telegram/inbound",
    apiRoot: "http://127.0.0.1:1234",
  },
  env: {
    TELEGRAM_BOT_TOKEN: "424242:crabline-telegram-token",
  },
  provider: "telegram",
  recorderPath: "/tmp/crabline/telegram.jsonl",
  version: 1,
};

const signalManifest: CrablineServerManifest = {
  account: "+15550000000",
  adminToken: "crabline-signal-admin-token",
  baseUrl: "http://127.0.0.1:1357",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:1357/crabline/signal/inbound",
    apiRoot: "http://127.0.0.1:1357",
    eventsUrl: "http://127.0.0.1:1357/api/v1/events",
    rpcUrl: "http://127.0.0.1:1357/api/v1/rpc",
  },
  env: {},
  provider: "signal",
  recorderPath: "/tmp/crabline/signal.jsonl",
  version: 1,
};

const mattermostManifest: CrablineServerManifest = {
  adminToken: "crabline-mattermost-admin-token",
  baseUrl: "http://127.0.0.1:9753",
  botToken: "crabline-mattermost-token",
  botUserId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:9753/crabline/mattermost/inbound",
    apiRoot: "http://127.0.0.1:9753/api/v4",
    websocketUrl: "ws://127.0.0.1:9753/api/v4/websocket",
  },
  env: {
    MATTERMOST_BOT_TOKEN: "crabline-mattermost-token",
    MATTERMOST_URL: "http://127.0.0.1:9753",
  },
  provider: "mattermost",
  recorderPath: "/tmp/crabline/mattermost.jsonl",
  version: 1,
};

const matrixManifest: CrablineServerManifest = {
  accessToken: "syt_crabline_matrix_token",
  adminToken: "crabline-matrix-admin-token",
  baseUrl: "http://127.0.0.1:8642",
  botUserId: "@openclaw:matrix.test",
  deviceId: "CRABLINE",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:8642/crabline/matrix/inbound",
    clientApiRoot: "http://127.0.0.1:8642/_matrix/client/v3",
    syncUrl: "http://127.0.0.1:8642/_matrix/client/v3/sync",
  },
  env: {
    MATRIX_ACCESS_TOKEN: "syt_crabline_matrix_token",
    MATRIX_BASE_URL: "http://127.0.0.1:8642",
    MATRIX_USER_ID: "@openclaw:matrix.test",
  },
  provider: "matrix",
  recorderPath: "/tmp/crabline/matrix.jsonl",
  version: 1,
};

const whatsappManifest: CrablineServerManifest = {
  accessToken: "crabline-whatsapp-access-token",
  adminToken: "crabline-whatsapp-admin-token",
  baseUrl: "http://127.0.0.1:5678",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:5678/_crabline/admin/whatsapp/inbound",
    apiRoot: "http://127.0.0.1:5678/v25.0",
    baileysWebSocketUrl: "ws://127.0.0.1:5678/ws/chat?access_token=crabline-whatsapp-access-token",
    messagesUrl: "http://127.0.0.1:5678/v25.0/100000000000000/messages",
    phoneNumberUrl: "http://127.0.0.1:5678/v25.0/100000000000000",
    statusUrl: "http://127.0.0.1:5678/v25.0/100000000000000/messages",
  },
  env: {
    CLOUD_API_ACCESS_TOKEN: "crabline-whatsapp-access-token",
    CLOUD_API_VERSION: "v25.0",
    WA_BASE_URL: "http://127.0.0.1:5678",
    WA_PHONE_NUMBER_ID: "100000000000000",
  },
  graphVersion: "v25.0",
  phoneNumberId: "100000000000000",
  provider: "whatsapp",
  recorderPath: "/tmp/crabline/whatsapp.jsonl",
  selfJid: "15550000000@s.whatsapp.net",
  version: 1,
};

const slackManifest: CrablineServerManifest = {
  adminToken: "crabline-slack-admin-token",
  baseUrl: "http://127.0.0.1:2468",
  botToken: "xoxb-crabline-slack-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:2468/crabline/slack/inbound",
    apiRoot: "http://127.0.0.1:2468/api/",
    eventsUrl: "http://127.0.0.1:2468/slack/events",
  },
  env: {
    SLACK_API_URL: "http://127.0.0.1:2468/api/",
    SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
    SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
  },
  provider: "slack",
  recorderPath: "/tmp/crabline/slack.jsonl",
  signingSecret: "crabline-slack-signing-secret",
  version: 1,
};

const zaloManifest: CrablineServerManifest = {
  adminToken: "crabline-zalo-admin-token",
  baseUrl: "http://127.0.0.1:7531",
  botId: "1459232241454765289",
  botToken: "crabline-zalo-bot-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:7531/crabline/zalo/inbound",
    apiRoot: "http://127.0.0.1:7531",
  },
  env: {
    ZALO_API_URL: "http://127.0.0.1:7531",
    ZALO_BOT_TOKEN: "crabline-zalo-bot-token",
  },
  provider: "zalo",
  recorderPath: "/tmp/crabline/zalo.jsonl",
  version: 1,
};

describe("OpenClaw local provider bridge", () => {
  it("preserves prototype methods and receivers on class-based adapters", async () => {
    class ClassAdapter implements OpenClawCrablineProviderAdapter {
      readonly label = "class-adapter";

      createAgentDelivery() {
        return {
          channel: this.label,
          replyChannel: this.label,
          replyTo: this.label,
          to: this.label,
        };
      }

      createBinding() {
        return {
          accountId: this.label,
          channel: this.label,
          createChannelDriverSmokeEnv: (env: NodeJS.ProcessEnv) => env,
          createGatewayConfig: () => ({}),
          requiredPluginIds: [],
        };
      }

      createInbound(input: Parameters<OpenClawCrablineProviderAdapter["createInbound"]>[0]) {
        return {
          providerBody: {},
          providerHeaders: {},
          providerTargetKey: this.label,
          providerUrl: `https://${this.label}.test`,
          qaTarget: `dm:${input.conversation.id}`,
          stateConversation: input.conversation,
        };
      }

      createOutboundFromRecorderEvent() {
        return null;
      }

      async probe() {
        return this.label;
      }
    }

    const bridge = createOpenClawCrablineProviderBridge({
      provider: "mattermost",
      createAdapter: () => new ClassAdapter(),
    });
    const adapter = bridge.createAdapter(mattermostManifest);

    await expect(adapter.probe()).resolves.toBe("class-adapter");
    expect(adapter.createAgentDelivery({ id: "target", kind: "direct", native: true }).to).toBe(
      "class-adapter",
    );
    expect(adapter.createBinding().channel).toBe("class-adapter");
    expect(
      adapter.createInbound({
        conversation: { id: "target", kind: "direct" },
        senderId: "sender",
        text: "hello",
      }).providerTargetKey,
    ).toBe("class-adapter");
  });

  it.each([
    ["mattermost", mattermostManifest],
    ["matrix", matrixManifest],
    ["signal", signalManifest],
    ["slack", slackManifest],
    ["telegram", manifest],
    ["whatsapp", whatsappManifest],
    ["zalo", zaloManifest],
  ] as const)("emits canonical streaming config for the %s bridge", (channel, providerManifest) => {
    const config = createOpenClawCrablineProviderBinding(providerManifest).createGatewayConfig();
    const channels = isRecord(config.channels) ? config.channels : {};
    const channelConfig = isRecord(channels[channel]) ? channels[channel] : {};

    expect(channelConfig).not.toHaveProperty("blockStreaming");
    expect(channelConfig).not.toHaveProperty("blockStreamingCoalesce");
    expect(channelConfig).not.toHaveProperty("chunkMode");
    expect(channelConfig).not.toHaveProperty("draftChunk");
    expect(channelConfig.streaming === undefined || isRecord(channelConfig.streaming)).toBe(true);
  });

  it("keeps legacy fake-provider root aliases", () => {
    const legacyManifest: CrablineFakeProviderManifest = manifest;
    const conversation: OpenClawCrablineConversation = {
      id: "alice",
      kind: "direct",
    };

    expect(CRABLINE_FAKE_PROVIDER_CHANNELS).toBe(CRABLINE_SERVER_CHANNELS);
    expect(isCrablineFakeProviderChannel).toBe(isCrablineServerChannel);
    expect(startCrablineFakeProviderServer).toBe(startCrablineServer);
    expect(createOpenClawCrablineFakeProviderBinding).toBe(createOpenClawCrablineProviderBinding);
    expect(probeOpenClawCrablineFakeProvider).toBe(probeOpenClawCrablineProvider);
    expect(legacyManifest.provider).toBe("telegram");
    expect(conversation).toEqual({ id: "alice", kind: "direct" });
  });

  it("rejects Slack application errors returned with HTTP 200", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_auth", ok: false }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(slackManifest)).rejects.toThrow(
        "Crabline Slack auth.test probe failed: invalid_auth.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects Telegram application errors returned with HTTP 200", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ description: "Unauthorized", error_code: 401, ok: false }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(manifest)).rejects.toThrow(
        "Crabline Telegram getMe probe failed: Unauthorized.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    { ok: true },
    { ok: true, result: null },
    { ok: true, result: { first_name: "Crabline", id: 424_242, is_bot: false } },
    {
      ok: true,
      result: { first_name: "Crabline", id: 424_242, is_bot: true, username: "abc" },
    },
  ])("rejects malformed Telegram getMe success payloads: %j", async (payload) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(manifest)).rejects.toThrow(
        "Crabline Telegram getMe probe failed: invalid response.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("requires Matrix whoami to identify the configured bot user", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user_id: "@other:matrix.test" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(matrixManifest)).rejects.toThrow(
        "Crabline Matrix whoami probe returned an unexpected user.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("cancels successful Signal probe response bodies", async () => {
    const cancel = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 200 }));
    try {
      await expect(probeOpenClawCrablineProvider(signalManifest)).resolves.toEqual({
        ok: true,
        status: 200,
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([null, {}, { id: "999999999999999" }])(
    "requires WhatsApp to return the configured phone resource: %j",
    async (payload) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
      try {
        await expect(probeOpenClawCrablineProvider(whatsappManifest)).rejects.toThrow(
          "Crabline WhatsApp probe returned an unexpected phone number.",
        );
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it.each([
    null,
    {},
    { id: "bbbbbbbbbbbbbbbbbbbbbbbbbb", update_at: 0, username: "openclaw" },
    { id: mattermostManifest.botUserId, update_at: 0, username: " \n\t" },
    { id: mattermostManifest.botUserId, update_at: -1, username: "openclaw" },
  ])("requires Mattermost users/me to identify the configured bot: %j", async (payload) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(mattermostManifest)).rejects.toThrow(
        "Crabline Mattermost users/me probe returned an unexpected user.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects Zalo application errors returned with HTTP 200", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ description: "Unauthorized", error_code: 401, ok: false }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(zaloManifest)).rejects.toThrow(
        "Crabline Zalo getMe probe failed: Unauthorized.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    ["Mattermost", mattermostManifest],
    ["Matrix", matrixManifest],
    ["Signal", signalManifest],
    ["Slack", slackManifest],
    ["Telegram", manifest],
    ["WhatsApp", whatsappManifest],
    ["Zalo", zaloManifest],
  ] as const)("cancels failed %s probe response bodies", async (_label, probeManifest) => {
    const cancel = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 }));
    try {
      await expect(probeOpenClawCrablineProvider(probeManifest)).rejects.toThrow(/HTTP 503/u);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    { ok: true },
    { ok: true, result: null },
    { ok: true, result: {} },
    { ok: true, result: { id: "different-bot" } },
  ])("rejects malformed Zalo success payloads: %j", async (payload) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    try {
      await expect(probeOpenClawCrablineProvider(zaloManifest)).rejects.toThrow(
        "Crabline Zalo getMe probe failed: invalid response.",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    { label: "Mattermost users.me", manifest: mattermostManifest },
    { label: "Matrix whoami", manifest: matrixManifest },
    { label: "Signal check", manifest: signalManifest },
    { label: "Slack auth.test", manifest: slackManifest },
    { label: "Telegram getMe", manifest },
    { label: "WhatsApp phone number", manifest: whatsappManifest },
    { label: "Zalo getMe", manifest: zaloManifest },
  ])("times out stalled $label probe headers", async ({ label, manifest: probeManifest }) => {
    const controller = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    try {
      const probe = probeOpenClawCrablineProvider(probeManifest);
      expect(timeoutMock).toHaveBeenCalledWith(5_000);
      controller.abort(new DOMException("probe deadline", "TimeoutError"));
      await expect(probe).rejects.toThrow(`Crabline ${label} probe timed out after 5000 ms.`);
    } finally {
      fetchMock.mockRestore();
      timeoutMock.mockRestore();
    }
  });

  it("times out a stalled provider probe response body", async () => {
    const controller = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.resolve({
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
        ok: true,
        status: 200,
      } as Response);
    });
    try {
      const probe = probeOpenClawCrablineProvider(manifest);
      controller.abort(new DOMException("probe deadline", "TimeoutError"));
      await expect(probe).rejects.toThrow("Crabline Telegram getMe probe timed out after 5000 ms.");
    } finally {
      fetchMock.mockRestore();
      timeoutMock.mockRestore();
    }
  });

  it("resolves channel-driver metadata through Crabline", () => {
    expect(OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH).toBe(OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH);
    expect(runOpenClawCrablineChannelDriverSmoke).toBe(runOpenClawCrablineProviderReadiness);
    expect(resolveOpenClawCrablineChannelDriverSelection({})).toEqual({
      capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
      channel: "telegram",
      channelDriver: "crabline",
      providerReadinessArtifactPath: OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
      smokeArtifactPath: OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
    });
    const legacySelection: OpenClawCrablineChannelDriverSelection = {
      capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
    };
    expect(createOpenClawCrablineChannelReportNotes(legacySelection)[3]).toBe(
      "Generation provider-readiness filename: crabline-fake-provider-smoke.json.",
    );
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " TELEGRAM " })).toMatchObject({
      channel: "telegram",
    });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " WHATSAPP " })).toMatchObject({
      channel: "whatsapp",
    });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " SLACK " })).toMatchObject({
      channel: "slack",
    });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " SIGNAL " })).toMatchObject({
      channel: "signal",
    });
    expect(
      resolveOpenClawCrablineChannelDriverSelection({ channel: " MATTERMOST " }),
    ).toMatchObject({ channel: "mattermost" });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " MATRIX " })).toMatchObject({
      channel: "matrix",
    });
    expect(resolveOpenClawCrablineChannelDriverSelection({ channel: " ZALO " })).toMatchObject({
      channel: "zalo",
    });
    expect(() => resolveOpenClawCrablineChannelDriverSelection({ channel: "discord" })).toThrow(
      '--channel must be one of mattermost, matrix, signal, slack, telegram, whatsapp, zalo for --channel-driver crabline, got "discord"',
    );
    for (const channel of ["", "   "]) {
      expect(() => resolveOpenClawCrablineChannelDriverSelection({ channel })).toThrow(
        /--channel must be one of mattermost, matrix, signal, slack, telegram, whatsapp, zalo for --channel-driver crabline/u,
      );
    }
  });

  it("maps a Zalo local provider into OpenClaw config and runtime env", () => {
    const binding = createOpenClawCrablineProviderBinding(zaloManifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "zalo",
      requiredPluginIds: ["zalo"],
    });
    expect(binding.createChannelDriverSmokeEnv({ EXISTING: "value" })).toMatchObject({
      EXISTING: "value",
      ZALO_API_URL: "http://127.0.0.1:7531",
      ZALO_BOT_TOKEN: "crabline-zalo-bot-token",
    });
    expect(binding.createGatewayConfig()).toMatchObject({
      channels: {
        zalo: {
          allowFrom: ["*"],
          botToken: "crabline-zalo-bot-token",
          dmPolicy: "open",
          enabled: true,
          groupAllowFrom: ["*"],
          groupPolicy: "open",
        },
      },
    });

    expect(
      createOpenClawCrablineInbound({
        input: {
          conversation: { id: "group-1", kind: "group" },
          senderId: "user-1",
          senderName: "Alice",
          text: "hello",
        },
        manifest: zaloManifest,
      }),
    ).toMatchObject({
      providerBody: {
        chatId: "group-1",
        chatType: "GROUP",
        senderId: "user-1",
        senderName: "Alice",
        text: "hello",
      },
      providerTargetKey: "group-1",
    });
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: zaloManifest,
        target: "thread:group-1/message-1",
      }),
    ).toThrow("Zalo does not support thread targets.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: zaloManifest,
        target: "group:group 1",
      }),
    ).toThrow(/without whitespace/u);
    expect(() =>
      createOpenClawCrablineInbound({
        input: {
          conversation: { id: "group-1", kind: "group" },
          senderId: "user-1",
          text: "hello",
          threadId: "message-1",
        },
        manifest: zaloManifest,
      }),
    ).toThrow("Zalo does not support thread targets.");
    expect(() =>
      createOpenClawCrablineInbound({
        input: {
          conversation: { id: "group-1", kind: "group" },
          senderId: "user 1",
          text: "hello",
        },
        manifest: zaloManifest,
      }),
    ).toThrow(/without whitespace/u);

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        event: {
          body: { chat_id: "group-1", text: "bot reply" },
          method: "POST",
          path: "/bot<redacted>/sendMessage",
          type: "api",
        },
        manifest: zaloManifest,
        targetByProviderTarget: new Map([["group-1", "group:group-1"]]),
      }),
    ).toMatchObject({ text: "bot reply", to: "group:group-1" });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        event: {
          body: { chat_id: "group-1", text: "GET bot reply" },
          method: "GET",
          path: "/bot<redacted>/sendMessage",
          type: "api",
        },
        manifest: zaloManifest,
        targetByProviderTarget: new Map([["group-1", "group:group-1"]]),
      }),
    ).toMatchObject({ text: "GET bot reply", to: "group:group-1" });
  });

  it("maps a Signal local provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineProviderBinding(signalManifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "signal",
      requiredPluginIds: ["signal"],
    });
    expect(binding.createGatewayConfig()).toMatchObject({
      channels: {
        signal: {
          account: "+15550000000",
          allowFrom: ["*"],
          apiMode: "native",
          autoStart: false,
          dmPolicy: "open",
          enabled: true,
          groupAllowFrom: ["*"],
          groupPolicy: "open",
          httpUrl: "http://127.0.0.1:1357",
        },
      },
    });
  });

  it("maps a Telegram local provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineProviderBinding(manifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "telegram",
      requiredPluginIds: ["telegram"],
    });
    expect(
      binding.createGatewayConfig({
        channels: {
          telegram: {
            enabled: false,
          },
          slack: {
            enabled: true,
            webhookUrl: "https://example.test/slack",
          },
        },
        messages: {
          groupChat: {
            customSetting: "preserved",
          },
          dm: {
            customSetting: "also-preserved",
          },
        },
      }),
    ).toMatchObject({
      channels: {
        telegram: {
          apiRoot: "http://127.0.0.1:1234",
          botToken: "424242:crabline-telegram-token",
          enabled: true,
        },
        slack: {
          enabled: true,
          webhookUrl: "https://example.test/slack",
        },
      },
      messages: {
        groupChat: {
          customSetting: "preserved",
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
        dm: {
          customSetting: "also-preserved",
        },
      },
    });
    expect(binding.createChannelDriverSmokeEnv({})).toMatchObject({
      TELEGRAM_BOT_TOKEN: "424242:crabline-telegram-token",
    });
  });

  it("maps a WhatsApp local provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineProviderBinding(whatsappManifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "whatsapp",
      requiredPluginIds: ["whatsapp"],
    });
    expect(
      binding.createGatewayConfig({
        channels: {
          slack: {
            enabled: true,
            webhookUrl: "https://example.test/slack",
          },
          whatsapp: {
            enabled: false,
          },
        },
      }),
    ).toMatchObject({
      channels: {
        slack: {
          enabled: true,
          webhookUrl: "https://example.test/slack",
        },
        whatsapp: {
          enabled: true,
          dmPolicy: "open",
          groupPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["*"],
        },
      },
    });
    expect(binding.createChannelDriverSmokeEnv({})).toMatchObject({
      CRABLINE_WHATSAPP_ADMIN_TOKEN: "crabline-whatsapp-admin-token",
      CRABLINE_WHATSAPP_RECORDER_PATH: "/tmp/crabline/whatsapp.jsonl",
      CRABLINE_WHATSAPP_SELF_JID: "15550000000@s.whatsapp.net",
      OPENCLAW_WHATSAPP_WEB_SOCKET_URL:
        "ws://127.0.0.1:5678/ws/chat?access_token=crabline-whatsapp-access-token",
    });
  });

  it("maps a Slack local provider into OpenClaw channel config", () => {
    const binding = createOpenClawCrablineProviderBinding(slackManifest);

    expect(binding).toMatchObject({
      accountId: "default",
      channel: "slack",
      requiredPluginIds: ["slack"],
    });
    expect(
      binding.createGatewayConfig({
        channels: {
          slack: {
            enabled: false,
          },
          telegram: {
            enabled: true,
          },
        },
      }),
    ).toMatchObject({
      channels: {
        slack: {
          botToken: "xoxb-crabline-slack-token",
          enabled: true,
          mode: "http",
          signingSecret: "crabline-slack-signing-secret",
          webhookPath: "/slack/events",
        },
        telegram: {
          enabled: true,
        },
      },
    });
    expect(binding.createChannelDriverSmokeEnv({})).toMatchObject({
      SLACK_API_URL: "http://127.0.0.1:2468/api/",
      SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
      SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
    });
  });

  it("starts a bound OpenClaw adapter from channel and config", async () => {
    const observedEvents: unknown[] = [];
    const adapter = await startOpenClawCrablineAdapter({
      channel: "telegram",
      onEvent: (event) => {
        observedEvents.push(event);
      },
      openclawConfig: {
        channels: {
          telegram: {
            enabled: false,
          },
        },
      },
    });
    try {
      expect(adapter.channel).toBe("telegram");
      expect(adapter.requiredPluginIds).toEqual(["telegram"]);
      expect(adapter.createGatewayConfig()).toMatchObject({
        channels: {
          telegram: {
            enabled: true,
            apiRoot: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
          },
        },
      });
      expect(adapter.createAgentDelivery({ target: "dm:alice" })).toMatchObject({
        channel: "telegram",
        to: expect.stringMatching(/^\d+$/u),
      });
      if (adapter.manifest.provider !== "telegram") {
        throw new Error("Expected Telegram local provider manifest.");
      }
      await fetch(`${adapter.manifest.baseUrl}/bot${adapter.manifest.botToken}/getMe`);
      expect(observedEvents).toEqual([
        expect.objectContaining({ method: "GET", path: "/bot<redacted>/getMe", type: "api" }),
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("closes a started server when adapter construction fails", async () => {
    const startupError = new Error("adapter construction failed");
    const close = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(
      startOpenClawCrablineAdapter(
        { channel: "telegram" },
        {
          createProviderAdapter() {
            throw startupError;
          },
          startServer: async () => ({ close, manifest }),
        },
      ),
    ).rejects.toBe(startupError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("maps QA targets, inbound messages, and recorder events", () => {
    const symbolicDelivery = createOpenClawCrablineAgentDelivery({
      manifest,
      target: "dm:alice",
    });
    expect(symbolicDelivery).toEqual({
      channel: "telegram",
      to: expect.stringMatching(/^\d+$/u),
      replyChannel: "telegram",
      replyTo: symbolicDelivery.to,
    });
    expect(BigInt(symbolicDelivery.to)).toBeGreaterThanOrEqual(1n << 52n);
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest,
        target: `dm:${1n << 52n}`,
      }),
    ).toThrow("Telegram native numeric targets must fit within 52 significant bits.");
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "dm:alice" }).to).toBe(
      symbolicDelivery.to,
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "dm:bob" }).to).not.toBe(
      symbolicDelivery.to,
    );
    const symbolicGroupDelivery = createOpenClawCrablineAgentDelivery({
      manifest,
      target: "group:alice",
    });
    expect(BigInt(symbolicGroupDelivery.to)).toBeLessThanOrEqual(-(1n << 52n));
    expect(Number.isSafeInteger(Number(symbolicGroupDelivery.to))).toBe(true);
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest,
        target: "thread:alice/42",
      }).to,
    ).toBe(`${symbolicGroupDelivery.to}:topic:42`);
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "dm:42424242" }).to).toBe(
      "42424242",
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "dm:00042424242" }).to).toBe(
      "42424242",
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "group:-100123" }).to).toBe(
      "-100123",
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "group:-000100123" }).to).toBe(
      "-100123",
    );
    expect(
      createOpenClawCrablineAgentDelivery({ manifest, target: "channel:@channelusername" }).to,
    ).toBe("@channelusername");
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "@channelusername" }).to).toBe(
      "@channelusername",
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "-100123" }).to).toBe("-100123");
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "thread:-100123/42" }).to).toBe(
      "-100123:topic:42",
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "channel:@abcd" }).to).toBe(
      "@abcd",
    );
    expect(
      createOpenClawCrablineAgentDelivery({ manifest, target: "channel:@ChannelUserName" }).to,
    ).toBe("@channelusername");
    const maxUsername = `@${"a".repeat(32)}`;
    expect(
      createOpenClawCrablineAgentDelivery({ manifest, target: `channel:${maxUsername}` }).to,
    ).toBe(maxUsername);
    for (const target of ["channel:@abc", `channel:@${"a".repeat(33)}`]) {
      expect(() => createOpenClawCrablineAgentDelivery({ manifest, target })).toThrow(
        /Telegram usernames/u,
      );
    }

    const inbound = createOpenClawCrablineInbound({
      manifest,
      input: {
        conversation: { id: "alice", kind: "direct" },
        nativeCommand: { name: "stop" },
        senderId: "alice",
        senderName: "Alice",
        text: "/stop",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        chatId: symbolicDelivery.to,
        fromId: Number(symbolicDelivery.to),
        fromName: "Alice",
        entities: [{ length: 5, offset: 0, type: "bot_command" }],
        text: "/stop",
      },
      providerHeaders: {
        "content-type": "application/json",
        "x-crabline-admin-token": "crabline-admin-token",
      },
      providerTargetKey: symbolicDelivery.to,
      providerUrl: "http://127.0.0.1:1234/crabline/telegram/inbound",
      qaTarget: "dm:alice",
      stateConversation: {
        id: symbolicDelivery.to,
        kind: "direct",
      },
    });
    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "00042424242", kind: "direct" },
          senderId: "42424242",
          text: "canonical numeric ids",
        },
      }),
    ).toMatchObject({
      providerBody: { chatId: "42424242", fromId: 42_424_242 },
      providerTargetKey: "42424242",
      stateConversation: { id: "42424242", kind: "direct" },
    });
    const usernameDirectInbound = createOpenClawCrablineInbound({
      manifest,
      input: {
        conversation: { id: "@alice", kind: "direct" },
        senderId: "@alice",
        text: "username direct message",
      },
    });
    expect(usernameDirectInbound).toMatchObject({
      providerBody: {
        chatId: expect.stringMatching(/^\d+$/u),
        fromId: expect.any(Number),
      },
      providerTargetKey: expect.stringMatching(/^\d+$/u),
      stateConversation: {
        id: expect.stringMatching(/^\d+$/u),
        kind: "direct",
      },
    });
    expect(String(usernameDirectInbound.providerBody.fromId)).toBe(
      usernameDirectInbound.providerBody.chatId,
    );
    const caseFoldedDirectInbound = createOpenClawCrablineInbound({
      manifest,
      input: {
        conversation: { id: "@Alice", kind: "direct" },
        senderId: "@alice",
        text: "case-insensitive username",
      },
    });
    expect(caseFoldedDirectInbound.providerBody.chatId).toBe(
      usernameDirectInbound.providerBody.chatId,
    );
    expect(() =>
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          senderId: "bob",
          text: "mismatched direct identities",
        },
      }),
    ).toThrow("Telegram direct conversation and sender must normalize to the same identity.");
    const usernameGroupInbound = createOpenClawCrablineInbound({
      manifest,
      input: {
        conversation: { id: "@channelusername", kind: "group" },
        senderId: "@alice",
        text: "username group message",
      },
    });
    expect(usernameGroupInbound).toMatchObject({
      providerBody: {
        chatId: expect.stringMatching(/^-\d+$/u),
        fromId: expect.any(Number),
      },
      providerTargetKey: expect.stringMatching(/^-\d+$/u),
      qaTarget: "group:@channelusername",
      stateConversation: {
        id: expect.stringMatching(/^-\d+$/u),
        kind: "group",
      },
    });
    expect(usernameGroupInbound.providerBody.chatId).not.toBe("@channelusername");
    const usernameGroupChatId = BigInt(String(usernameGroupInbound.providerBody.chatId));
    expect(usernameGroupChatId).toBeLessThan(0n);
    expect(-usernameGroupChatId).toBeLessThanOrEqual((1n << 52n) - 1n);
    expect(usernameGroupInbound.providerBody.chatId).not.toBe(symbolicGroupDelivery.to);
    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "@channelusername", kind: "group" },
          senderId: "@alice",
          text: "repeat username group message",
        },
      }).providerBody.chatId,
    ).toBe(usernameGroupInbound.providerBody.chatId);

    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          nativeCommand: { name: "stop" },
          senderId: "alice",
          text: "/stop@CrablineBot now",
        },
      }).providerBody,
    ).toMatchObject({
      entities: [{ length: 17, offset: 0, type: "bot_command" }],
    });
    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          nativeCommand: { name: "stop" },
          senderId: "alice",
          text: "/Stop",
        },
      }).providerBody,
    ).toMatchObject({
      entities: [{ length: 5, offset: 0, type: "bot_command" }],
    });
    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          nativeCommand: { name: "stop" },
          senderId: "alice",
          text: "/STOP@CrablineBot now",
        },
      }).providerBody,
    ).toMatchObject({
      entities: [{ length: 17, offset: 0, type: "bot_command" }],
    });
    expect(() =>
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          nativeCommand: { name: "Stop!" },
          senderId: "alice",
          text: "/Stop!",
        },
      }),
    ).toThrow("Telegram native command names must contain 1-32 lowercase letters");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          nativeCommand: { name: "stop" },
          senderId: "alice",
          text: "please stop",
        },
      }),
    ).toThrow("Telegram native command text must start with /stop");

    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "group" },
          senderId: "alice",
          text: "topic message",
          threadId: "42",
        },
      }).providerBody,
    ).toMatchObject({
      chatId: expect.stringMatching(/^-\d+$/u),
      messageThreadId: 42,
    });
    const normalizedTopicInbound = createOpenClawCrablineInbound({
      manifest,
      input: {
        conversation: { id: "alice", kind: "group" },
        senderId: "alice",
        text: "normalized topic",
        threadId: " 42 ",
      },
    });
    expect(normalizedTopicInbound).toMatchObject({
      providerBody: { messageThreadId: 42 },
      providerTargetKey: `${symbolicGroupDelivery.to}:topic:42`,
      qaTarget: "thread:/v1/alice/42",
      threadId: "42",
    });

    const paddedText = "  hello from qa\n";
    expect(
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          senderId: "alice",
          text: paddedText,
        },
      }).providerBody,
    ).toMatchObject({ text: paddedText });
    expect(() =>
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          senderId: "alice",
          text: " \n\t",
        },
      }),
    ).toThrow("OpenClaw Crabline inbound message text is required.");

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest,
        targetByProviderTarget: new Map([["100001", "dm:alice"]]),
        event: {
          type: "api",
          method: "POST",
          path: "/bot<redacted>/SeNdMeSsAgE",
          body: {
            chat_id: "100001",
            text: "  hello\n",
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "  hello\n",
      to: "dm:alice",
    });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest,
        targetByProviderTarget: new Map([["42424242", "dm:canonical"]]),
        event: {
          type: "api",
          method: "POST",
          path: "/bot<redacted>/sendMessage",
          body: {
            chat_id: "00042424242",
            text: "canonical outbound id",
          },
        },
      }),
    ).toMatchObject({ to: "dm:canonical" });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest,
        targetByProviderTarget: new Map([["100001", "dm:alice"]]),
        event: {
          type: "api",
          method: "POST",
          path: "/bot<redacted>/sendPhoto",
          body: {
            caption: "media caption",
            chat_id: "100001",
            photo: "fixture.png",
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "media caption",
      to: "dm:alice",
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest,
        targetByProviderTarget: new Map([["100001", "dm:alice"]]),
        event: {
          type: "api",
          method: "POST",
          path: "/bot<redacted>/sendAudio",
          body: {
            audio: "fixture.mp3",
            caption: "audio caption",
            chat_id: "100001",
          },
        },
      }),
    ).toMatchObject({
      text: "audio caption",
      to: "dm:alice",
    });
  });

  it("keeps Telegram username identity consistent across the bridge and provider server", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-telegram-identity-"));
    const adapter = await startOpenClawCrablineAdapter({
      channel: "telegram",
      recorderPath: path.join(outputDir, "telegram.jsonl"),
    });
    try {
      const telegram = adapter.manifest;
      expect(telegram.provider).toBe("telegram");
      if (telegram.provider !== "telegram") {
        throw new Error("Expected Telegram provider manifest.");
      }
      const delivery = adapter.createAgentDelivery({ target: "channel:@ExampleGroup" });
      const inbound = adapter.createInbound({
        input: {
          conversation: { id: "@examplegroup", kind: "group" },
          senderId: "@Alice",
          text: "inbound topic message",
          threadId: "42",
        },
      });
      const response = await fetch(`${telegram.baseUrl}/bot${telegram.botToken}/sendMessage`, {
        body: JSON.stringify({
          chat_id: delivery.to,
          message_thread_id: 42,
          text: "outbound topic message",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        result: { chat: { id: number }; message_thread_id: number };
      };

      expect(delivery.to).toBe("@examplegroup");
      expect(response.status).toBe(200);
      expect(String(payload.result.chat.id)).toBe(inbound.providerBody.chatId);
      expect(payload.result.message_thread_id).toBe(42);
      expect(inbound.providerTargetKey).toBe(`${payload.result.chat.id}:topic:42`);
      expect(
        adapter.createOutboundFromRecorderEvent({
          event: {
            accepted: true,
            body: {
              chat_id: "@EXAMPLEGROUP",
              message_thread_id: 42,
              text: "outbound topic message",
            },
            method: "POST",
            path: "/bot<redacted>/sendMessage",
            type: "api",
          },
          targetByProviderTarget: new Map([[inbound.providerTargetKey, inbound.qaTarget]]),
        }),
      ).toMatchObject({
        text: "outbound topic message",
        to: inbound.qaTarget,
      });
    } finally {
      await adapter.close();
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects blank or unknown inbound conversations before provider translation", () => {
    expect(() =>
      createOpenClawCrablineInbound({
        input: {
          conversation: { id: "   ", kind: "direct" },
          senderId: "user-1",
          text: "hello",
        },
        manifest,
      }),
    ).toThrow(/required/u);
    expect(() =>
      createOpenClawCrablineInbound({
        input: {
          conversation: { id: "alice", kind: "channel" } as never,
          senderId: "user-1",
          text: "hello",
        },
        manifest,
      }),
    ).toThrow("OpenClaw Crabline inbound conversation kind must be direct or group.");
  });

  it("rejects blank and malformed reserved QA targets", () => {
    const invalidTargets = [
      "",
      " ",
      "dm",
      "dm:",
      "dm: ",
      "dm :alice",
      "DM:alice",
      "group",
      "group:",
      "channel",
      "channel:",
      "thread",
      "thread:",
      "thread:alice",
      "thread:/42",
      "thread:alice/",
      "thread:alice/42/extra",
    ];

    for (const target of invalidTargets) {
      expect(() => createOpenClawCrablineAgentDelivery({ manifest, target })).toThrow(
        "OpenClaw Crabline target must be a non-blank native id or a valid",
      );
    }

    expect(createOpenClawCrablineAgentDelivery({ manifest, target: " dm:alice " }).to).toBe(
      createOpenClawCrablineAgentDelivery({ manifest, target: "dm:alice" }).to,
    );
    expect(
      createOpenClawCrablineAgentDelivery({ manifest, target: " thread:alice / 42 " }).to,
    ).toBe(createOpenClawCrablineAgentDelivery({ manifest, target: "thread:alice/42" }).to);
  });

  it("validates Telegram numeric target signs by declared kind", () => {
    for (const target of ["dm:0", "dm:-1", "group:0", "group:-0", "group:1", "thread:1/42"]) {
      expect(() => createOpenClawCrablineAgentDelivery({ manifest, target })).toThrow(
        "Telegram numeric target sign does not match the declared target kind.",
      );
    }
  });

  it("rejects Telegram numeric identities that cannot round-trip through JSON numbers", () => {
    for (const target of [
      `dm:${BigInt(Number.MAX_SAFE_INTEGER) + 1n}`,
      `group:${BigInt(Number.MIN_SAFE_INTEGER) - 1n}`,
    ]) {
      expect(() => createOpenClawCrablineAgentDelivery({ manifest, target })).toThrow(
        "Telegram numeric target must be a safe integer.",
      );
    }

    expect(() =>
      createOpenClawCrablineInbound({
        manifest,
        input: {
          conversation: { id: "alice", kind: "direct" },
          senderId: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
          text: "unsafe sender",
        },
      }),
    ).toThrow("Telegram numeric target must be a safe integer.");
  });

  it("validates explicit Telegram thread target ids", () => {
    const symbolicGroup = createOpenClawCrablineAgentDelivery({
      manifest,
      target: "group:alice",
    }).to;

    for (const threadId of ["42", String(Number.MAX_SAFE_INTEGER)]) {
      expect(
        createOpenClawCrablineAgentDelivery({
          manifest,
          target: `thread:alice/${threadId}`,
        }).to,
      ).toBe(`${symbolicGroup}:topic:${threadId}`);
    }

    for (const threadId of [
      "0",
      "not-a-number",
      "-1",
      String(Number.MAX_SAFE_INTEGER + 1),
      "9".repeat(400),
    ]) {
      expect(() =>
        createOpenClawCrablineAgentDelivery({
          manifest,
          target: `thread:alice/${threadId}`,
        }),
      ).toThrow("Telegram thread target must be a safe positive integer.");
    }

    for (const threadId of ["0", "-1", "not-a-number", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() =>
        createOpenClawCrablineInbound({
          manifest,
          input: {
            conversation: { id: "alice", kind: "group" },
            senderId: "alice",
            text: "invalid topic",
            threadId,
          },
        }),
      ).toThrow("Telegram thread target must be a safe positive integer.");
    }
  });

  it("maps WhatsApp QA targets, inbound messages, and recorder events", () => {
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "dm:15551234567@C.US",
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "15551234567@s.whatsapp.net",
      replyChannel: "whatsapp",
      replyTo: "15551234567@s.whatsapp.net",
    });
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "group:15551234567-1234567890@g.us",
      }),
    ).toThrow("WhatsApp Crabline WebSocket outbound supports direct targets only.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "dm:120363001234567890@g.us",
      }),
    ).toThrow("WhatsApp target kind does not match the native JID.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "group:15551234567@s.whatsapp.net",
      }),
    ).toThrow("WhatsApp target kind does not match the native JID.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "thread:120363001234567890@g.us/message-1",
      }),
    ).toThrow("WhatsApp does not support thread targets.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: whatsappManifest,
        input: {
          conversation: { id: "120363001234567890@g.us", kind: "group" },
          senderId: "15551234567@s.whatsapp.net",
          text: "hello",
          threadId: "message-1",
        },
      }),
    ).toThrow("WhatsApp does not support thread targets.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: whatsappManifest,
        input: {
          conversation: { id: "120363001234567890@g.us", kind: "direct" },
          senderId: "15551234567@s.whatsapp.net",
          text: "mismatched kind",
        },
      }),
    ).toThrow("WhatsApp inbound conversation kind does not match the native JID.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: whatsappManifest,
        input: {
          conversation: { id: "15551234567@s.whatsapp.net", kind: "group" },
          senderId: "15557654321@s.whatsapp.net",
          text: "mismatched kind",
        },
      }),
    ).toThrow("WhatsApp inbound conversation kind does not match the native JID.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: whatsappManifest,
        input: {
          conversation: { id: "15551234567@s.whatsapp.net", kind: "direct" },
          senderId: "15557654321@s.whatsapp.net",
          text: "mismatched direct identity",
        },
      }),
    ).toThrow("WhatsApp direct conversation and sender must identify the same recipient.");
    expect(
      createOpenClawCrablineInbound({
        manifest: whatsappManifest,
        input: {
          conversation: { id: "15551234567:2@s.whatsapp.net", kind: "direct" },
          senderId: "15551234567:7@C.US",
          text: "matching device identity",
        },
      }),
    ).toMatchObject({
      providerBody: {
        chatJid: "15551234567:2@s.whatsapp.net",
        senderJid: "15551234567:7@s.whatsapp.net",
      },
      stateConversation: {
        id: "15551234567:2@s.whatsapp.net",
        kind: "direct",
      },
    });

    const inbound = createOpenClawCrablineInbound({
      manifest: whatsappManifest,
      input: {
        conversation: { id: "120363001234567890@G.US", kind: "group" },
        senderId: "15557654321@C.US",
        senderName: "Alice",
        text: "hello",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        chatJid: "120363001234567890@g.us",
        senderJid: "15557654321@s.whatsapp.net",
        pushName: "Alice",
        text: "hello",
      },
      providerHeaders: {
        "content-type": "application/json",
        "x-crabline-admin-token": "crabline-whatsapp-admin-token",
      },
      providerTargetKey: "120363001234567890@g.us",
      providerUrl: "http://127.0.0.1:5678/_crabline/admin/whatsapp/inbound",
      qaTarget: "group:120363001234567890@g.us",
      stateConversation: {
        id: "120363001234567890@g.us",
        kind: "group",
      },
    });
    expect(
      createOpenClawCrablineInbound({
        manifest: whatsappManifest,
        input: {
          conversation: { id: "15551234567-1234567890@g.us", kind: "group" },
          senderId: "15551234567@s.whatsapp.net",
          text: "legacy group",
        },
      }),
    ).toMatchObject({
      providerBody: { chatJid: "15551234567-1234567890@g.us" },
      providerTargetKey: "15551234567-1234567890@g.us",
      stateConversation: { id: "15551234567-1234567890@g.us", kind: "group" },
    });
    for (const id of [
      "1234-1234567890@g.us",
      "1234567890-1234@g.us",
      "1234567890--1234567890@g.us",
      "1234567890-1234567890-extra@g.us",
    ]) {
      expect(() =>
        createOpenClawCrablineAgentDelivery({
          manifest: whatsappManifest,
          target: `group:${id}`,
        }),
      ).toThrow("WhatsApp target must be a native WhatsApp JID.");
    }

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: whatsappManifest,
        targetByProviderTarget: new Map([["15551234567@s.whatsapp.net", "dm:alice"]]),
        event: {
          accepted: true,
          type: "api",
          method: "POST",
          path: "/v25.0/100000000000000/messages",
          body: {
            to: "15551234567",
            text: { body: "hello from openclaw" },
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "hello from openclaw",
      to: "dm:alice",
    });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: whatsappManifest,
        targetByProviderTarget: new Map([
          ["120363001234567890@g.us", "group:120363001234567890@g.us"],
        ]),
        event: {
          accepted: true,
          type: "api",
          method: "WEBSOCKET",
          path: "/ws/chat",
          body: {
            key: {
              fromMe: true,
              id: "3EB0AABBCCDDEEFF0022",
              remoteJid: "120363001234567890@g.us",
            },
            message: { conversation: "unsupported group send" },
          },
        },
      }),
    ).toBeNull();
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: whatsappManifest,
        targetByProviderTarget: new Map([["15551234567@s.whatsapp.net", "dm:alice"]]),
        event: {
          accepted: true,
          type: "api",
          method: "WEBSOCKET",
          path: "/ws/chat",
          body: {
            key: {
              fromMe: true,
              id: "3EB0AABBCCDDEEFF0011",
              remoteJid: "15551234567:0@s.whatsapp.net",
            },
            message: { conversation: "hello through Baileys" },
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "hello through Baileys",
      to: "dm:alice",
    });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: whatsappManifest,
        targetByProviderTarget: new Map(),
        event: {
          accepted: false,
          type: "api",
          path: "/v25.0/100000000000000/messages",
          body: {
            to: "15551234567",
            text: { body: "rejected send" },
          },
        },
      }),
    ).toBeNull();
    for (const body of [
      { jid: "15551234567@s.whatsapp.net", text: "rejected legacy shape" },
      { text: "rejected flat text", to: "15551234567" },
    ]) {
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          manifest: whatsappManifest,
          targetByProviderTarget: new Map(),
          event: {
            type: "api",
            method: "POST",
            path: "/v25.0/100000000000000/messages",
            body,
          },
        }),
      ).toBeNull();
    }
  });

  it("maps Slack QA targets, inbound messages, and recorder events", () => {
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: slackManifest,
        target: "thread:C1234567890/1700000000.000100",
      }),
    ).toEqual({
      channel: "slack",
      to: "C1234567890",
      replyChannel: "slack",
      replyTo: "C1234567890:thread:1700000000.000100",
    });
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: slackManifest,
        target: "thread:D1234567890/1700000000.000100",
      }),
    ).toEqual({
      channel: "slack",
      to: "D1234567890",
      replyChannel: "slack",
      replyTo: "D1234567890:thread:1700000000.000100",
    });
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: slackManifest,
        target: "thread:U1234567890/1700000000.000100",
      }),
    ).toThrow("Slack thread targets require a native parent conversation id.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: slackManifest,
        target: "dm:C1234567890",
      }),
    ).toThrow("Slack target kind does not match the native conversation id.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: slackManifest,
        input: {
          conversation: { id: "D1234567890", kind: "group" },
          senderId: "U1234567890",
          text: "mismatched kind",
        },
      }),
    ).toThrow("Slack inbound conversation kind does not match the native channel id.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: slackManifest,
        input: {
          conversation: { id: "C1234567890", kind: "direct" },
          senderId: "U1234567890",
          text: "mismatched kind",
        },
      }),
    ).toThrow("Slack inbound conversation kind does not match the native channel id.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: slackManifest,
        target: "group:D1234567890",
      }),
    ).toThrow("Slack target kind does not match the native conversation id.");

    const inbound = createOpenClawCrablineInbound({
      manifest: slackManifest,
      input: {
        conversation: { id: "C1234567890", kind: "group" },
        senderId: "U1234567890",
        senderName: "Alice",
        text: "hello",
        threadId: "1700000000.000100",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        channel: "C1234567890",
        user: "U1234567890",
        username: "Alice",
        threadTs: "1700000000.000100",
        text: "hello",
      },
      providerHeaders: {
        "content-type": "application/json",
        "x-crabline-admin-token": "crabline-slack-admin-token",
      },
      providerTargetKey: "C1234567890:thread:1700000000.000100",
      providerUrl: "http://127.0.0.1:2468/crabline/slack/inbound",
      qaTarget: "thread:/v1/C1234567890/1700000000.000100",
      stateConversation: {
        id: "C1234567890",
        kind: "group",
      },
      threadId: "1700000000.000100",
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: slackManifest,
        targetByProviderTarget: new Map([
          ["C1234567890:thread:1700000000.000100", "thread:qa/parent"],
        ]),
        event: {
          type: "api",
          method: "POST",
          path: "/api/chat.postMessage",
          body: {
            channel: "C1234567890",
            text: "hello from openclaw",
            thread_ts: "1700000000.000100",
          },
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "hello from openclaw",
      to: "thread:qa/parent",
    });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: slackManifest,
        targetByProviderTarget: new Map([["C1234567890", "group:qa"]]),
        event: {
          type: "api",
          method: "POST",
          path: "/api/chat.postMessage",
          body: {
            blocks: [{ text: { text: "block fallback", type: "mrkdwn" }, type: "section" }],
            channel: "C1234567890",
            text: "",
          },
        },
      }),
    ).toMatchObject({ text: "block fallback", to: "group:qa" });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: slackManifest,
        targetByProviderTarget: new Map([["C1234567890", "group:qa"]]),
        event: {
          type: "api",
          method: "POST",
          path: "/api/chat.postMessage",
          body: {
            attachments: JSON.stringify([{ fallback: "attachment fallback" }]),
            channel: "C1234567890",
            text: "",
          },
        },
      }),
    ).toMatchObject({ text: "attachment fallback", to: "group:qa" });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: slackManifest,
        targetByProviderTarget: new Map(),
        event: {
          type: "api",
          method: "POST",
          path: "/api/chat.postMessage",
          body: {
            blocks: [
              {
                elements: [
                  {
                    elements: [
                      { type: "user", user_id: "U1234567890" },
                      { text: " in ", type: "text" },
                      { channel_id: "C1234567890", type: "channel" },
                      { name: "wave", type: "emoji" },
                    ],
                    type: "rich_text_section",
                  },
                  {
                    elements: [{ text: "repeat", type: "text" }],
                    type: "rich_text_section",
                  },
                  {
                    elements: [{ text: "repeat", type: "text" }],
                    type: "rich_text_section",
                  },
                ],
                type: "rich_text",
              },
            ],
            channel: "C1234567890",
            text: " \n\t",
          },
        },
      }),
    ).toMatchObject({
      text: "<@U1234567890> in <#C1234567890>:wave:\nrepeat\nrepeat",
    });
  });

  it("maps Signal QA targets, inbound messages, and recorder events", () => {
    expect(
      createOpenClawCrablineAgentDelivery({ manifest: signalManifest, target: "group:group-1" }),
    ).toEqual({
      channel: "signal",
      replyChannel: "signal",
      replyTo: "group:group-1",
      to: "group:group-1",
    });
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: signalManifest,
        target: "thread:group-1/1700000000001",
      }),
    ).toThrow("Signal does not support thread targets.");
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: signalManifest,
        input: {
          conversation: { id: "group-1", kind: "group" },
          senderId: "+15551234567",
          text: "hello",
          threadId: "1700000000001",
        },
      }),
    ).toThrow("Signal does not support thread targets.");

    const directDelivery = createOpenClawCrablineAgentDelivery({
      manifest: signalManifest,
      target: "dm:qa-operator",
    });
    expect(directDelivery.to).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: signalManifest,
        target: "dm:+15551234567",
      }).to,
    ).toBe("+15551234567");
    const firstSignalAdapter =
      SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE.createAdapterFromManifest(signalManifest);
    const firstRecipient = firstSignalAdapter.createAgentDelivery(
      parseQaTarget("dm:recipient-1719"),
    ).to;
    const secondRecipient = firstSignalAdapter.createAgentDelivery(
      parseQaTarget("dm:recipient-5529"),
    ).to;
    const secondSignalAdapter =
      SIGNAL_OPENCLAW_CRABLINE_PROVIDER_BRIDGE.createAdapterFromManifest(signalManifest);
    expect(secondSignalAdapter.createAgentDelivery(parseQaTarget("dm:recipient-5529")).to).toBe(
      secondRecipient,
    );
    expect(secondSignalAdapter.createAgentDelivery(parseQaTarget("dm:recipient-1719")).to).toBe(
      firstRecipient,
    );
    expect(firstRecipient).not.toBe(secondRecipient);
    expect(firstRecipient).not.toBe(
      firstSignalAdapter.createAgentDelivery(parseQaTarget("dm:+15551234567")).to,
    );

    const directInbound = createOpenClawCrablineInbound({
      manifest: signalManifest,
      input: {
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-operator",
        text: "hello",
      },
    });
    expect(directInbound.providerBody).toMatchObject({ sourceUuid: directDelivery.to });
    expect(directInbound.providerTargetKey).toBe(directDelivery.to);
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: signalManifest,
        input: {
          conversation: { id: "qa-operator", kind: "direct" },
          senderId: "different-recipient",
          text: "hello",
        },
      }),
    ).toThrow("Signal direct conversation and sender must identify the same recipient.");

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: signalManifest,
        targetByProviderTarget: new Map([[directInbound.providerTargetKey, "dm:qa-operator"]]),
        event: {
          body: {
            method: "send",
            params: { message: "direct reply", recipient: [directDelivery.to] },
          },
          method: "POST",
          path: "/api/v1/rpc",
          type: "api",
        },
      }),
    ).toMatchObject({ text: "direct reply", to: "dm:qa-operator" });

    for (const testCase of [
      { params: { recipient: directDelivery.to }, providerTarget: directDelivery.to },
      {
        params: { recipient: `uuid:${directDelivery.to.toUpperCase()}` },
        providerTarget: directDelivery.to,
      },
      { params: { recipient: "15551234567" }, providerTarget: "+15551234567" },
      { params: { recipients: [directDelivery.to] }, providerTarget: directDelivery.to },
      {
        params: { recipients: ["15551234567", "+15551234567"] },
        providerTarget: "+15551234567",
      },
      { params: { groupIds: ["group-1"] }, providerTarget: "group:group-1" },
      { params: { username: "qa-operator" }, providerTarget: directDelivery.to },
      { params: { usernames: ["qa-operator"] }, providerTarget: directDelivery.to },
      { params: { noteToSelf: true }, providerTarget: signalManifest.account },
    ]) {
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          manifest: signalManifest,
          targetByProviderTarget: new Map([[testCase.providerTarget, "dm:mapped"]]),
          event: {
            body: {
              method: "send",
              params: { message: "recipient form", ...testCase.params },
            },
            method: "POST",
            path: "/api/v1/rpc",
            type: "api",
          },
        }),
      ).toMatchObject({ text: "recipient form", to: "dm:mapped" });
    }
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: signalManifest,
        targetByProviderTarget: new Map([
          [directDelivery.to, "dm:first"],
          ["+15557654321", "dm:second"],
        ]),
        event: {
          body: {
            method: "send",
            params: {
              message: "fan-out cannot be represented",
              recipients: [directDelivery.to, "+15557654321"],
            },
          },
          method: "POST",
          path: "/api/v1/rpc",
          type: "api",
        },
      }),
    ).toBeNull();

    expect(
      createOpenClawCrablineInbound({
        manifest: signalManifest,
        input: {
          conversation: { id: "group-1", kind: "group" },
          senderId: "+15551234567",
          senderName: "Alice",
          text: "hello",
        },
      }),
    ).toMatchObject({
      providerBody: {
        groupId: "group-1",
        sourceName: "Alice",
        sourceNumber: "+15551234567",
        text: "hello",
      },
      providerTargetKey: "group:group-1",
      providerUrl: "http://127.0.0.1:1357/crabline/signal/inbound",
      qaTarget: "group:group-1",
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: signalManifest,
        targetByProviderTarget: new Map([["group:group-1", "group:qa"]]),
        event: {
          body: {
            method: "send",
            params: { groupId: "group-1", message: "hello from openclaw" },
          },
          method: "POST",
          path: "/api/v1/rpc",
          type: "api",
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
      text: "hello from openclaw",
      to: "group:qa",
    });
  });

  it("preserves non-blank recorder message whitespace across bridges", () => {
    const cases: Array<{
      event: (text: string) => unknown;
      manifest: CrablineServerManifest;
      name: string;
    }> = [
      {
        name: "Telegram",
        manifest,
        event: (text) => ({
          body: { caption: text, chat_id: "100001", photo: "fixture.png" },
          method: "POST",
          path: "/bot<redacted>/sendPhoto",
          type: "api",
        }),
      },
      {
        name: "WhatsApp",
        manifest: whatsappManifest,
        event: (text) => ({
          accepted: true,
          body: { text: { body: text }, to: "15551234567@s.whatsapp.net" },
          method: "POST",
          path: new URL(whatsappManifest.endpoints.messagesUrl).pathname,
          type: "api",
        }),
      },
      {
        name: "Slack",
        manifest: slackManifest,
        event: (text) => ({
          body: { channel: "C1234567890", text },
          method: "POST",
          path: "/api/chat.postMessage",
          type: "api",
        }),
      },
      {
        name: "Signal",
        manifest: signalManifest,
        event: (text) => ({
          body: {
            method: "send",
            params: { message: text, recipient: ["+15551234567"] },
          },
          method: "POST",
          path: "/api/v1/rpc",
          type: "api",
        }),
      },
      {
        name: "Mattermost",
        manifest: mattermostManifest,
        event: (text) => ({
          body: { channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa", message: text },
          method: "POST",
          path: "/api/v4/posts",
          type: "api",
        }),
      },
      {
        name: "Matrix",
        manifest: matrixManifest,
        event: (text) => ({
          body: { body: text },
          method: "PUT",
          path: "/_matrix/client/v3/rooms/!room%3Amatrix.test/send/m.room.message/txn-1",
          type: "api",
        }),
      },
      {
        name: "Zalo",
        manifest: zaloManifest,
        event: (text) => ({
          body: { chat_id: "1459232241454765289", text },
          method: "POST",
          path: "/bot<redacted>/sendMessage",
          type: "api",
        }),
      },
    ];

    for (const testCase of cases) {
      const text = `  ${testCase.name} reply\n`;
      const targetByProviderTarget =
        testCase.manifest.provider === "mattermost"
          ? new Map([["aaaaaaaaaaaaaaaaaaaaaaaaaa", "group:qa"]])
          : new Map<string, string>();
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          event: testCase.event(text),
          manifest: testCase.manifest,
          targetByProviderTarget,
        }),
      ).toMatchObject({ text });
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          event: testCase.event(" \n\t"),
          manifest: testCase.manifest,
          targetByProviderTarget,
        }),
      ).toBeNull();
    }
  });

  it("requires exact outbound routes and accepted recorder outcomes", () => {
    const cases: Array<{
      event: Record<string, unknown>;
      manifest: CrablineServerManifest;
    }> = [
      {
        manifest: mattermostManifest,
        event: {
          body: { channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa", message: "reply" },
          method: "POST",
          path: "/api/v4/posts",
          type: "api",
        },
      },
      {
        manifest: matrixManifest,
        event: {
          body: { body: "reply", msgtype: "m.text" },
          method: "PUT",
          path: "/_matrix/client/v3/rooms/!room%3Amatrix.test/send/m.room.message/txn-1",
          type: "api",
        },
      },
      {
        manifest: signalManifest,
        event: {
          body: {
            method: "send",
            params: { message: "reply", recipient: ["+15551234567"] },
          },
          method: "POST",
          path: "/api/v1/rpc",
          type: "api",
        },
      },
      {
        manifest: slackManifest,
        event: {
          body: { channel: "C1234567890", text: "reply" },
          method: "POST",
          path: "/api/chat.postMessage",
          type: "api",
        },
      },
      {
        manifest,
        event: {
          body: { chat_id: "100001", text: "reply" },
          method: "POST",
          path: "/bot<redacted>/sendMessage",
          type: "api",
        },
      },
      {
        manifest: whatsappManifest,
        event: {
          body: { text: { body: "reply" }, to: "15551234567" },
          method: "POST",
          path: new URL(whatsappManifest.endpoints.messagesUrl).pathname,
          type: "api",
        },
      },
      {
        manifest: zaloManifest,
        event: {
          body: { chat_id: "group-1", text: "reply" },
          method: "POST",
          path: "/bot<redacted>/sendMessage",
          type: "api",
        },
      },
    ];

    for (const testCase of cases) {
      const targetByProviderTarget =
        testCase.manifest.provider === "mattermost"
          ? new Map([["aaaaaaaaaaaaaaaaaaaaaaaaaa", "group:qa"]])
          : new Map<string, string>();
      const translate = (event: unknown) =>
        translateOpenClawCrablineOutbound({
          event,
          manifest: testCase.manifest,
          targetByProviderTarget,
        });

      expect(translate({ ...testCase.event, accepted: true })).not.toBeNull();
      expect(translate({ ...testCase.event, accepted: true, method: "PATCH" })).toBeNull();
      expect(
        translate({
          ...testCase.event,
          accepted: true,
          path: `${String(testCase.event.path)}/spoofed`,
        }),
      ).toBeNull();
      expect(translate({ ...testCase.event, accepted: false })).toBeNull();
      expect(translate(testCase.event)).toBeNull();
    }

    expect(
      translateOpenClawCrablineOutbound({
        event: cases[0]!.event,
        manifest: mattermostManifest,
        targetByProviderTarget: new Map(),
      }),
    ).toBeNull();
    const whatsappWebSocketEvent = {
      accepted: true,
      body: {
        key: { remoteJid: "15551234567@s.whatsapp.net" },
        message: { conversation: "reply" },
      },
      method: "WEBSOCKET",
      path: "/ws/chat",
      type: "api",
    };
    expect(
      translateOpenClawCrablineOutbound({
        event: whatsappWebSocketEvent,
        manifest: whatsappManifest,
        targetByProviderTarget: new Map(),
      }),
    ).not.toBeNull();
    expect(
      translateOpenClawCrablineOutbound({
        event: {
          ...whatsappWebSocketEvent,
          body: {
            key: { remoteJid: "120363001234567890@g.us" },
            message: { conversation: "unsupported group reply" },
          },
        },
        manifest: whatsappManifest,
        targetByProviderTarget: new Map(),
      }),
    ).toBeNull();
  });

  it("maps Mattermost QA targets, inbound messages, and recorder events", () => {
    const userId = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const otherUserId = "cccccccccccccccccccccccccc";
    const channelId = "dddddddddddddddddddddddddd";
    const otherChannelId = "eeeeeeeeeeeeeeeeeeeeeeeeee";
    const rootId = "ffffffffffffffffffffffffff";
    const delivery = createOpenClawCrablineAgentDelivery({
      manifest: mattermostManifest,
      target: `dm:${userId}`,
    });
    expect(delivery).toEqual({
      channel: "mattermost",
      replyChannel: "mattermost",
      replyTo: `user:${userId}`,
      to: `user:${userId}`,
    });

    for (const target of ["dm:alice", "group:UPPERCASEIDENTIFIER123456"]) {
      expect(() =>
        createOpenClawCrablineAgentDelivery({
          manifest: mattermostManifest,
          target,
        }),
      ).toThrow("must be exactly 26 lowercase alphanumeric characters");
    }

    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: mattermostManifest,
        target: `thread:${channelId}/${rootId}`,
      }),
    ).toThrow("Mattermost thread targets require OpenClaw QA thread forwarding.");

    const inbound = createOpenClawCrablineInbound({
      manifest: mattermostManifest,
      input: {
        conversation: { id: ` ${userId} `, kind: "direct" },
        senderId: userId,
        senderName: "Alice",
        text: "hello",
      },
    });
    expect(inbound).toMatchObject({
      providerBody: {
        channelType: "D",
        senderName: "Alice",
        text: "hello",
      },
      providerUrl: "http://127.0.0.1:9753/crabline/mattermost/inbound",
      qaTarget: `dm:${userId}`,
      stateConversation: {
        id: userId,
        kind: "direct",
      },
    });
    expect(inbound.providerBody.senderId).toBe(userId);
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: mattermostManifest,
        input: {
          conversation: { id: userId, kind: "direct" },
          senderId: otherUserId,
          text: "hello",
        },
      }),
    ).toThrow("Mattermost direct conversation and sender must identify the same recipient.");
    for (const conversationId of ["", " \n\t"]) {
      expect(() =>
        createOpenClawCrablineInbound({
          manifest: mattermostManifest,
          input: {
            conversation: { id: conversationId, kind: "direct" },
            senderId: userId,
            text: "hello",
          },
        }),
      ).toThrow("OpenClaw Crabline inbound conversation id is required.");
    }

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: mattermostManifest,
        targetByProviderTarget: new Map([[inbound.providerTargetKey, `dm:${userId}`]]),
        event: {
          body: { channel_id: inbound.providerTargetKey, message: "hello from openclaw" },
          method: "POST",
          path: "/api/v4/posts",
          type: "api",
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      senderName: "OpenClaw QA",
      text: "hello from openclaw",
      to: `dm:${userId}`,
    });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: mattermostManifest,
        targetByProviderTarget: new Map(),
        event: {
          body: { channel_id: inbound.providerTargetKey, message: "unmapped reply" },
          method: "POST",
          path: "/api/v4/posts",
          type: "api",
        },
      }),
    ).toBeNull();

    const binding = createOpenClawCrablineProviderBinding(mattermostManifest);
    expect(binding).toMatchObject({
      channel: "mattermost",
      requiredPluginIds: ["mattermost"],
    });
    expect(binding.createGatewayConfig()).toMatchObject({
      channels: { mattermost: { chatmode: "onmessage", streaming: { mode: "off" } } },
    });

    const threadInbound = createOpenClawCrablineInbound({
      manifest: mattermostManifest,
      input: {
        conversation: { id: channelId, kind: "group" },
        senderId: userId,
        text: "thread reply",
        threadId: rootId,
      },
    });
    expect(threadInbound.providerTargetKey).toBe(`${channelId}:thread:${rootId}`);
    expect(threadInbound.threadId).toBe(rootId);
    const otherThreadInbound = createOpenClawCrablineInbound({
      manifest: mattermostManifest,
      input: {
        conversation: { id: otherChannelId, kind: "group" },
        senderId: userId,
        text: "same root in another channel",
        threadId: rootId,
      },
    });
    expect(otherThreadInbound.providerBody.rootId).toBe(rootId);
    const blankThreadInbound = createOpenClawCrablineInbound({
      manifest: mattermostManifest,
      input: {
        conversation: { id: channelId, kind: "group" },
        senderId: userId,
        text: "top-level reply",
        threadId: " \n\t",
      },
    });
    expect(blankThreadInbound).not.toHaveProperty("threadId");
    expect(blankThreadInbound.providerBody).not.toHaveProperty("rootId");
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: mattermostManifest,
        targetByProviderTarget: new Map([
          [blankThreadInbound.providerTargetKey, `group:${channelId}`],
        ]),
        event: {
          body: {
            channel_id: blankThreadInbound.providerBody.channelId,
            message: "top-level response",
            root_id: " \n\t",
          },
          method: "POST",
          path: "/api/v4/posts",
          type: "api",
        },
      }),
    ).toMatchObject({ to: `group:${channelId}` });
    expect(() =>
      createOpenClawCrablineInbound({
        manifest: mattermostManifest,
        input: {
          conversation: { id: channelId, kind: "group" },
          senderId: userId,
          text: "invalid root",
          threadId: "parent",
        },
      }),
    ).toThrow("must be exactly 26 lowercase alphanumeric characters");
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: mattermostManifest,
        targetByProviderTarget: new Map([
          [threadInbound.providerTargetKey, `thread:${channelId}/${rootId}`],
        ]),
        event: {
          body: {
            channel_id: threadInbound.providerBody.channelId,
            message: "thread response",
            root_id: threadInbound.providerBody.rootId,
          },
          method: "POST",
          path: "/api/v4/posts",
          type: "api",
        },
      }),
    ).toMatchObject({ to: `thread:${channelId}/${rootId}` });
  });

  it("maps Matrix native rooms, inbound messages, and recorder events", () => {
    const roomId = "!qa:matrix.test";
    const domainlessRoomId = `!${Buffer.alloc(32, 0xab).toString("base64url")}`;
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: matrixManifest,
        target: `channel:${roomId}`,
      }),
    ).toEqual({
      channel: "matrix",
      replyChannel: "matrix",
      replyTo: `room:${roomId}`,
      to: `room:${roomId}`,
    });
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: matrixManifest,
        target: `channel:${domainlessRoomId}`,
      }),
    ).toMatchObject({
      replyTo: `room:${domainlessRoomId}`,
      to: `room:${domainlessRoomId}`,
    });
    expect(() =>
      createOpenClawCrablineAgentDelivery({ manifest: matrixManifest, target: "channel:general" }),
    ).toThrow("Matrix targets must be native room IDs.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: matrixManifest,
        target: "channel:!qa:bad/server",
      }),
    ).toThrow("Matrix targets must be native room IDs.");
    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: matrixManifest,
        target: `thread:${roomId}/$parent:matrix.test`,
      }),
    ).toThrow("Matrix thread targets require OpenClaw QA thread forwarding.");

    const inbound = createOpenClawCrablineInbound({
      manifest: matrixManifest,
      input: {
        conversation: { id: roomId, kind: "group" },
        senderId: "@alice:matrix.test",
        senderName: "Alice",
        text: "hello Matrix",
      },
    });
    expect(inbound).toMatchObject({
      providerBody: {
        direct: false,
        roomId,
        senderId: "@alice:matrix.test",
        senderName: "Alice",
        text: "hello Matrix",
      },
      providerTargetKey: roomId,
      providerUrl: "http://127.0.0.1:8642/crabline/matrix/inbound",
      qaTarget: `group:${roomId}`,
    });

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: matrixManifest,
        targetByProviderTarget: new Map([[roomId, `group:${roomId}`]]),
        event: {
          body: { body: "hello from OpenClaw", msgtype: "m.text" },
          method: "PUT",
          path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/txn-1`,
          type: "api",
        },
      }),
    ).toEqual({
      accountId: "default",
      senderId: "@openclaw:matrix.test",
      senderName: "OpenClaw QA",
      text: "hello from OpenClaw",
      to: `group:${roomId}`,
    });
    const matrixAdapter =
      MATRIX_OPENCLAW_CRABLINE_PROVIDER_BRIDGE.createAdapterFromManifest(matrixManifest);
    const transactionEvent = {
      accepted: true,
      body: { body: "first delivery", msgtype: "m.text" },
      method: "PUT",
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/stable-transaction`,
      type: "api",
    };
    expect(
      matrixAdapter.createOutboundFromRecorderEvent({
        event: transactionEvent,
        targetByProviderTarget: new Map([[roomId, `group:${roomId}`]]),
      }),
    ).toMatchObject({ text: "first delivery", to: `group:${roomId}` });
    expect(
      matrixAdapter.createOutboundFromRecorderEvent({
        event: {
          ...transactionEvent,
          body: { body: "replayed body must not deliver", msgtype: "m.text" },
        },
        targetByProviderTarget: new Map([[roomId, `group:${roomId}`]]),
      }),
    ).toBeNull();
    expect(
      matrixAdapter.createOutboundFromRecorderEvent({
        event: {
          ...transactionEvent,
          path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/replayed-marker`,
          replayed: true,
        },
        targetByProviderTarget: new Map([[roomId, `group:${roomId}`]]),
      }),
    ).toBeNull();

    for (const malformedPath of [
      "/_matrix/client/v3/rooms/%ZZ/send/m.room.message/txn-1",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/%ZZ/txn-1`,
    ]) {
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          manifest: matrixManifest,
          targetByProviderTarget: new Map(),
          event: {
            body: { body: "malformed path", msgtype: "m.text" },
            method: "PUT",
            path: malformedPath,
            type: "api",
          },
        }),
      ).toBeNull();
    }

    const threadedInbound = createOpenClawCrablineInbound({
      manifest: matrixManifest,
      input: {
        conversation: { id: ` ${roomId} `, kind: "group" },
        senderId: "@alice:matrix.test",
        text: "threaded Matrix message",
        threadId: " $root:matrix.test ",
      },
    });
    expect(threadedInbound).toMatchObject({
      providerTargetKey: `${roomId}:thread:$root:matrix.test`,
      qaTarget: `thread:/v1/${roomId}/$root:matrix.test`,
      stateConversation: {
        id: roomId,
        kind: "group",
      },
      threadId: "$root:matrix.test",
    });
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: matrixManifest,
        targetByProviderTarget: new Map(),
        event: {
          body: {
            body: "unmapped thread reply",
            msgtype: "m.text",
            "m.relates_to": {
              event_id: "$root:matrix.test",
              rel_type: "m.thread",
            },
          },
          method: "PUT",
          path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/thread-fallback`,
          type: "api",
        },
      }),
    ).toMatchObject({
      text: "unmapped thread reply",
      to: `${roomId}:thread:$root:matrix.test`,
    });

    expect(() =>
      createOpenClawCrablineInbound({
        manifest: matrixManifest,
        input: {
          conversation: { id: `${roomId}/archive`, kind: "group" },
          senderId: "@alice:matrix.test",
          text: "threaded Matrix message",
          threadId: "$root/child:matrix.test",
        },
      }),
    ).toThrow("Matrix targets must be native room IDs.");
    expect(parseQaTarget("thread:room/foo%2Fbar")).toEqual({
      id: "room",
      kind: "group",
      native: false,
      threadId: "foo%2Fbar",
    });
    expect(parseQaTarget("thread:room/foo%bar")).toEqual({
      id: "room",
      kind: "group",
      native: false,
      threadId: "foo%bar",
    });
    expect(parseQaTarget("thread:v1:room/42")).toEqual({
      id: "v1:room",
      kind: "group",
      native: false,
      threadId: "42",
    });

    const binding = createOpenClawCrablineProviderBinding(matrixManifest);
    expect(binding).toMatchObject({ channel: "matrix", requiredPluginIds: ["matrix"] });
    expect(binding.createGatewayConfig()).toMatchObject({
      channels: {
        matrix: {
          accessToken: "syt_crabline_matrix_token",
          dm: { allowFrom: ["*"], policy: "open" },
          encryption: false,
          homeserver: "http://127.0.0.1:8642",
          network: { dangerouslyAllowPrivateNetwork: true },
          streaming: { mode: "off", block: { enabled: false } },
          userId: "@openclaw:matrix.test",
        },
      },
    });
  });

  it("posts WhatsApp OpenClaw inbound with admin headers into the local provider", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "whatsapp" });
    try {
      if (adapter.manifest.provider !== "whatsapp") {
        throw new Error("Expected WhatsApp local provider manifest.");
      }
      await expect(probeOpenClawCrablineProvider(adapter.manifest)).resolves.toMatchObject({
        id: adapter.manifest.phoneNumberId,
        quality_rating: "GREEN",
      });

      const inbound = adapter.createInbound({
        input: {
          conversation: { id: "120363001234567890@g.us", kind: "group" },
          senderId: "15551234567@s.whatsapp.net",
          senderName: "Alice",
          text: "hello from qa",
        },
      });

      const rejected = await fetch(inbound.providerUrl, {
        body: JSON.stringify(inbound.providerBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(inbound.providerUrl, {
        body: JSON.stringify(inbound.providerBody),
        headers: inbound.providerHeaders,
        method: "POST",
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({ ok: true });
    } finally {
      await adapter.close();
    }
  });

  it("accepts exact provider API route evidence without claiming OpenClaw execution", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-provider-readiness-"));
    try {
      const legacyManifestPath = path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH);
      await fs.writeFile(legacyManifestPath, "permissive stale manifest\n", { mode: 0o666 });
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      const result = await runProviderReadinessWithDependencies(
        {
          outputDir,
          selection,
        },
        {
          startAdapter: async (params) =>
            ({
              close: async () => undefined,
              manifest: {
                ...manifest,
                recorderPath: params.recorderPath!,
              },
              probe: async () => {
                await fs.writeFile(params.recorderPath!, recorderProbeLine());
                return {
                  ...telegramProbeResult(),
                  result: {
                    first_name: "Crabline",
                    id: 424_242,
                    is_bot: true,
                    username: "crabline_bot",
                  },
                };
              },
            }) as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>,
        },
      );
      expect(result).toMatchObject({
        artifactPointerPath: OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
        capabilityReport: {
          result: {
            driver: "crabline",
            selectedChannel: "telegram",
          },
        },
        generation: expect.stringMatching(/^generation-/u),
        providerReadiness: {
          manifestPath: result.manifestPath,
          result: {
            ok: true,
            proof: "provider-api-probe",
            provider: "telegram",
            ready: true,
          },
        },
        smoke: {
          result: {
            ok: true,
            ready: true,
          },
        },
      });
      expect(result.manifestPath).toBe(
        path.join(
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          result.generation,
          OPENCLAW_CRABLINE_MANIFEST_PATH,
        ),
      );
      expect(result.capabilityMatrixPath).toBe(
        path.join(
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          result.generation,
          OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
        ),
      );
      expect(result.providerReadinessArtifactPath).toBe(
        path.join(
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          result.generation,
          OPENCLAW_CRABLINE_PROVIDER_READINESS_PATH,
        ),
      );
      const capabilityArtifact = JSON.parse(
        await fs.readFile(path.join(outputDir, result.capabilityMatrixPath), "utf8"),
      ) as Record<string, unknown>;
      expect(capabilityArtifact).toMatchObject({
        channelDriver: "crabline",
        manifestPath: result.manifestPath,
        selectedChannel: "telegram",
        source: "openclaw/crabline",
        version: 1,
        report: {
          result: {
            driver: "crabline",
            selectedChannel: "telegram",
            supportedChannels: [
              "mattermost",
              "matrix",
              "signal",
              "slack",
              "telegram",
              "whatsapp",
              "zalo",
            ],
          },
        },
      });
      const readinessArtifact = JSON.parse(
        await fs.readFile(path.join(outputDir, result.providerReadinessArtifactPath), "utf8"),
      ) as Record<string, unknown>;
      expect(readinessArtifact).toMatchObject({
        channelDriver: "crabline",
        manifestPath: result.manifestPath,
        selectedChannel: "telegram",
        source: "openclaw/crabline",
        version: 1,
        providerReadiness: {
          manifestPath: result.manifestPath,
          result: {
            ok: true,
            proof: "provider-api-probe",
            provider: "telegram",
            ready: true,
            recorderPath: path.join(
              OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
              result.generation,
              "telegram-fake-provider.jsonl",
            ),
            probe: {
              ok: true,
              result: {
                is_bot: true,
                username: "crabline_bot",
              },
            },
          },
        },
        smoke: {
          result: {
            ok: true,
            ready: true,
          },
        },
      });
      const writtenManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, result.manifestPath), "utf8"),
      ) as { provider?: string; recorderPath?: string };
      expect(writtenManifest.provider).toBe("telegram");
      expect(writtenManifest.recorderPath).toBe(
        path.join(
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          result.generation,
          "telegram-fake-provider.jsonl",
        ),
      );
      await expect(
        fs.readFile(path.join(outputDir, writtenManifest.recorderPath!), "utf8"),
      ).resolves.toBe(recorderProbeLine());
      expect(
        (await fs.readdir(path.join(outputDir, "artifacts", "crabline"))).filter((entry) =>
          entry.endsWith(".tmp"),
        ),
      ).toEqual([]);
      expect(await fs.readFile(legacyManifestPath, "utf8")).toBe("permissive stale manifest\n");
      const manifestMode = (await fs.stat(path.join(outputDir, result.manifestPath))).mode & 0o777;
      const expectedMode = process.platform === "win32" ? manifestMode : 0o600;
      expect(manifestMode).toBe(expectedMode);
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: result.generation,
        manifestPath: result.manifestPath,
      });
      expect(createOpenClawCrablineChannelReportNotes(selection)).toEqual([
        "Channel driver: crabline local provider for telegram.",
        "Channel artifact pointer: .crabline-smoke-artifacts/current.json.",
        "Generation capability filename: crabline-fake-provider-capabilities.json.",
        "Generation provider-readiness filename: crabline-fake-provider-smoke.json.",
        "Crabline verifies the local provider API is ready; OpenClaw channel behavior is proven separately by QA scenarios that run the real channel adapter.",
      ]);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each(["committed", "failed"] as const)(
    "syncs the recorder directory after the final %s temporary unlink",
    async (outcome) => {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-unlink-"));
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      const probeFailure = new Error("probe failed");
      let recorderPath: string | undefined;
      const syncParent = vi.fn(async (unlinkedPath: string) => {
        expect(unlinkedPath).toBe(recorderPath);
        await expect(fs.stat(unlinkedPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
      try {
        const readiness = runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            startAdapter: async (params) => {
              recorderPath = params.recorderPath;
              await fs.writeFile(recorderPath!, recorderProbeLine());
              return {
                close: async () => undefined,
                manifest: { ...manifest, recorderPath: recorderPath! },
                probe: async () => {
                  if (outcome === "failed") {
                    throw probeFailure;
                  }
                  return telegramProbeResult();
                },
              } as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
            },
            syncParent,
          },
        );

        const settled = await readiness.then(
          () => ({ outcome: "committed" as const }),
          (error: unknown) => ({ error, outcome: "failed" as const }),
        );
        expect(settled).toEqual(
          outcome === "failed" ? { error: probeFailure, outcome } : { outcome },
        );
        expect(syncParent).toHaveBeenCalledTimes(1);
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("defers readiness cleanup while an aborted provider probe remains unsettled", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-probe-drain-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const controller = new AbortController();
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cleanupFailure = new Error("deferred adapter close failed");
    const close = vi.fn(async () => {
      throw cleanupFailure;
    });
    let reportAbort: (() => void) | undefined;
    let reportProbeStart: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => {
      reportAbort = resolve;
    });
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStart = resolve;
    });

    try {
      const readiness = runProviderReadinessWithDependencies(
        { outputDir, selection },
        {
          startAdapter: async (params) =>
            ({
              close,
              manifest: { ...manifest, recorderPath: params.recorderPath! },
              probe: async () =>
                await runOpenClawCrablineProviderProbe("telegram", async (signal) => {
                  reportProbeStart?.();
                  return await new Promise<never>(() => {
                    signal.addEventListener("abort", () => reportAbort?.(), { once: true });
                  });
                }),
            }) as unknown as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>,
        },
      );
      const outcome = readiness.then(
        (result) => ({ kind: "resolved" as const, result }),
        (error: unknown) => ({ error, kind: "rejected" as const }),
      );

      await probeStarted;
      expect(timeoutMock).toHaveBeenCalledWith(5_000);
      controller.abort(new DOMException("probe deadline", "TimeoutError"));
      await abortObserved;

      const result = await outcome;
      expect(close).not.toHaveBeenCalled();
      expect(result.kind).toBe("rejected");
      expect(result).toMatchObject({
        error: expect.objectContaining({
          message: "Crabline Telegram getMe probe timed out after 5000 ms.",
        }),
      });

      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(result).toMatchObject({
          error: expect.objectContaining({
            cause: expect.objectContaining({
              errors: expect.arrayContaining([cleanupFailure]),
            }),
          }),
        }),
      );
    } finally {
      timeoutMock.mockRestore();
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  }, 5_000);

  it("fails closed when a successful probe produces no recorder evidence", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-missing-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const close = vi.fn(async () => undefined);
    const publishGeneration = vi.fn<typeof publishOpenClawCrablineArtifactGeneration>();
    const releaseLock = vi.fn(async (lock: { release(): Promise<void> }) => await lock.release());
    let recorderPath: string | undefined;
    const syncParent = vi.fn(async (unlinkedPath: string) => {
      expect(unlinkedPath).toBe(recorderPath);
      await expect(fs.stat(unlinkedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    try {
      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            publishGeneration,
            releaseLock,
            startAdapter: async (params) => {
              recorderPath = params.recorderPath;
              return {
                close: async () => await close(),
                manifest: { ...manifest, recorderPath: recorderPath! },
                probe: async () => telegramProbeResult(),
              } as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
            },
            syncParent,
          },
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      expect(close).toHaveBeenCalledTimes(1);
      expect(publishGeneration).not.toHaveBeenCalled();
      expect(syncParent).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toBeNull();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t\r\n"],
    ["malformed", "not-json\n"],
    ["non-record JSON", "null\n42\n[]\n"],
    ["unrelated object", "{}\n"],
    ["rejected event", recorderProbeLine({ accepted: false })],
    ["non-boolean acceptance", recorderProbeLine({ accepted: "true" })],
    ["admin-only event", recorderProbeLine({ type: "admin" })],
    ["wrong API route", recorderProbeLine({ path: "/bot<redacted>/sendMessage" })],
    ["valid event followed by malformed JSON", `${recorderProbeLine()}not-json\n`],
  ])("fails closed on %s readiness recorder evidence", async (_label, recorderContents) => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-invalid-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const close = vi.fn(async () => undefined);
    const publishGeneration = vi.fn<typeof publishOpenClawCrablineArtifactGeneration>();
    const releaseLock = vi.fn(async (lock: { release(): Promise<void> }) => await lock.release());
    const syncParent = vi.fn(async (unlinkedPath: string) => {
      await expect(fs.stat(unlinkedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    try {
      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            publishGeneration,
            releaseLock,
            startAdapter: async (params) => {
              await fs.writeFile(params.recorderPath!, recorderContents);
              return {
                close,
                manifest: { ...manifest, recorderPath: params.recorderPath! },
                probe: async () => telegramProbeResult(),
              } as unknown as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
            },
            syncParent,
          },
        ),
      ).rejects.toThrow(
        "OpenClaw Crabline provider probe produced no valid JSONL recorder evidence.",
      );

      expect(close).toHaveBeenCalledTimes(1);
      expect(publishGeneration).not.toHaveBeenCalled();
      expect(syncParent).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toBeNull();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps readiness recorder snapshots immutable across later generations", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-snapshots-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    let run = 0;
    const startAdapter = async (params: Parameters<typeof startOpenClawCrablineAdapter>[0]) => {
      const currentRun = ++run;
      await fs.writeFile(params.recorderPath!, recorderProbeLine({ run: currentRun }));
      return {
        close: async () => undefined,
        manifest: {
          ...manifest,
          recorderPath: params.recorderPath!,
        },
        probe: async () => telegramProbeResult({ currentRun }),
      } as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
    };
    try {
      const first = await runProviderReadinessWithDependencies(
        { outputDir, selection },
        { startAdapter },
      );
      const firstRecorderPath = (first.providerReadiness as { result: { recorderPath: string } })
        .result.recorderPath;
      await expect(fs.readFile(path.join(outputDir, firstRecorderPath), "utf8")).resolves.toBe(
        recorderProbeLine({ run: 1 }),
      );

      const second = await runProviderReadinessWithDependencies(
        { outputDir, selection },
        { startAdapter },
      );
      const secondRecorderPath = (second.providerReadiness as { result: { recorderPath: string } })
        .result.recorderPath;

      expect(secondRecorderPath).not.toBe(firstRecorderPath);
      await expect(fs.readFile(path.join(outputDir, firstRecorderPath), "utf8")).resolves.toBe(
        recorderProbeLine({ run: 1 }),
      );
      await expect(fs.readFile(path.join(outputDir, secondRecorderPath), "utf8")).resolves.toBe(
        recorderProbeLine({ run: 2 }),
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each(["artifacts", "recorder"] as const)(
    "rejects a symlinked %s directory without touching external recorder files",
    async (component) => {
      if (process.platform === "win32") {
        return;
      }
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-symlink-"));
      const externalDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "crabline-recorder-external-"),
      );
      const staleName = ".telegram-fake-provider.11111111-1111-4111-8111-111111111111.jsonl.tmp";
      const sentinelPath = path.join(externalDirectory, staleName);
      const startAdapter = vi.fn<typeof startOpenClawCrablineAdapter>();
      try {
        await fs.writeFile(sentinelPath, "preserve\n");
        if (component === "artifacts") {
          await fs.symlink(externalDirectory, path.join(outputDir, "artifacts"), "dir");
        } else {
          const artifactsDirectory = path.join(outputDir, "artifacts");
          await fs.mkdir(artifactsDirectory);
          await fs.symlink(externalDirectory, path.join(artifactsDirectory, "crabline"), "dir");
        }

        await expect(
          runProviderReadinessWithDependencies(
            {
              outputDir,
              selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" }),
            },
            { startAdapter },
          ),
        ).rejects.toThrow("Private directory path identity changed during publication.");

        expect(startAdapter).not.toHaveBeenCalled();
        await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("preserve\n");
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
        await fs.rm(externalDirectory, { recursive: true, force: true });
      }
    },
  );

  it("reclaims only exact stale readiness recorder temporaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-recovery-"));
    const recorderDirectory = path.join(outputDir, "artifacts", "crabline");
    const staleTelegram = ".telegram-fake-provider.11111111-1111-4111-8111-111111111111.jsonl.tmp";
    const staleSlack = ".slack-fake-provider.22222222-2222-4222-8222-222222222222.jsonl.tmp";
    const staleTelegramLock = `${staleTelegram}.lock`;
    const lookalike = ".telegram-fake-provider.not-a-uuid.jsonl.tmp";
    const lookalikeLock = `${staleTelegram}.lock.extra`;
    const unrelatedLock = "unrelated.lock";
    const lookalikeTombstone = `.${staleTelegramLock}.1234.not-a-uuid.remove`;
    const matchingDirectory =
      ".telegram-fake-provider.33333333-3333-4333-8333-333333333333.jsonl.tmp";
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    try {
      await fs.mkdir(path.join(recorderDirectory, matchingDirectory), { recursive: true });
      await fs.mkdir(path.join(recorderDirectory, staleTelegramLock), { recursive: true });
      await fs.mkdir(path.join(recorderDirectory, lookalikeLock), { recursive: true });
      await fs.mkdir(path.join(recorderDirectory, unrelatedLock), { recursive: true });
      await fs.mkdir(path.join(recorderDirectory, lookalikeTombstone), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(recorderDirectory, staleTelegram), "stale telegram\n"),
        fs.writeFile(path.join(recorderDirectory, staleSlack), "stale slack\n"),
        fs.writeFile(path.join(recorderDirectory, lookalike), "preserve\n"),
      ]);

      await runProviderReadinessWithDependencies(
        { outputDir, selection },
        {
          startAdapter: async (params) => {
            await fs.writeFile(params.recorderPath!, recorderProbeLine());
            return {
              close: async () => undefined,
              manifest: { ...manifest, recorderPath: params.recorderPath! },
              probe: async () => telegramProbeResult(),
            } as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
          },
        },
      );

      await expect(fs.stat(path.join(recorderDirectory, staleTelegram))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(recorderDirectory, staleSlack))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(recorderDirectory, staleTelegramLock))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(recorderDirectory, lookalike), "utf8")).resolves.toBe(
        "preserve\n",
      );
      await expect(fs.stat(path.join(recorderDirectory, lookalikeLock))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
      await expect(fs.stat(path.join(recorderDirectory, unrelatedLock))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
      await expect(
        fs.stat(path.join(recorderDirectory, lookalikeTombstone)),
      ).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
      await expect(fs.stat(path.join(recorderDirectory, matchingDirectory))).resolves.toMatchObject(
        {
          isDirectory: expect.any(Function),
        },
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reclaims recorder lock tombstones after interrupted removal", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-lock-retry-"));
    const recorderDirectory = path.join(outputDir, "artifacts", "crabline");
    const lockName = ".telegram-fake-provider.55555555-5555-4555-8555-555555555555.jsonl.tmp.lock";
    const removalFailure = new Error("simulated recorder lock tombstone removal interruption");
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    let rmSpy: ReturnType<typeof vi.spyOn> | undefined;
    const startAdapter = async (params: Parameters<typeof startOpenClawCrablineAdapter>[0]) => {
      await fs.writeFile(params.recorderPath!, recorderProbeLine());
      return {
        close: async () => undefined,
        manifest: { ...manifest, recorderPath: params.recorderPath! },
        probe: async () => telegramProbeResult(),
      } as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
    };
    try {
      await fs.mkdir(path.join(recorderDirectory, lockName), { recursive: true });
      const originalRm = fs.rm.bind(fs);
      let interruptRemoval = true;
      rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (candidatePath, options) => {
        if (
          interruptRemoval &&
          path.basename(String(candidatePath)).includes(".jsonl.tmp.lock.") &&
          String(candidatePath).endsWith(".remove")
        ) {
          interruptRemoval = false;
          throw removalFailure;
        }
        await originalRm(candidatePath, options);
      });

      await expect(
        runProviderReadinessWithDependencies({ outputDir, selection }, { startAdapter }),
      ).rejects.toBe(removalFailure);
      rmSpy.mockRestore();
      rmSpy = undefined;

      const retainedTombstones = (await fs.readdir(recorderDirectory)).filter((entry) =>
        entry.endsWith(".remove"),
      );
      expect(retainedTombstones).toHaveLength(1);
      expect(retainedTombstones[0]).toMatch(
        /^\.\.telegram-fake-provider\.55555555-5555-4555-8555-555555555555\.jsonl\.tmp\.lock\.\d+\.[0-9a-f-]{36}\.remove$/u,
      );

      await runProviderReadinessWithDependencies({ outputDir, selection }, { startAdapter });

      expect((await fs.readdir(recorderDirectory)).some((entry) => entry.endsWith(".remove"))).toBe(
        false,
      );
    } finally {
      rmSpy?.mockRestore();
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves exact recorder temporary lock symlinks without following them",
    async () => {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-recorder-lock-symlink-"));
      const recorderDirectory = path.join(outputDir, "artifacts", "crabline");
      const targetDirectory = path.join(outputDir, "external-lock-target");
      const lockName =
        ".telegram-fake-provider.44444444-4444-4444-8444-444444444444.jsonl.tmp.lock";
      const lockPath = path.join(recorderDirectory, lockName);
      const tombstoneName = `.${lockName}.1234.66666666-6666-4666-8666-666666666666.remove`;
      const tombstonePath = path.join(recorderDirectory, tombstoneName);
      const markerPath = path.join(targetDirectory, "preserve.txt");
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      try {
        await fs.mkdir(recorderDirectory, { recursive: true });
        await fs.mkdir(targetDirectory);
        await fs.writeFile(markerPath, "preserve\n");
        await fs.symlink(targetDirectory, lockPath);
        await fs.symlink(targetDirectory, tombstonePath);

        await runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            startAdapter: async (params) => {
              await fs.writeFile(params.recorderPath!, recorderProbeLine());
              return {
                close: async () => undefined,
                manifest: { ...manifest, recorderPath: params.recorderPath! },
                probe: async () => telegramProbeResult(),
              } as Awaited<ReturnType<typeof startOpenClawCrablineAdapter>>;
            },
          },
        );

        expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(tombstonePath)).isSymbolicLink()).toBe(true);
        await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("preserve\n");
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("owns complete artifact publication and releases only after the generation is installed", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-artifacts-"));
    const telegram = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const slack = resolveOpenClawCrablineChannelDriverSelection({ channel: "slack" });
    let resumePublication: (() => void) | undefined;
    const publicationPaused = new Promise<void>((resolve) => {
      resumePublication = resolve;
    });
    let notifyPublicationStarted: (() => void) | undefined;
    const publicationStarted = new Promise<void>((resolve) => {
      notifyPublicationStarted = resolve;
    });
    try {
      const first = runProviderReadinessWithDependencies(
        { outputDir, selection: telegram },
        {
          publishGeneration: async (params) =>
            await publishOpenClawCrablineArtifactGeneration(params, {
              beforePointerSwitch: async () => {
                notifyPublicationStarted?.();
                await publicationPaused;
              },
            }),
        },
      );
      await publicationStarted;
      await expect(
        runOpenClawCrablineProviderReadiness({ outputDir, selection: slack }),
      ).rejects.toThrow('OpenClaw Crabline smoke is already running for channel "telegram"');
      resumePublication?.();
      await first;

      const second = await runOpenClawCrablineProviderReadiness({
        outputDir,
        selection: slack,
      });

      const writtenManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, second.manifestPath), "utf8"),
      ) as { provider?: string };
      const capability = JSON.parse(
        await fs.readFile(path.join(outputDir, second.capabilityMatrixPath), "utf8"),
      ) as { selectedChannel?: string; report?: { result?: { selectedChannel?: string } } };
      const readiness = JSON.parse(
        await fs.readFile(path.join(outputDir, second.providerReadinessArtifactPath), "utf8"),
      ) as {
        selectedChannel?: string;
        providerReadiness?: { result?: { provider?: string } };
      };
      expect({
        capability: capability.report?.result?.selectedChannel,
        manifest: writtenManifest.provider,
        providerReadiness: readiness.providerReadiness?.result?.provider,
      }).toEqual({
        capability: "slack",
        manifest: "slack",
        providerReadiness: "slack",
      });
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("returns the committed generation when post-commit lock cleanup fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-release-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const cleanupFailure = new Error("lock release retries exhausted");
    let pointerAtCleanup: Awaited<ReturnType<typeof readOpenClawCrablineArtifactPointer>> = null;
    const releaseLock = vi.fn<() => Promise<void>>(async () => {
      pointerAtCleanup = await readOpenClawCrablineArtifactPointer(outputDir);
      throw cleanupFailure;
    });
    try {
      const result = await runProviderReadinessWithDependencies(
        { outputDir, selection },
        {
          releaseLock,
        },
      );

      expect(releaseLock).toHaveBeenCalledTimes(1);
      expect(pointerAtCleanup).toMatchObject({
        capabilityMatrixPath: result.capabilityMatrixPath,
        generation: result.generation,
        manifestPath: result.manifestPath,
        providerReadinessArtifactPath: result.providerReadinessArtifactPath,
      });
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toEqual(
        pointerAtCleanup,
      );
      await expect(readPublishedArtifactGeneration(outputDir, result)).resolves.toHaveLength(3);
      expect(result.providerReadiness).toMatchObject({
        manifestPath: result.manifestPath,
        result: {
          proof: "provider-api-probe",
          provider: "telegram",
          ready: true,
        },
      });
      expect(result.warnings).toEqual([
        "OpenClaw Crabline smoke committed but lock cleanup failed: lock release retries exhausted",
      ]);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves the primary smoke failure when lock cleanup also fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-errors-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const primaryFailure = new Error("probe failed");
    const cleanupFailure = new Error("lock release retries exhausted");
    try {
      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            releaseLock: async () => {
              throw cleanupFailure;
            },
            startAdapter: async (params) => {
              const adapter = await startOpenClawCrablineAdapter(params);
              return {
                ...adapter,
                probe: async () => {
                  throw primaryFailure;
                },
              };
            },
          },
        ),
      ).rejects.toBe(primaryFailure);
      expect(primaryFailure.cause).toBe(cleanupFailure);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves a frozen smoke failure when lock cleanup also fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-frozen-smoke-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const primaryFailure = Object.freeze(new Error("frozen smoke failure"));
    try {
      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            releaseLock: async () => {
              throw new Error("lock release retries exhausted");
            },
            startAdapter: async (params) => {
              const adapter = await startOpenClawCrablineAdapter(params);
              return {
                ...adapter,
                probe: async () => {
                  throw primaryFailure;
                },
              };
            },
          },
        ),
      ).rejects.toBe(primaryFailure);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves the primary provider probe failure when adapter cleanup also fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-probe-errors-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const primaryFailure = new Error("probe failed");
    const cleanupFailure = new Error("adapter close failed");
    try {
      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            startAdapter: async (params) => {
              const adapter = await startOpenClawCrablineAdapter(params);
              return {
                ...adapter,
                close: async () => {
                  await adapter.close();
                  throw cleanupFailure;
                },
                probe: async () => {
                  throw primaryFailure;
                },
              };
            },
          },
        ),
      ).rejects.toBe(primaryFailure);
      expect(primaryFailure.cause).toBe(cleanupFailure);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves a frozen provider probe failure when adapter cleanup also fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-frozen-error-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const primaryFailure = Object.freeze(new Error("frozen probe failure"));
    try {
      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            startAdapter: async (params) => {
              const adapter = await startOpenClawCrablineAdapter(params);
              return {
                ...adapter,
                close: async () => {
                  await adapter.close();
                  throw new Error("adapter close failed");
                },
                probe: async () => {
                  throw primaryFailure;
                },
              };
            },
          },
        ),
      ).rejects.toBe(primaryFailure);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each(["setup", "probe", "cleanup"] as const)(
    "preserves the complete prior artifact generation on %s failure",
    async (failureStage) => {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-failure-"));
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      try {
        const prior = await runOpenClawCrablineProviderReadiness({ outputDir, selection });
        const priorGeneration = await readPublishedArtifactGeneration(outputDir, prior);
        const priorPointer = await readOpenClawCrablineArtifactPointer(outputDir);
        const failure = new Error(`${failureStage} failed`);

        await expect(
          runProviderReadinessWithDependencies(
            { outputDir, selection },
            {
              startAdapter: async (params) => {
                if (failureStage === "setup") {
                  throw failure;
                }
                const adapter = await startOpenClawCrablineAdapter(params);
                if (failureStage === "probe") {
                  return {
                    ...adapter,
                    probe: async () => {
                      throw failure;
                    },
                  };
                }
                return {
                  ...adapter,
                  close: async () => {
                    await adapter.close();
                    throw failure;
                  },
                };
              },
            },
          ),
        ).rejects.toBe(failure);
        await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toEqual(priorPointer);
        await expect(readPublishedArtifactGeneration(outputDir, prior)).resolves.toEqual(
          priorGeneration,
        );
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("rolls back the complete artifact generation when publication fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-rollback-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    try {
      const prior = await runOpenClawCrablineProviderReadiness({ outputDir, selection });
      const priorGeneration = await readPublishedArtifactGeneration(outputDir, prior);
      const priorPointer = await readOpenClawCrablineArtifactPointer(outputDir);
      const failure = new Error("pointer publication failed");

      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            publishGeneration: async (params) =>
              await publishOpenClawCrablineArtifactGeneration(params, {
                beforePointerSwitch: async () => {
                  throw failure;
                },
              }),
          },
        ),
      ).rejects.toBe(failure);
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toEqual(priorPointer);
      await expect(readPublishedArtifactGeneration(outputDir, prior)).resolves.toEqual(
        priorGeneration,
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rolls back publication when heartbeat ownership cannot be sealed", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-heartbeat-"));
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const failure = new Error("heartbeat renewal failed");
    const release = vi.fn<() => Promise<void>>(async () => undefined);
    try {
      const prior = await runOpenClawCrablineProviderReadiness({ outputDir, selection });
      const priorGeneration = await readPublishedArtifactGeneration(outputDir, prior);
      const priorPointer = await readOpenClawCrablineArtifactPointer(outputDir);

      await expect(
        runProviderReadinessWithDependencies(
          { outputDir, selection },
          {
            acquireLock: async () => ({
              async assertOwned() {},
              async commitFileAtomically() {
                throw failure;
              },
              release,
            }),
          },
        ),
      ).rejects.toBe(failure);
      expect(release).toHaveBeenCalledTimes(1);
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toEqual(priorPointer);
      await expect(readPublishedArtifactGeneration(outputDir, prior)).resolves.toEqual(
        priorGeneration,
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects cross-process smoke runs that share an output artifact set", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-overlap-"));
    const holder = startSmokeLockHolder(outputDir, "telegram");
    try {
      await waitForSmokeLock(holder);
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      const otherSelection = resolveOpenClawCrablineChannelDriverSelection({ channel: "slack" });

      await expect(runOpenClawCrablineProviderReadiness({ outputDir, selection })).rejects.toThrow(
        `OpenClaw Crabline smoke is already running for channel "telegram" in "${outputDir}"; cannot start channel "telegram".`,
      );
      await expect(
        runOpenClawCrablineProviderReadiness({ outputDir, selection: otherSelection }),
      ).rejects.toThrow(
        `OpenClaw Crabline smoke is already running for channel "telegram" in "${outputDir}"; cannot start channel "slack".`,
      );

      const holderExit = once(holder, "exit");
      holder.stdin.end("release\n");
      const [exitCode, signal] = await holderExit;
      expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });

      const result = await runOpenClawCrablineProviderReadiness({ outputDir, selection });
      const readiness = JSON.parse(
        await fs.readFile(path.join(outputDir, result.providerReadinessArtifactPath), "utf8"),
      ) as { providerReadiness?: { result?: { provider?: string } } };
      expect(readiness.providerReadiness?.result?.provider).toBe("telegram");
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGTERM");
        await once(holder, "exit").catch(() => undefined);
      }
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("recovers a smoke lock abandoned by a terminated process", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-stale-lock-"));
    const holder = startSmokeLockHolder(outputDir, "telegram");
    try {
      await waitForSmokeLock(holder);
      const holderExit = once(holder, "exit");
      holder.kill("SIGKILL");
      await holderExit;

      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      const result = await runOpenClawCrablineProviderReadiness({ outputDir, selection });
      const readiness = JSON.parse(
        await fs.readFile(path.join(outputDir, result.providerReadinessArtifactPath), "utf8"),
      ) as { providerReadiness?: { result?: { provider?: string } } };
      expect(readiness.providerReadiness?.result?.provider).toBe("telegram");
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGTERM");
        await once(holder, "exit").catch(() => undefined);
      }
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
