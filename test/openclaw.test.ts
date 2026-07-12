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
  createOpenClawCrablineOutboundFromRecorderEvent,
  isCrablineFakeProviderChannel,
  isCrablineServerChannel,
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  probeOpenClawCrablineFakeProvider,
  probeOpenClawCrablineProvider,
  resolveOpenClawCrablineChannelDriverSelection,
  runOpenClawCrablineChannelDriverSmoke,
  startCrablineFakeProviderServer,
  startCrablineServer,
  startOpenClawCrablineAdapter,
  type CrablineFakeProviderManifest,
  type CrablineServerManifest,
  type OpenClawCrablineConversation,
} from "../src/index.js";
import {
  publishOpenClawCrablineArtifactGeneration,
  readOpenClawCrablineArtifactPointer,
} from "../src/openclaw/artifact-generation.js";

type SmokeRunTestDependencies = {
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
  startAdapter?: typeof startOpenClawCrablineAdapter;
};

const runSmokeWithDependencies = runOpenClawCrablineChannelDriverSmoke as unknown as (
  params: Parameters<typeof runOpenClawCrablineChannelDriverSmoke>[0],
  dependencies: SmokeRunTestDependencies,
) => ReturnType<typeof runOpenClawCrablineChannelDriverSmoke>;

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
    smokeArtifactPath: string;
  },
): Promise<string[]> {
  return await Promise.all(
    [paths.manifestPath, paths.capabilityMatrixPath, paths.smokeArtifactPath].map((filePath) =>
      fs.readFile(path.join(outputDir, filePath), "utf8"),
    ),
  );
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
    expect(resolveOpenClawCrablineChannelDriverSelection({})).toEqual({
      capabilityMatrixPath: OPENCLAW_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
      channel: "telegram",
      channelDriver: "crabline",
      smokeArtifactPath: OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
    });
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
    expect(BigInt(symbolicDelivery.to)).toBeLessThan(1n << 52n);
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
    expect(symbolicGroupDelivery.to).toMatch(/^-100\d+$/u);
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
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "group:-100123" }).to).toBe(
      "-100123",
    );
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "-100123" }).to).toBe("-100123");
    expect(createOpenClawCrablineAgentDelivery({ manifest, target: "thread:-100123/42" }).to).toBe(
      "-100123:topic:42",
    );

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
          conversation: { id: "alice", kind: "group" },
          senderId: "alice",
          text: "topic message",
          threadId: "42",
        },
      }).providerBody,
    ).toMatchObject({
      chatId: expect.stringMatching(/^-100\d+$/u),
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
      qaTarget: "thread:alice/42",
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
          path: "/botTOKEN/sendMessage",
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
        targetByProviderTarget: new Map([["100001", "dm:alice"]]),
        event: {
          type: "api",
          path: "/botTOKEN/sendPhoto",
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
          path: "/botTOKEN/sendAudio",
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

  it("validates explicit Telegram thread target ids", () => {
    const symbolicGroup = createOpenClawCrablineAgentDelivery({
      manifest,
      target: "group:alice",
    }).to;

    for (const threadId of ["0", "42", String(Number.MAX_SAFE_INTEGER)]) {
      expect(
        createOpenClawCrablineAgentDelivery({
          manifest,
          target: `thread:alice/${threadId}`,
        }).to,
      ).toBe(`${symbolicGroup}:topic:${threadId}`);
    }

    for (const threadId of [
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
      ).toThrow("Telegram thread target must be a safe non-negative integer.");
    }

    for (const threadId of ["-1", "not-a-number", String(Number.MAX_SAFE_INTEGER + 1)]) {
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
      ).toThrow("Telegram thread target must be a safe non-negative integer.");
    }
  });

  it("maps WhatsApp QA targets, inbound messages, and recorder events", () => {
    expect(
      createOpenClawCrablineAgentDelivery({
        manifest: whatsappManifest,
        target: "dm:15551234567@s.whatsapp.net",
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

    const inbound = createOpenClawCrablineInbound({
      manifest: whatsappManifest,
      input: {
        conversation: { id: "120363001234567890@g.us", kind: "group" },
        senderId: "15551234567@s.whatsapp.net",
        senderName: "Alice",
        text: "hello",
      },
    });
    expect(inbound).toEqual({
      providerBody: {
        chatJid: "120363001234567890@g.us",
        senderJid: "15551234567@s.whatsapp.net",
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
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: whatsappManifest,
        targetByProviderTarget: new Map([["15551234567@s.whatsapp.net", "dm:alice"]]),
        event: {
          type: "api",
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
      qaTarget: "thread:C1234567890/1700000000.000100",
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
    expect(directDelivery.to).toMatch(/^\+1555\d{7}$/u);

    const directInbound = createOpenClawCrablineInbound({
      manifest: signalManifest,
      input: {
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-operator",
        text: "hello",
      },
    });
    expect(directInbound.providerBody).toMatchObject({ sourceNumber: directDelivery.to });
    expect(directInbound.providerTargetKey).toBe(directDelivery.to);

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: signalManifest,
        targetByProviderTarget: new Map([[directInbound.providerTargetKey, "dm:qa-operator"]]),
        event: {
          body: {
            method: "send",
            params: { message: "direct reply", recipient: [directDelivery.to] },
          },
          path: "/api/v1/rpc",
          type: "api",
        },
      }),
    ).toMatchObject({ text: "direct reply", to: "dm:qa-operator" });

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
          path: "/botTOKEN/sendPhoto",
          type: "api",
        }),
      },
      {
        name: "WhatsApp",
        manifest: whatsappManifest,
        event: (text) => ({
          body: { text: { body: text }, to: "15551234567@s.whatsapp.net" },
          path: new URL(whatsappManifest.endpoints.messagesUrl).pathname,
          type: "api",
        }),
      },
      {
        name: "Slack",
        manifest: slackManifest,
        event: (text) => ({
          body: { channel: "C1234567890", text },
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
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          event: testCase.event(text),
          manifest: testCase.manifest,
          targetByProviderTarget: new Map(),
        }),
      ).toMatchObject({ text });
      expect(
        createOpenClawCrablineOutboundFromRecorderEvent({
          event: testCase.event(" \n\t"),
          manifest: testCase.manifest,
          targetByProviderTarget: new Map(),
        }),
      ).toBeNull();
    }
  });

  it("maps Mattermost QA targets, inbound messages, and recorder events", () => {
    const delivery = createOpenClawCrablineAgentDelivery({
      manifest: mattermostManifest,
      target: "dm:alice",
    });
    expect(delivery).toMatchObject({
      channel: "mattermost",
      replyChannel: "mattermost",
    });
    expect(delivery.to).toMatch(/^user:[a-z0-9]{26}$/u);

    expect(() =>
      createOpenClawCrablineAgentDelivery({
        manifest: mattermostManifest,
        target: "thread:general/parent",
      }),
    ).toThrow("Mattermost thread targets require OpenClaw QA thread forwarding.");

    const inbound = createOpenClawCrablineInbound({
      manifest: mattermostManifest,
      input: {
        conversation: { id: " alice ", kind: "direct" },
        senderId: "alice",
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
      qaTarget: "dm:alice",
      stateConversation: {
        id: "alice",
        kind: "direct",
      },
    });
    expect(inbound.providerBody.senderId).toBe(delivery.to.slice("user:".length));
    for (const conversationId of ["", " \n\t"]) {
      expect(() =>
        createOpenClawCrablineInbound({
          manifest: mattermostManifest,
          input: {
            conversation: { id: conversationId, kind: "direct" },
            senderId: "alice",
            text: "hello",
          },
        }),
      ).toThrow("Mattermost conversation id is required.");
    }

    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: mattermostManifest,
        targetByProviderTarget: new Map([[inbound.providerTargetKey, "dm:alice"]]),
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
      to: "dm:alice",
    });

    const binding = createOpenClawCrablineProviderBinding(mattermostManifest);
    expect(binding).toMatchObject({
      channel: "mattermost",
      requiredPluginIds: ["mattermost"],
    });
    expect(binding.createGatewayConfig()).toMatchObject({
      channels: { mattermost: { chatmode: "onmessage", streaming: "off" } },
    });

    const threadInbound = createOpenClawCrablineInbound({
      manifest: mattermostManifest,
      input: {
        conversation: { id: "general", kind: "group" },
        senderId: "alice",
        text: "thread reply",
        threadId: "parent",
      },
    });
    expect(threadInbound.providerTargetKey).toMatch(/:thread:[a-z0-9]{26}$/u);
    expect(threadInbound.threadId).toBe(threadInbound.providerBody.rootId);
    expect(
      createOpenClawCrablineOutboundFromRecorderEvent({
        manifest: mattermostManifest,
        targetByProviderTarget: new Map([
          [threadInbound.providerTargetKey, "thread:general/parent"],
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
    ).toMatchObject({ to: "thread:general/parent" });
  });

  it("maps Matrix native rooms, inbound messages, and recorder events", () => {
    const roomId = "!qa:matrix.test";
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
    expect(() =>
      createOpenClawCrablineAgentDelivery({ manifest: matrixManifest, target: "channel:general" }),
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
      qaTarget: `thread:${roomId}/$root:matrix.test`,
      stateConversation: {
        id: roomId,
        kind: "group",
      },
      threadId: "$root:matrix.test",
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

  it("runs OpenClaw channel-driver smoke and writes provider artifacts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabline-openclaw-smoke-"));
    try {
      const legacyManifestPath = path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH);
      await fs.writeFile(legacyManifestPath, "permissive stale manifest\n", { mode: 0o666 });
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
      const result = await runOpenClawCrablineChannelDriverSmoke({
        outputDir,
        selection,
      });
      expect(result).toMatchObject({
        artifactPointerPath: OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
        capabilityReport: {
          result: {
            driver: "crabline",
            selectedChannel: "telegram",
          },
        },
        generation: expect.stringMatching(/^generation-/u),
        smoke: {
          manifestPath: result.manifestPath,
          result: {
            ok: true,
            provider: "telegram",
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
      expect(result.smokeArtifactPath).toBe(
        path.join(
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          result.generation,
          OPENCLAW_CRABLINE_CHANNEL_SMOKE_PATH,
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
      const smokeArtifact = JSON.parse(
        await fs.readFile(path.join(outputDir, result.smokeArtifactPath), "utf8"),
      ) as Record<string, unknown>;
      expect(smokeArtifact).toMatchObject({
        channelDriver: "crabline",
        manifestPath: result.manifestPath,
        selectedChannel: "telegram",
        source: "openclaw/crabline",
        version: 1,
        smoke: {
          manifestPath: result.manifestPath,
          result: {
            ok: true,
            provider: "telegram",
            recorderPath: "artifacts/crabline/telegram-fake-provider.jsonl",
            probe: {
              ok: true,
              result: {
                is_bot: true,
                username: "crabline_bot",
              },
            },
          },
        },
      });
      const writtenManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, result.manifestPath), "utf8"),
      ) as { provider?: string };
      expect(writtenManifest.provider).toBe("telegram");
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
        "Generation smoke filename: crabline-fake-provider-smoke.json.",
        "Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.",
      ]);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

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
      const first = runSmokeWithDependencies(
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
        runOpenClawCrablineChannelDriverSmoke({ outputDir, selection: slack }),
      ).rejects.toThrow('OpenClaw Crabline smoke is already running for channel "telegram"');
      resumePublication?.();
      await first;

      const second = await runOpenClawCrablineChannelDriverSmoke({
        outputDir,
        selection: slack,
      });

      const writtenManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, second.manifestPath), "utf8"),
      ) as { provider?: string };
      const capability = JSON.parse(
        await fs.readFile(path.join(outputDir, second.capabilityMatrixPath), "utf8"),
      ) as { selectedChannel?: string; report?: { result?: { selectedChannel?: string } } };
      const smoke = JSON.parse(
        await fs.readFile(path.join(outputDir, second.smokeArtifactPath), "utf8"),
      ) as { selectedChannel?: string; smoke?: { result?: { provider?: string } } };
      expect({
        capability: capability.report?.result?.selectedChannel,
        manifest: writtenManifest.provider,
        smoke: smoke.smoke?.result?.provider,
      }).toEqual({
        capability: "slack",
        manifest: "slack",
        smoke: "slack",
      });
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
        const prior = await runOpenClawCrablineChannelDriverSmoke({ outputDir, selection });
        const priorGeneration = await readPublishedArtifactGeneration(outputDir, prior);
        const priorPointer = await readOpenClawCrablineArtifactPointer(outputDir);
        const failure = new Error(`${failureStage} failed`);

        await expect(
          runSmokeWithDependencies(
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
      const prior = await runOpenClawCrablineChannelDriverSmoke({ outputDir, selection });
      const priorGeneration = await readPublishedArtifactGeneration(outputDir, prior);
      const priorPointer = await readOpenClawCrablineArtifactPointer(outputDir);
      const failure = new Error("pointer publication failed");

      await expect(
        runSmokeWithDependencies(
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
    const release = vi.fn(async () => undefined);
    try {
      const prior = await runOpenClawCrablineChannelDriverSmoke({ outputDir, selection });
      const priorGeneration = await readPublishedArtifactGeneration(outputDir, prior);
      const priorPointer = await readOpenClawCrablineArtifactPointer(outputDir);

      await expect(
        runSmokeWithDependencies(
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

      await expect(runOpenClawCrablineChannelDriverSmoke({ outputDir, selection })).rejects.toThrow(
        `OpenClaw Crabline smoke is already running for channel "telegram" in "${outputDir}"; cannot start channel "telegram".`,
      );
      await expect(
        runOpenClawCrablineChannelDriverSmoke({ outputDir, selection: otherSelection }),
      ).rejects.toThrow(
        `OpenClaw Crabline smoke is already running for channel "telegram" in "${outputDir}"; cannot start channel "slack".`,
      );

      const holderExit = once(holder, "exit");
      holder.stdin.end("release\n");
      const [exitCode, signal] = await holderExit;
      expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });

      const result = await runOpenClawCrablineChannelDriverSmoke({ outputDir, selection });
      const smoke = JSON.parse(
        await fs.readFile(path.join(outputDir, result.smokeArtifactPath), "utf8"),
      ) as { smoke?: { result?: { provider?: string } } };
      expect(smoke.smoke?.result?.provider).toBe("telegram");
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
      const result = await runOpenClawCrablineChannelDriverSmoke({ outputDir, selection });
      const smoke = JSON.parse(
        await fs.readFile(path.join(outputDir, result.smokeArtifactPath), "utf8"),
      ) as { smoke?: { result?: { provider?: string } } };
      expect(smoke.smoke?.result?.provider).toBe("telegram");
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGTERM");
        await once(holder, "exit").catch(() => undefined);
      }
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
