import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveWhatsAppAdapterConfig,
  WhatsAppProviderAdapter,
} from "../src/providers/builtin/whatsapp.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { ProviderContext } from "../src/providers/types.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

type FakeInboundPayload = {
  authorIsBot?: boolean;
  id: string;
  text: string;
  threadId: string;
};

type FakeMessage = {
  author: { isBot: boolean };
  id: string;
  metadata: { dateSent: Date };
  raw: Record<string, never>;
  text: string;
  threadId: string;
};

const directories: string[] = [];
const providers: WhatsAppProviderAdapter[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

async function createWhatsAppConfig(port: number): Promise<ProviderConfig> {
  const directory = await createTempDir();
  directories.push(directory);

  return {
    adapter: "whatsapp",
    capabilities: ["probe", "send", "roundtrip", "agent"],
    env: [],
    platform: "whatsapp",
    status: "active",
    whatsapp: {
      accessToken: "whatsapp-token",
      appSecret: "whatsapp-secret",
      phoneNumberId: "1234567890",
      recorder: { path: path.join(directory, "whatsapp.jsonl") },
      verifyToken: "verify-token",
      webhook: {
        host: "127.0.0.1",
        path: "/whatsapp/webhook",
        port,
      },
    },
  };
}

function createFakeWhatsAppRuntime() {
  const directHandlers: Array<
    (thread: { id: string }, message: FakeMessage) => Promise<void> | void
  > = [];
  const mentionHandlers: typeof directHandlers = [];
  const messageHandlers: typeof directHandlers = [];
  const subscribedHandlers: typeof directHandlers = [];
  const subscriptions = new Set<string>();

  const adapter = {
    fetchThread: vi.fn(async (threadId: string) => ({ id: threadId })),
    openDM: vi.fn(async (userId: string) => `whatsapp:1234567890:${userId}`),
    postMessage: vi.fn(async (threadId: string, _text: string) => ({
      id: "whatsapp-sent",
      threadId,
    })),
  };

  const chat = {
    getState() {
      return {
        subscribe: vi.fn(async (threadId: string) => {
          subscriptions.add(threadId);
        }),
      };
    },
    initialize: vi.fn(async () => {}),
    onDirectMessage(
      handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void,
    ) {
      directHandlers.push(handler);
    },
    onNewMention(handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void) {
      mentionHandlers.push(handler);
    },
    onNewMessage(
      _pattern: RegExp,
      handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void,
    ) {
      messageHandlers.push(handler);
    },
    onSubscribedMessage(
      handler: (thread: { id: string }, message: FakeMessage) => Promise<void> | void,
    ) {
      subscribedHandlers.push(handler);
    },
    webhooks: {
      whatsapp: vi.fn(async (request: Request) => {
        if (request.method === "GET") {
          return new Response(new URL(request.url).searchParams.get("hub.challenge") ?? "");
        }

        const payload = (await request.json()) as {
          kind?: "direct" | "mention" | "message" | "subscribed";
          message: FakeInboundPayload;
        };
        const handlersByKind = {
          direct: directHandlers,
          mention: mentionHandlers,
          message: messageHandlers,
          subscribed: subscribedHandlers,
        } as const;

        const kind = payload.kind ?? "subscribed";
        const message = createFakeMessage(payload.message);
        const thread = { id: message.threadId };
        for (const handler of handlersByKind[kind]) {
          await handler(thread, message);
        }

        return new Response("ok");
      }),
    },
  };

  return {
    adapter,
    chat,
    runtime: {
      createAdapter: () => adapter,
      createChat: () => chat,
    },
    subscriptions,
  };
}

function createFakeMessage(payload: FakeInboundPayload): FakeMessage {
  return {
    author: { isBot: payload.authorIsBot ?? true },
    id: payload.id,
    metadata: { dateSent: new Date() },
    raw: {},
    text: payload.text,
    threadId: payload.threadId,
  };
}

function createContext(config: ProviderConfig): ProviderContext {
  return {
    config,
    fixture: {
      env: [],
      id: "whatsapp-agent",
      inboundMatch: { author: "assistant", nonce: "contains", strategy: "contains" },
      mode: "agent",
      provider: "whatsapp",
      retries: 0,
      tags: [],
      target: {
        id: "15551234567",
        metadata: {},
      },
      timeoutMs: 500,
    },
    manifestPath: "/tmp/crabline.yaml",
    providerId: "whatsapp",
    userName: "crabline",
  };
}

describe("whatsapp provider", () => {
  it("resolves adapter config from provider settings and env", () => {
    expect(
      resolveWhatsAppAdapterConfig(
        {
          adapter: "whatsapp",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "whatsapp",
          status: "active",
          whatsapp: {
            accessToken: "config-token",
            appSecret: "config-secret",
            phoneNumberId: "config-phone",
            recorder: {},
            verifyToken: "config-verify",
            webhook: { host: "127.0.0.1", path: "/whatsapp/webhook", port: 8789 },
          },
        },
        {
          WHATSAPP_API_URL: "https://graph.example.com",
          WHATSAPP_BOT_USERNAME: "crabline_whatsapp",
        },
      ),
    ).toMatchObject({
      accessToken: "config-token",
      apiUrl: "https://graph.example.com",
      appSecret: "config-secret",
      phoneNumberId: "config-phone",
      userName: "crabline_whatsapp",
      verifyToken: "config-verify",
    });
  });

  it("normalizes raw WhatsApp IDs into Chat SDK thread IDs", async () => {
    const runtime = createFakeWhatsAppRuntime();
    const config = await createWhatsAppConfig(0);
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline", runtime.runtime);
    providers.push(provider);

    expect(provider.normalizeTarget({ id: "15551234567", metadata: {} })).toMatchObject({
      channelId: "whatsapp:1234567890:15551234567",
    });
    expect(
      provider.normalizeTarget({
        id: "reply",
        metadata: {},
        threadId: "whatsapp:1234567890:15557654321",
      }),
    ).toMatchObject({
      threadId: "whatsapp:1234567890:15557654321",
    });
  });

  it("probes and sends through the provider adapter", async () => {
    const runtime = createFakeWhatsAppRuntime();
    const config = await createWhatsAppConfig(0);
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    expect(probe.healthy).toBe(true);
    expect(probe.details.join("\n")).toContain("webhook endpoint http://127.0.0.1:");

    const result = await provider.send({
      ...createContext(config),
      mode: "roundtrip",
      nonce: "nonce-1",
      text: "hello",
    });

    expect(result.threadId).toBe("whatsapp:1234567890:15551234567");
    expect(runtime.adapter.postMessage).toHaveBeenCalledWith(
      "whatsapp:1234567890:15551234567",
      "hello",
    );
    expect(runtime.subscriptions.has("whatsapp:1234567890:15551234567")).toBe(true);
  });

  it("serves verification requests and records webhook inbound events", async () => {
    const runtime = createFakeWhatsAppRuntime();
    const config = await createWhatsAppConfig(0);
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline", runtime.runtime);
    providers.push(provider);

    const probe = await provider.probe(createContext(config));
    const endpoint = probe.details.find((detail) => detail.startsWith("webhook endpoint "));
    expect(endpoint).toBeDefined();

    const verification = await fetch(
      `${endpoint!.replace("webhook endpoint ", "")}?hub.challenge=verified`,
      { method: "GET" },
    );
    await expect(verification.text()).resolves.toBe("verified");

    const waitPromise = provider.waitForInbound({
      ...createContext(config),
      nonce: "nonce-2",
      since: new Date(Date.now() - 1000).toISOString(),
      threadId: "whatsapp:1234567890:15551234567",
      timeoutMs: 500,
    });

    await fetch(endpoint!.replace("webhook endpoint ", ""), {
      body: JSON.stringify({
        message: {
          id: "evt-1",
          text: "ACK nonce-2",
          threadId: "whatsapp:1234567890:15551234567",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(waitPromise).resolves.toMatchObject({
      id: "evt-1",
      text: "ACK nonce-2",
    });
  });
});
