import { afterEach, describe, expect, it, vi } from "vitest";
import { CrablineError } from "../src/core/errors.js";
import { LoopbackChatAdapter } from "../src/providers/builtin/loopback.js";

let adapter: LoopbackChatAdapter | undefined;

afterEach(() => {
  vi.useRealTimers();
  adapter = undefined;
});

describe("loopback chat adapter", () => {
  it("round-trips direct and channel thread addresses", () => {
    adapter = new LoopbackChatAdapter("crabline");

    for (const address of [
      { id: "user:1", threadId: "dm::1" },
      { channelId: "channel:1", id: "user:1", threadId: "topic::1" },
      {
        channelId: "channel/%:?#[]@!$&'()*+,;=\u96EA",
        id: "user/%:?#[]@!$&'()*+,;=\u72D0",
        threadId: "topic/%:?#[]@!$&'()*+,;=\uD83E\uDD8A",
      },
    ]) {
      expect(adapter.decodeThreadId(adapter.encodeThreadId(address))).toEqual(address);
    }
  });

  it.each([
    { id: "" },
    { channelId: "", id: "user" },
    { id: "user", threadId: "" },
    { id: "\uD800" },
    { channelId: "\uD800", id: "user" },
    { id: "user", threadId: "\uD800" },
  ])("rejects invalid v2 encoder components: %o", (address) => {
    adapter = new LoopbackChatAdapter("crabline");

    let failure: unknown;
    try {
      adapter.encodeThreadId(address);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CrablineError);
    expect(failure).toMatchObject({
      kind: "inbound",
      message: "Loopback v2 thread address is malformed.",
    });
  });

  it("recovers delimiter-containing v2 channel ids for thread metadata", async () => {
    adapter = new LoopbackChatAdapter("crabline");
    const address = {
      channelId: "channel:west::1",
      id: "user:east::2",
      threadId: "topic:north::3",
    };
    const threadId = adapter.encodeThreadId(address);

    expect(adapter.channelIdFromThreadId(threadId)).toBe(address.channelId);
    await expect(adapter.fetchThread(threadId)).resolves.toMatchObject({
      channelId: address.channelId,
      id: threadId,
    });
    expect(adapter.channelIdFromThreadId("loopback:legacy::topic")).toBe("loopback:legacy");
  });

  it("preserves legacy percent-encoded-looking thread ids", () => {
    adapter = new LoopbackChatAdapter("crabline");

    expect(adapter.decodeThreadId("loopback:user%2F::topic%2F")).toEqual({
      channelId: "user%2F",
      id: "loopback:user%2F",
      threadId: "topic%2F",
    });
  });

  it.each([
    "loopback+v2:%",
    "loopback+v2:channel:%",
    "loopback+v2:user::%",
    "loopback+v2:channel:user:ignored",
    "loopback+v2:user::topic::ignored",
    "loopback+v2:channel:",
    "loopback+v2::user",
    "loopback+v2:user::",
    "loopback+v2:%75ser",
    "loopback+v2:user%2f",
    "loopback+v2:\uD800",
  ])("classifies malformed v2 thread addresses: %s", (threadId) => {
    adapter = new LoopbackChatAdapter("crabline");

    let failure: unknown;
    try {
      adapter.decodeThreadId(threadId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CrablineError);
    expect(failure).toMatchObject({
      kind: "inbound",
      message: "Loopback v2 thread address is malformed.",
    });
  });

  it("returns a cursor with the initial limited page", async () => {
    adapter = new LoopbackChatAdapter("crabline");
    const threadId = adapter.encodeThreadId({ id: "user-1" });
    adapter.ingestUserMessage(threadId, "first");
    adapter.ingestUserMessage(threadId, "second");
    adapter.ingestUserMessage(threadId, "third");

    const latest = await adapter.fetchMessages(threadId, { limit: 2 });
    expect(latest.messages.map((message) => message.text)).toEqual(["second", "third"]);
    expect(latest.nextCursor).toBe("2");

    const previous = await adapter.fetchMessages(threadId, {
      ...(latest.nextCursor ? { cursor: latest.nextCursor } : {}),
      limit: 2,
    });
    expect(previous.messages.map((message) => message.text)).toEqual(["first"]);
    expect(previous.nextCursor).toBeUndefined();
  });

  it("keeps pagination cursors stable when earlier messages are deleted", async () => {
    adapter = new LoopbackChatAdapter("crabline");
    const threadId = adapter.encodeThreadId({ id: "user-1" });
    const first = adapter.ingestUserMessage(threadId, "first");
    adapter.ingestUserMessage(threadId, "second");
    adapter.ingestUserMessage(threadId, "third");

    const latest = await adapter.fetchMessages(threadId, { limit: 2 });
    expect(latest.messages.map((message) => message.text)).toEqual(["second", "third"]);
    expect(latest.nextCursor).toBeDefined();

    await adapter.deleteMessage(threadId, first.id);
    const previous = await adapter.fetchMessages(threadId, {
      cursor: latest.nextCursor!,
      limit: 2,
    });

    expect(previous.messages).toEqual([]);
    expect(previous.nextCursor).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])("rejects invalid message limits: %s", (limit) => {
    adapter = new LoopbackChatAdapter("crabline");
    expect(() => adapter!.fetchMessages("thread-1", { limit })).toThrow(/positive safe integer/u);
  });

  it.each(["0", "-1", "1.5", "not-a-cursor", "9007199254740992"])(
    "rejects invalid message cursors: %s",
    (cursor) => {
      adapter = new LoopbackChatAdapter("crabline");
      const threadId = adapter.encodeThreadId({ id: "user-1" });
      adapter.ingestUserMessage(threadId, "first");
      expect(() => adapter!.fetchMessages(threadId, { cursor, limit: 1 })).toThrow(
        /positive safe integer/u,
      );
    },
  );

  it("preserves message order with unique timestamps across coarse and regressing clocks", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-14T07:00:00.000Z");
    vi.setSystemTime(initialTime);
    adapter = new LoopbackChatAdapter("crabline");
    const threadId = adapter.encodeThreadId({ id: "user-1" });

    const first = adapter.ingestUserMessage(threadId, "first");
    const second = await adapter.postMessage(threadId, "second");
    vi.setSystemTime(new Date(initialTime.getTime() - 1_000));
    adapter.ingestUserMessage(threadId, "third");
    await adapter.editMessage(threadId, second.id, "second edited");

    const messages = adapter.listSince(threadId, first.raw.timestamp);
    expect(messages.map((message) => message.text)).toEqual(["first", "second edited", "third"]);
    expect(messages.map((message) => Date.parse(message.raw.timestamp))).toEqual([
      initialTime.getTime(),
      initialTime.getTime() + 1,
      initialTime.getTime() + 2,
    ]);
    expect(messages[1]?.metadata.editedAt?.getTime()).toBe(initialTime.getTime() + 3);
  });

  it("rejects invalid history timestamps instead of reporting empty history", () => {
    adapter = new LoopbackChatAdapter("crabline");
    const threadId = adapter.encodeThreadId({ id: "user-1" });
    adapter.ingestUserMessage(threadId, "first");

    expect(() => adapter!.listSince(threadId, "not-a-date")).toThrow(
      expect.objectContaining({
        kind: "config",
        message: "Loopback since timestamp must be a valid date.",
      }),
    );
  });

  it("isolates stored messages from mutable inputs and returns", async () => {
    adapter = new LoopbackChatAdapter("crabline");
    const threadId = adapter.encodeThreadId({ id: "user-1" });

    const ingested = adapter.ingestUserMessage(threadId, "original");
    ingested.author.userName = "mutated";
    ingested.metadata.dateSent.setTime(0);
    ingested.raw.text = "mutated";
    ingested.text = "mutated";

    const firstFetch = await adapter.fetchMessages(threadId);
    expect(firstFetch.messages[0]).toMatchObject({
      author: { userName: "loopback" },
      raw: { text: "original" },
      text: "original",
    });
    expect(firstFetch.messages[0]?.metadata.dateSent.getTime()).not.toBe(0);

    firstFetch.messages[0]!.metadata.dateSent.setTime(0);
    firstFetch.messages[0]!.raw.text = "changed after fetch";
    firstFetch.messages[0]!.text = "changed after fetch";
    expect((await adapter.fetchMessages(threadId)).messages[0]).toMatchObject({
      raw: { text: "original" },
      text: "original",
    });

    const posted = await adapter.postMessage(threadId, "posted");
    posted.raw.text = "changed after post";
    await adapter.editMessage(threadId, posted.id, "edited");
    const edited = await adapter.editMessage(threadId, posted.id, "edited again");
    edited.raw.text = "changed after edit";

    const listed = adapter.listSince(threadId, new Date(0).toISOString());
    listed[1]!.metadata.editedAt!.setTime(0);
    listed[1]!.raw.text = "changed after list";

    const finalFetch = await adapter.fetchMessages(threadId);
    expect(finalFetch.messages[1]).toMatchObject({
      metadata: { edited: true },
      raw: { text: "edited again" },
      text: "edited again",
    });
    expect(finalFetch.messages[1]?.metadata.editedAt?.getTime()).not.toBe(0);

    const raw = {
      author: "user" as const,
      id: "raw",
      text: "parsed",
      threadId,
      timestamp: new Date().toISOString(),
    };
    const parsed = adapter.parseMessage(raw);
    raw.text = "changed after parse";
    expect(parsed.raw.text).toBe("parsed");
  });

  it("supports direct adapter operations", async () => {
    adapter = new LoopbackChatAdapter("crabline");

    const threadId = adapter.encodeThreadId({ id: "user-1", threadId: "dm-1" });
    expect(adapter.decodeThreadId(threadId).threadId).toBe("dm-1");
    expect(adapter.channelIdFromThreadId(threadId)).toContain("loopback");

    const posted = await adapter.postMessage(threadId, "hello");
    await adapter.editMessage(threadId, posted.id, { markdown: "**hello**" });
    const messages = await adapter.fetchMessages(threadId);
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]?.text).toBe("**hello**");

    const parsed = adapter.parseMessage({
      author: "user",
      id: "raw-1",
      text: "plain",
      threadId,
      timestamp: new Date().toISOString(),
    });
    expect(parsed.text).toBe("plain");
    expect(adapter.renderFormatted("plain")).toBe("plain");
    expect((await adapter.fetchThread(threadId)).id).toBe(threadId);
    await expect(adapter.handleWebhook(new Request("https://example.com"))).resolves.toBeInstanceOf(
      Response,
    );
    await adapter.startTyping();
    await adapter.deleteMessage(threadId, posted.id);
    expect((await adapter.fetchMessages(threadId)).messages).toHaveLength(0);
  });
});
