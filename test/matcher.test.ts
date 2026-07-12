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

  it("matches contains mode only against canonical nonce tokens", () => {
    const nonce = "mp-demo-abc-1234abcd";
    const otherNonce = "mp-other-def-8765dcba";
    const envelope = {
      author: "assistant" as const,
      id: "1",
      provider: "loopback",
      sentAt: new Date().toISOString(),
      text: `ACK ${otherNonce} then ${nonce}`,
      threadId: "loopback:echo",
    };
    const config = {
      author: "assistant" as const,
      nonce: "contains" as const,
      strategy: "contains" as const,
    };

    expect(matchesInbound(envelope, config, nonce)).toBe(true);
    expect(
      matchesInbound(
        {
          ...envelope,
          text: `ACK ${otherNonce} then malformed ${nonce}0`,
        },
        config,
        nonce,
      ),
    ).toBe(false);
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
