import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppProviderAdapter } from "../src/providers/builtin/whatsapp.js";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import { createLocalMockConfig, createProviderContext } from "./local-mock-provider-helpers.js";

const webhookMocks = vi.hoisted(() => ({
  startWebhookServer: vi.fn(),
}));

vi.mock("../src/providers/webhook-server.js", () => ({
  startWebhookServer: webhookMocks.startWebhookServer,
}));

const providers: WhatsAppProviderAdapter[] = [];

beforeEach(() => {
  webhookMocks.startWebhookServer.mockReset();
  webhookMocks.startWebhookServer.mockResolvedValue({
    async close() {},
    endpointUrl: "http://127.0.0.1:0/whatsapp/webhook",
  });
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
});

describe("WhatsApp provider recorder cursors", () => {
  it("advances sequential waits and excludes outbound records", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    providers.push(provider);
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    context.fixture.inboundMatch = { author: "any", nonce: "ignore", strategy: "contains" };
    const recorderPath = path.resolve(config.whatsapp!.recorder.path!);
    const waitContext = {
      ...context,
      nonce: "cursor",
      since: new Date(0).toISOString(),
      threadId: "15551234567",
      timeoutMs: 100,
    };
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "outbound",
      provider: "whatsapp",
      raw: { direction: "outbound" },
      sentAt: new Date().toISOString(),
      text: "outbound",
      threadId: "15551234567",
    });
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "first",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "first",
      threadId: "15551234567",
    });
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "second",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "second",
      threadId: "15551234567",
    });

    await expect(provider.waitForInbound(waitContext)).resolves.toMatchObject({ id: "first" });
    await expect(provider.waitForInbound(waitContext)).resolves.toMatchObject({ id: "second" });

    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "third",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "third",
      threadId: "15551234567",
    });
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "fourth",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "fourth",
      threadId: "15551234567",
    });
    const firstConcurrentWait = provider.waitForInbound(waitContext);
    const secondConcurrentWait = provider.waitForInbound(waitContext);

    await expect(Promise.all([firstConcurrentWait, secondConcurrentWait])).resolves.toEqual([
      expect.objectContaining({ id: "third" }),
      expect.objectContaining({ id: "third" }),
    ]);
    await expect(provider.waitForInbound(waitContext)).resolves.toMatchObject({ id: "fourth" });

    const cancellationWaitContext = { ...waitContext, timeoutMs: 500 };
    const olderWait = provider.waitForInbound(cancellationWaitContext);
    const abortController = new AbortController();
    const newerWait = provider.waitForInbound({
      ...cancellationWaitContext,
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(newerWait).resolves.toBeNull();
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "fifth",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "fifth",
      threadId: "15551234567",
    });

    await expect(olderWait).resolves.toMatchObject({ id: "fifth" });
    await expect(provider.waitForInbound({ ...waitContext, timeoutMs: 30 })).resolves.toBeNull();
  });

  it("does not evict cursor state while distinct waits are active", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    providers.push(provider);
    const baseContext = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    const recorderPath = path.resolve(config.whatsapp!.recorder.path!);
    const controllers = Array.from({ length: 65 }, () => new AbortController());
    const contexts = controllers.map((controller, index) => ({
      ...baseContext,
      fixture: {
        ...baseContext.fixture,
        inboundMatch: {
          author: "any" as const,
          nonce: "ignore" as const,
          pattern: `cursor-message-${index}`,
          strategy: "contains" as const,
        },
      },
      nonce: `cursor-${index}`,
      signal: controller.signal,
      since: new Date(0).toISOString(),
      threadId: "15551234567",
      timeoutMs: 2_000,
    }));
    const waits = contexts.map((context) => provider.waitForInbound(context));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "first-cursor-event",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "cursor-message-0",
      threadId: "15551234567",
    });
    await expect(waits[0]).resolves.toMatchObject({ id: "first-cursor-event" });

    const repeatedWait = provider.waitForInbound(contexts[0]!);
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "second-cursor-event",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "cursor-message-0",
      threadId: "15551234567",
    });
    await expect(repeatedWait).resolves.toMatchObject({ id: "second-cursor-event" });

    controllers.slice(1).forEach((controller) => controller.abort());
    await Promise.all(waits.slice(1));
  });
});
