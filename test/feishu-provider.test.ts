import { createCipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createFeishuWebhookAuthenticator,
  decryptFeishuWebhookPayload,
  FeishuProviderAdapter,
  handleFeishuWebhookPayload,
  normalizeFeishuWebhookPayload,
} from "../src/providers/builtin/feishu.js";
import {
  createLocalMockConfig,
  createProviderContext,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

function encryptFeishuPayload(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = Buffer.alloc(16, 0x42);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString(
    "base64",
  );
}

describe("Feishu webhook normalizer", () => {
  it("requires native authentication for externally reachable webhooks", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    config.feishu!.webhook.host = "0.0.0.0";
    expect(() => new FeishuProviderAdapter("feishu", config, "crabline", { env: {} })).toThrow(
      /externally reachable webhooks require feishu\.encryptKey/u,
    );

    config.feishu!.verificationToken = "sample";
    expect(() => new FeishuProviderAdapter("feishu", config, "crabline", { env: {} })).toThrow(
      /X-Lark-Signature verification/u,
    );

    config.feishu!.encryptKey = "encrypt-key";
    config.feishu!.webhook.publicUrl = "https://hooks.example.test/feishu/webhook";
    expect(
      () => new FeishuProviderAdapter("feishu", config, "crabline", { env: {} }),
    ).not.toThrow();
  });

  it("answers URL verification challenges", async () => {
    const response = handleFeishuWebhookPayload({
      challenge: "challenge-token",
      type: "url_verification",
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ challenge: "challenge-token" });
  });

  it("verifies plaintext callback tokens", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    config.feishu!.verificationToken = "sample";
    const authenticate = createFeishuWebhookAuthenticator(config, {});
    const request = new Request("https://feishu.example.test/webhook");

    await expect(
      authenticate!(
        request,
        JSON.stringify({
          challenge: "challenge-token",
          token: "sample",
          type: "url_verification",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticate!(
        request,
        JSON.stringify({
          challenge: "challenge-token",
          token: "wrong",
          type: "url_verification",
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("verifies and decrypts encrypted native events", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    const encryptKey = "encrypt-key";
    config.feishu!.encryptKey = encryptKey;
    config.feishu!.verificationToken = "sample";
    const nativePayload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "encrypted hello" }),
          message_id: "om_message123",
          message_type: "text",
        },
        sender: { sender_type: "bot" },
      },
      header: { token: "sample" },
      schema: "2.0",
    };
    const encryptedPayload = { encrypt: encryptFeishuPayload(nativePayload, encryptKey) };
    const rawBody = JSON.stringify(encryptedPayload);
    const timestamp = "1700000000";
    const nonce = "nonce";
    const signature = createHash("sha256")
      .update(timestamp + nonce + encryptKey + rawBody)
      .digest("hex");
    const authenticate = createFeishuWebhookAuthenticator(
      config,
      {},
      {
        now: () => Number(timestamp) * 1_000,
      },
    );

    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook", {
          headers: {
            "x-lark-request-nonce": nonce,
            "x-lark-request-timestamp": timestamp,
            "x-lark-signature": signature,
          },
        }),
        rawBody,
      ),
    ).resolves.toBeUndefined();
    expect(
      normalizeFeishuWebhookPayload(decryptFeishuWebhookPayload(encryptedPayload, encryptKey)),
    ).toMatchObject({
      author: "assistant",
      id: "om_message123",
      text: "encrypted hello",
      threadId: "oc_abc123",
    });

    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook", {
          headers: {
            "x-lark-request-nonce": nonce,
            "x-lark-request-timestamp": timestamp,
            "x-lark-signature": "0".repeat(64),
          },
        }),
        rawBody,
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rejects encrypted payloads without ciphertext after the IV", () => {
    expect(() =>
      decryptFeishuWebhookPayload({ encrypt: Buffer.alloc(16).toString("base64") }, "encrypt-key"),
    ).toThrow(/truncated/u);
  });

  it("accepts token-authenticated encrypted URL verification without signature headers", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    const encryptKey = "encrypt-key";
    config.feishu!.encryptKey = encryptKey;
    config.feishu!.verificationToken = "sample";
    const now = 1_700_000_000_000;
    const authenticate = createFeishuWebhookAuthenticator(config, {}, { now: () => now });
    const encryptedPayload = {
      encrypt: encryptFeishuPayload(
        {
          challenge: "challenge-token",
          token: "sample",
          type: "url_verification",
        },
        encryptKey,
      ),
    };
    const rawBody = JSON.stringify(encryptedPayload);
    const timestamp = String(now / 1_000);
    const nonce = "challenge-nonce";
    const signature = createHash("sha256")
      .update(timestamp + nonce + encryptKey + rawBody)
      .digest("hex");

    await expect(
      authenticate!(new Request("https://feishu.example.test/webhook"), rawBody),
    ).resolves.toBeUndefined();
    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook", {
          headers: {
            "x-lark-request-nonce": nonce,
            "x-lark-request-timestamp": timestamp,
            "x-lark-signature": signature,
          },
        }),
        rawBody,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook"),
        JSON.stringify({
          encrypt: encryptFeishuPayload(
            {
              challenge: "challenge-token",
              token: "wrong",
              type: "url_verification",
            },
            encryptKey,
          ),
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook", {
          headers: {
            "x-lark-request-nonce": nonce,
            "x-lark-request-timestamp": timestamp,
            "x-lark-signature": "0".repeat(64),
          },
        }),
        JSON.stringify({ encrypt: Buffer.alloc(16).toString("base64") }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rejects native messages without stable identifiers", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "identifier required" }),
          message_type: "text",
        },
      },
      header: { event_id: "event-without-message-id" },
      schema: "2.0",
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => normalizeFeishuWebhookPayload(payload)).toThrow(/message\.message_id/u);
    }
  });

  it("rejects unsigned encrypted event callbacks", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    const encryptKey = "encrypt-key";
    config.feishu!.encryptKey = encryptKey;
    const authenticate = createFeishuWebhookAuthenticator(config, {});
    const event = JSON.stringify({
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "unsigned" }),
          message_id: "om_unsigned123",
          message_type: "text",
        },
      },
    });

    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook"),
        JSON.stringify({ encrypt: encryptFeishuPayload(JSON.parse(event), encryptKey) }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("still recognizes plaintext URL verification payloads", () => {
    const challenge = {
      challenge: "challenge-token",
      type: "url_verification",
    };
    expect(handleFeishuWebhookPayload(challenge)?.status).toBe(200);
  });

  it("rejects plaintext callbacks when only encrypted ingress is configured", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    config.feishu!.encryptKey = "encrypt-key";
    const authenticate = createFeishuWebhookAuthenticator(config, {});

    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook"),
        JSON.stringify({
          event: {
            message: {
              chat_id: "oc_abc123",
              content: JSON.stringify({ text: "plaintext" }),
              message_id: "om_message123",
              message_type: "text",
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rejects token-authenticated plaintext when encryption is configured", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    config.feishu!.encryptKey = "encrypt-key";
    config.feishu!.verificationToken = "sample";
    const authenticate = createFeishuWebhookAuthenticator(config, {});

    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook"),
        JSON.stringify({
          event: {
            message: {
              chat_id: "oc_abc123",
              content: JSON.stringify({ text: "plaintext" }),
              message_id: "om_message123",
              message_type: "text",
            },
          },
          token: "sample",
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("uses the chat for ordinary messages and preserves message_id as the event id", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "hello" }),
          message_id: "om_message123",
          message_type: "text",
        },
      },
    };

    expect(normalizeFeishuWebhookPayload(payload)).toMatchObject({
      id: "om_message123",
      threadId: "oc_abc123",
    });
  });

  it("uses root_id for topic replies", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "topic reply" }),
          message_id: "om_reply123",
          message_type: "text",
          root_id: "om_root123",
        },
      },
    };

    expect(normalizeFeishuWebhookPayload(payload)).toMatchObject({
      id: "om_reply123",
      threadId: "om_root123",
    });
  });

  it("acknowledges unsupported and empty native messages without recording them", () => {
    expect(
      handleFeishuWebhookPayload({
        event: {
          message: {
            chat_id: "oc_abc123",
            content: JSON.stringify({ text: "not really text" }),
            message_id: "om_message123",
            message_type: "image",
          },
        },
      })?.status,
    ).toBe(200);
    expect(
      handleFeishuWebhookPayload({
        event: {
          message: {
            chat_id: "oc_abc123",
            content: JSON.stringify({ text: "" }),
            message_id: "om_message123",
            message_type: "text",
          },
        },
      })?.status,
    ).toBe(200);
    expect(
      handleFeishuWebhookPayload({
        event: {
          message: {
            chat_id: "oc_abc123",
            content: JSON.stringify({ unexpected: "object" }),
            message_id: "om_message123",
            message_type: "text",
          },
        },
      })?.status,
    ).toBe(200);
    expect(() =>
      normalizeFeishuWebhookPayload({
        event: {
          message: {
            chat_id: "oc_abc123",
            content: JSON.stringify({ unexpected: "object" }),
            message_id: "om_message123",
            message_type: "text",
          },
        },
      }),
    ).toThrow(/message\.content/u);
  });

  it("rejects malformed JSON message content instead of treating it as plaintext", () => {
    const payload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: "{not-json",
          message_id: "om_message123",
          message_type: "text",
        },
      },
    };

    expect(handleFeishuWebhookPayload(payload)).toBeUndefined();
    expect(() => normalizeFeishuWebhookPayload(payload)).toThrow(
      "Feishu message.content must be valid JSON",
    );
  });

  it("rejects stale callbacks", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    const encryptKey = "encrypt-key";
    const now = 1_700_000_000_000;
    config.feishu!.encryptKey = encryptKey;
    const nativePayload = {
      event: {
        message: {
          chat_id: "oc_abc123",
          content: JSON.stringify({ text: "hello" }),
          message_id: "om_duplicate123",
          message_type: "text",
        },
      },
      header: { event_id: "event-duplicate", token: "sample" },
      schema: "2.0",
    };
    const rawBody = JSON.stringify({
      encrypt: encryptFeishuPayload(nativePayload, encryptKey),
    });
    const authenticate = createFeishuWebhookAuthenticator(config, {}, { now: () => now });
    const createRequest = (timestamp: number) => {
      const timestampText = String(timestamp);
      const nonce = `nonce-${timestampText}`;
      const signature = createHash("sha256")
        .update(timestampText + nonce + encryptKey + rawBody)
        .digest("hex");
      return new Request("https://feishu.example.test/webhook", {
        headers: {
          "x-lark-request-nonce": nonce,
          "x-lark-request-timestamp": timestampText,
          "x-lark-signature": signature,
        },
      });
    };

    await expect(authenticate!(createRequest(now / 1_000), rawBody)).resolves.toBeUndefined();
    await expect(authenticate!(createRequest(now / 1_000 - 301), rawBody)).resolves.toMatchObject({
      status: 401,
    });
    const malformedTimestamp = "not-a-timestamp";
    const nonce = "nonce-malformed";
    const signature = createHash("sha256")
      .update(malformedTimestamp + nonce + encryptKey + rawBody)
      .digest("hex");
    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook", {
          headers: {
            "x-lark-request-nonce": nonce,
            "x-lark-request-timestamp": malformedTimestamp,
            "x-lark-signature": signature,
          },
        }),
        rawBody,
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("suppresses retries only after successful recorder persistence", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    const encryptKey = "encrypt-key";
    const now = 1_700_000_000_000;
    config.feishu!.encryptKey = encryptKey;
    const provider = new FeishuProviderAdapter("feishu", config, "crabline", {
      env: {},
      now: () => now,
    });
    const context = createProviderContext("feishu", config, {
      id: "oc_abc123",
      metadata: {},
    });
    const endpoint = (await provider.probe(context)).details
      .find((detail) => detail.startsWith("webhook endpoint "))
      ?.replace("webhook endpoint ", "");
    expect(endpoint).toBeDefined();

    const send = async (nativePayload: unknown) => {
      const rawBody = JSON.stringify({
        encrypt: encryptFeishuPayload(nativePayload, encryptKey),
      });
      const timestamp = String(now / 1_000);
      const nonce = createHash("sha256").update(rawBody).digest("hex").slice(0, 16);
      const signature = createHash("sha256")
        .update(timestamp + nonce + encryptKey + rawBody)
        .digest("hex");
      return await fetch(endpoint!, {
        body: rawBody,
        headers: {
          "content-type": "application/json",
          "x-lark-request-nonce": nonce,
          "x-lark-request-timestamp": timestamp,
          "x-lark-signature": signature,
        },
        method: "POST",
      });
    };

    try {
      const validPayload = {
        event: {
          message: {
            chat_id: "oc_abc123",
            content: JSON.stringify({ text: "persist once" }),
            message_id: "om_persist123",
            message_type: "text",
          },
        },
        header: { event_id: "event-persist" },
        schema: "2.0",
      };
      const concurrentResponses = await Promise.all([send(validPayload), send(validPayload)]);
      expect(concurrentResponses.map((response) => response.status)).toEqual([200, 200]);
      expect((await send(validPayload)).status).toBe(200);
      expect(
        (await readFile(config.feishu!.recorder.path!, "utf8")).trim().split("\n"),
      ).toHaveLength(1);

      const rejectedPayload = {
        event: {
          message: {
            content: JSON.stringify({ text: "missing chat" }),
            message_id: "om_rejected123",
            message_type: "text",
          },
        },
        header: { event_id: "event-rejected" },
        schema: "2.0",
      };
      expect((await send(rejectedPayload)).status).toBe(400);
      expect((await send(rejectedPayload)).status).toBe(400);
    } finally {
      await provider.cleanup();
    }
  });
});

runLocalMockProviderContract({
  Adapter: FeishuProviderAdapter,
  endpointPath: "/feishu/webhook",
  expectedChannelId: "oc_abc123",
  expectedThreadId: "om_abc123",
  platform: "feishu",
  target: { id: "oc_abc123", metadata: {} },
  threadTarget: {
    channelId: "oc_abc123",
    id: "oc_abc123",
    metadata: {},
    threadId: "om_abc123",
  },
  webhookExpected: { author: "user", id: "om_abc123", text: "reply nonce-2" },
  webhookPayload: {
    event: {
      message: {
        chat_id: "oc_abc123",
        content: JSON.stringify({ text: "reply nonce-2" }),
        message_id: "om_abc123",
        message_type: "text",
      },
    },
  },
  webhookThreadId: "oc_abc123",
  userWebhookPayload: (nonce) => ({
    event: {
      message: {
        chat_id: "oc_abc123",
        content: JSON.stringify({ text: `user ${nonce}` }),
        message_id: "om_user123",
        message_type: "text",
      },
    },
  }),
});
