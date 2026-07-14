import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppProviderAdapter } from "../src/providers/builtin/whatsapp.js";
import { appendRecordedInbound } from "../src/providers/recorder.js";
import { createLocalMockConfig, createProviderContext } from "./local-mock-provider-helpers.js";

type WaitForRecordedInbound = typeof import("../src/providers/recorder.js").waitForRecordedInbound;

const webhookMocks = vi.hoisted(() => ({
  startWebhookServer: vi.fn(),
}));
const recorderMocks = vi.hoisted(() => ({
  actualWaitForRecordedInbound: undefined as WaitForRecordedInbound | undefined,
  waitForRecordedInbound: vi.fn<WaitForRecordedInbound>(),
}));

vi.mock("../src/providers/webhook-server.js", () => ({
  startWebhookServer: webhookMocks.startWebhookServer,
}));
vi.mock("../src/providers/recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/recorder.js")>();
  recorderMocks.actualWaitForRecordedInbound = actual.waitForRecordedInbound;
  recorderMocks.waitForRecordedInbound.mockImplementation(actual.waitForRecordedInbound);
  return {
    ...actual,
    waitForRecordedInbound: recorderMocks.waitForRecordedInbound,
  };
});

const providers: WhatsAppProviderAdapter[] = [];

beforeEach(() => {
  webhookMocks.startWebhookServer.mockReset();
  webhookMocks.startWebhookServer.mockResolvedValue({
    async close() {},
    endpointUrl: "http://127.0.0.1:0/whatsapp/webhook",
  });
  recorderMocks.waitForRecordedInbound.mockReset();
  recorderMocks.waitForRecordedInbound.mockImplementation(
    recorderMocks.actualWaitForRecordedInbound!,
  );
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.cleanup()));
});

describe("WhatsApp provider recorder cursors", () => {
  it("commits concurrent cursor progress monotonically", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    providers.push(provider);
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    const waitContext = {
      ...context,
      nonce: "monotonic-cursor",
      since: new Date(0).toISOString(),
      threadId: "15551234567",
      timeoutMs: 100,
    };
    let releaseOlder!: () => void;
    const olderBlocked = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const startingOffsets: number[] = [];
    let call = 0;
    recorderMocks.waitForRecordedInbound.mockImplementation(async ({ cursor }) => {
      const activeCursor = cursor!;
      startingOffsets.push(activeCursor.readState.offset);
      call += 1;
      activeCursor.readState.generation = 1;
      activeCursor.readState.offset = call === 1 ? 10 : 20;
      if (call === 1) {
        await olderBlocked;
      }
      return null;
    });

    const older = provider.waitForInbound(waitContext);
    await vi.waitFor(() => expect(recorderMocks.waitForRecordedInbound).toHaveBeenCalledTimes(1));
    const newer = provider.waitForInbound(waitContext);
    await expect(newer).resolves.toBeNull();
    releaseOlder();
    await expect(older).resolves.toBeNull();
    await expect(provider.waitForInbound(waitContext)).resolves.toBeNull();

    expect(startingOffsets).toEqual([0, 0, 20]);
  });

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
      recordedDirection: "outbound",
      sentAt: new Date().toISOString(),
      text: "outbound",
      threadId: "15551234567",
    });
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "first",
      provider: "whatsapp",
      raw: { direction: "outbound" },
      recordedDirection: "inbound",
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

    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "sixth",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "sixth",
      threadId: "15551234567",
    });
    await expect(provider.waitForInbound(waitContext)).resolves.toMatchObject({ id: "sixth" });
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

  it("prunes inactive cursor entries while another wait remains active", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    providers.push(provider);
    const baseContext = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    const startingOffsets: number[] = [];
    let releaseActiveWait!: () => void;
    const activeWaitBlocked = new Promise<void>((resolve) => {
      releaseActiveWait = resolve;
    });
    let calls = 0;
    recorderMocks.waitForRecordedInbound.mockImplementation(async ({ cursor }) => {
      calls++;
      startingOffsets.push(cursor!.readState.offset);
      cursor!.readState.offset = 1;
      if (calls === 1) {
        await activeWaitBlocked;
      }
      return null;
    });
    const activeWait = provider.waitForInbound({
      ...baseContext,
      nonce: "active-cursor",
      since: new Date(0).toISOString(),
      threadId: "15551234567",
      timeoutMs: 100,
    });
    await vi.waitFor(() => expect(recorderMocks.waitForRecordedInbound).toHaveBeenCalledTimes(1));
    const contexts = Array.from({ length: 65 }, (_, index) => ({
      ...baseContext,
      nonce: `settled-cursor-${index}`,
      since: new Date(0).toISOString(),
      threadId: "15551234567",
      timeoutMs: 100,
    }));

    await Promise.all(contexts.map((context) => provider.waitForInbound(context)));
    await provider.waitForInbound(contexts[0]!);
    releaseActiveWait();
    await expect(activeWait).resolves.toBeNull();

    expect(startingOffsets).toHaveLength(67);
    expect(startingOffsets.at(-1)).toBe(0);
  });

  it("retains recorder progress after a timeout", async () => {
    const config = await createLocalMockConfig("whatsapp", "/whatsapp/webhook");
    const provider = new WhatsAppProviderAdapter("whatsapp", config, "crabline");
    providers.push(provider);
    const context = createProviderContext("whatsapp", config, {
      id: "15551234567",
      metadata: {},
    });
    let authorReads = 0;
    context.fixture.inboundMatch = {
      get author() {
        authorReads += 1;
        return "assistant" as const;
      },
      nonce: "ignore",
      strategy: "contains",
    };
    const recorderPath = path.resolve(config.whatsapp!.recorder.path!);
    const waitContext = {
      ...context,
      nonce: "cursor-timeout",
      since: new Date(0).toISOString(),
      threadId: "15551234567",
      timeoutMs: 30,
    };
    await appendRecordedInbound(recorderPath, {
      author: "user",
      id: "stale",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "stale",
      threadId: "15551234567",
    });

    await expect(provider.waitForInbound(waitContext)).resolves.toBeNull();
    await appendRecordedInbound(recorderPath, {
      author: "assistant",
      id: "fresh",
      provider: "whatsapp",
      sentAt: new Date().toISOString(),
      text: "fresh",
      threadId: "15551234567",
    });
    await expect(provider.waitForInbound(waitContext)).resolves.toMatchObject({ id: "fresh" });
    expect(authorReads).toBe(6);
  });
});
