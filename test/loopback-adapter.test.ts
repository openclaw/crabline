import { afterEach, describe, expect, it } from "vitest";
import { LoopbackChatAdapter } from "../src/providers/builtin/loopback.js";

let adapter: LoopbackChatAdapter | undefined;

afterEach(() => {
  adapter = undefined;
});

describe("loopback chat adapter", () => {
  it("round-trips direct and channel thread addresses", () => {
    adapter = new LoopbackChatAdapter("crabline");

    for (const address of [
      { id: "user:1", threadId: "dm::1" },
      { channelId: "channel:1", id: "user:1", threadId: "topic::1" },
    ]) {
      expect(adapter.decodeThreadId(adapter.encodeThreadId(address))).toEqual(address);
    }
  });

  it("preserves legacy percent-encoded-looking thread ids", () => {
    adapter = new LoopbackChatAdapter("crabline");

    expect(adapter.decodeThreadId("loopback:user%2F::topic%2F")).toEqual({
      channelId: "user%2F",
      id: "loopback:user%2F",
      threadId: "topic%2F",
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
    expect(latest.nextCursor).toBe("1");

    const previous = await adapter.fetchMessages(threadId, {
      ...(latest.nextCursor ? { cursor: latest.nextCursor } : {}),
      limit: 2,
    });
    expect(previous.messages.map((message) => message.text)).toEqual(["first"]);
    expect(previous.nextCursor).toBeUndefined();
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
