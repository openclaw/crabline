import { describe, expect, it } from "vitest";
import { matchesInbound } from "../src/core/matcher.js";
import { createNonce, extractNonce } from "../src/core/nonces.js";

describe("nonce + matcher", () => {
  it("generates extractable nonces", () => {
    const nonce = createNonce("fixture-id");
    expect(extractNonce(`hello ${nonce}`)).toBe(nonce);
  });

  it("matches inbound messages with nonce", () => {
    const nonce = "mp-demo-abc-1234abcd";
    expect(
      matchesInbound(
        {
          author: "assistant",
          id: "1",
          provider: "loopback",
          sentAt: new Date().toISOString(),
          text: `ACK ${nonce}`,
          threadId: "loopback:echo",
        },
        {
          author: "assistant",
          nonce: "contains",
          strategy: "contains",
        },
        nonce,
      ),
    ).toBe(true);
  });

  it("covers exact, regex, and ignore-nonce branches", () => {
    const baseMessage = {
      author: "assistant" as const,
      id: "1",
      provider: "loopback",
      sentAt: new Date().toISOString(),
      text: "hello world",
      threadId: "loopback:echo",
    };

    expect(
      matchesInbound(
        baseMessage,
        {
          author: "assistant",
          nonce: "ignore",
          pattern: "hello world",
          strategy: "exact",
        },
        "nonce",
      ),
    ).toBe(true);

    expect(
      matchesInbound(
        baseMessage,
        {
          author: "assistant",
          nonce: "ignore",
          pattern: "^hello",
          strategy: "regex",
        },
        "nonce",
      ),
    ).toBe(true);

    expect(
      matchesInbound(
        { ...baseMessage, author: "user" },
        {
          author: "assistant",
          nonce: "ignore",
          strategy: "contains",
        },
        "nonce",
      ),
    ).toBe(false);
  });
});
