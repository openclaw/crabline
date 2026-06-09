import { Chat, parseMarkdown } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { LoopbackChatAdapter } from "../src/providers/builtin/loopback.js";

let adapter: LoopbackChatAdapter | undefined;

afterEach(() => {
  adapter = undefined;
});

describe("loopback chat adapter", () => {
  it("supports direct adapter operations", async () => {
    adapter = new LoopbackChatAdapter("crabline");
    const chat = new Chat({
      adapters: { loopback: adapter },
      logger: "silent",
      state: createMemoryState(),
      userName: "crabline",
    });
    await chat.initialize();

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
    expect(adapter.renderFormatted(parseMarkdown("plain"))).toBe("plain");
    expect((await adapter.fetchThread(threadId)).id).toBe(threadId);
    await expect(adapter.handleWebhook(new Request("https://example.com"))).resolves.toBeInstanceOf(
      Response,
    );
    await adapter.startTyping();
    await adapter.deleteMessage(threadId, posted.id);
    expect((await adapter.fetchMessages(threadId)).messages).toHaveLength(0);
  });
});
