import { createCipheriv, createHash, randomBytes } from "node:crypto";
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
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

function encryptFeishuPayload(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString(
    "base64",
  );
}

describe("Feishu webhook normalizer", () => {
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
    const authenticate = createFeishuWebhookAuthenticator(config, {});

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

  it("accepts unsigned encrypted URL verification only", async () => {
    const config = await createLocalMockConfig("feishu", "/feishu/webhook");
    const encryptKey = "encrypt-key";
    config.feishu!.encryptKey = encryptKey;
    const authenticate = createFeishuWebhookAuthenticator(config, {});
    const challenge = JSON.stringify({
      challenge: "challenge-token",
      type: "url_verification",
    });

    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook"),
        JSON.stringify({ encrypt: encryptFeishuPayload(JSON.parse(challenge), encryptKey) }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticate!(
        new Request("https://feishu.example.test/webhook"),
        JSON.stringify({
          encrypt: encryptFeishuPayload(
            { event: { message: { content: "{}", message_type: "text" } } },
            encryptKey,
          ),
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
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
});
