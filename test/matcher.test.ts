import { describe, expect, it } from "vitest";
import { matchesInbound } from "../src/core/matcher.js";
import { createNonce, extractNonce } from "../src/core/nonces.js";

describe("nonce + matcher", () => {
  it("generates extractable nonces", () => {
    const nonce = createNonce("fixture-id");
    expect(extractNonce(`hello ${nonce}`)).toBe(nonce);
  });

  it("rejects fixture ids outside the extractor alphabet", () => {
    for (const fixtureId of ["fixture_id", "fixture\n"]) {
      expect(() => createNonce(fixtureId)).toThrow(
        /fixture id must contain only letters, numbers, and hyphens/u,
      );
    }
  });

  it("requires boundaries outside the nonce alphabet", () => {
    const nonce = "mp-demo-abc-1234abcd";

    expect(extractNonce(`(${nonce})`)).toBe(nonce);
    expect(extractNonce(`prefix-${nonce}`)).toBeNull();
    expect(extractNonce(`${nonce}-suffix`)).toBeNull();
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
          text: `ACK ${otherNonce} then malformed ${nonce}-suffix`,
        },
        config,
        nonce,
      ),
    ).toBe(false);
    for (const suffix of ["\u0301", "\u200d", "\u203f"]) {
      expect(
        matchesInbound(
          {
            ...envelope,
            text: `ACK ${otherNonce} then malformed ${nonce}${suffix}`,
          },
          config,
          nonce,
        ),
      ).toBe(false);
    }
    expect(
      matchesInbound(
        {
          ...envelope,
          text: `malformed ${nonce}\u0301 then ${nonce}`,
        },
        config,
        nonce,
      ),
    ).toBe(true);
  });

  it("requires a standalone ACK token and the expected canonical nonce for replies", () => {
    const nonce = "mp-demo-abc-1234abcd";
    const otherNonce = "mp-other-def-8765dcba";
    const config = {
      author: "assistant" as const,
      nonce: "ignore" as const,
      strategy: "contains" as const,
    };
    const envelope = {
      author: "assistant" as const,
      id: "1",
      provider: "loopback",
      sentAt: new Date().toISOString(),
      text: `ACK ${nonce}`,
      threadId: "loopback:echo",
    };
    const matchesReply = (text: string) =>
      matchesInbound({ ...envelope, text }, config, nonce, { requireAcknowledgement: true });

    expect(matchesReply(`ACK ${nonce}`)).toBe(true);
    expect(matchesReply(`(ACK) ${nonce}`)).toBe(true);
    expect(matchesReply(`HACK ${nonce}`)).toBe(false);
    expect(matchesReply(`ACKNOWLEDGED ${nonce}`)).toBe(false);
    expect(matchesReply(`ack ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK ${otherNonce}`)).toBe(false);
    expect(matchesReply(`ACK ${otherNonce} then ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK ${nonce}-suffix`)).toBe(false);
    expect(matchesReply(`ACK ${nonce}-suffix then ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK ${nonce}\u0301`)).toBe(false);
    expect(matchesReply(`ACK ${nonce}\u200d`)).toBe(false);
    expect(matchesReply(`ACK ${nonce}\u203f`)).toBe(false);
    expect(matchesReply(`\u0301ACK ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK\u0301 ${nonce}`)).toBe(false);
    expect(matchesReply(`\u20ddACK ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK\u20dd ${nonce}`)).toBe(false);
    expect(matchesReply(`\u20e3ACK ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK\u20e3 ${nonce}`)).toBe(false);
    expect(matchesReply(`\u203fACK ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK\u203f ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK\u200c ${nonce}`)).toBe(false);
    expect(matchesReply(`H\u00b7ACK ${nonce}`)).toBe(false);
    expect(matchesReply(`ACK\u0387NOW ${nonce}`)).toBe(false);
    for (const formatCharacter of ["\u00ad", "\u200b", "\u2060", "\ufeff"]) {
      const codePoint = `U+${formatCharacter.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      expect(matchesReply(`${formatCharacter}ACK ${nonce}`), `${codePoint} before ACK`).toBe(false);
      expect(matchesReply(`ACK${formatCharacter} ${nonce}`), `${codePoint} after ACK`).toBe(false);
    }
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

  it("matches backtracking-heavy patterns in linear time", () => {
    expect(
      matchesInbound(
        {
          author: "assistant",
          id: "1",
          provider: "loopback",
          sentAt: new Date().toISOString(),
          text: `${"a".repeat(10_000)}!`,
          threadId: "loopback:echo",
        },
        {
          author: "assistant",
          nonce: "ignore",
          pattern: "^(a+)+$",
          strategy: "regex",
        },
        "nonce",
      ),
    ).toBe(false);
  });
});
