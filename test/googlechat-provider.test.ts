import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGoogleChatWebhookAuthenticator,
  GoogleChatProviderAdapter,
  matchesGoogleChatThread,
  normalizeGoogleChatWebhookPayload,
} from "../src/providers/builtin/googlechat.js";
import {
  createLocalMockConfig,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

function signedJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: Record<string, unknown>,
  kid = "test-key",
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

describe("Google Chat webhook authentication", () => {
  it("requires signed identity for externally reachable webhooks", async () => {
    const config = await createLocalMockConfig("googlechat", "/googlechat/webhook");
    config.googlechat!.webhook.host = "0.0.0.0";
    expect(() => new GoogleChatProviderAdapter("googlechat", config, "crabline")).toThrow(
      /externally reachable webhooks require googlechat\.endpointUrl/u,
    );

    config.googlechat!.pubsubAudience = "https://chat.example.test/googlechat/webhook";
    expect(() => new GoogleChatProviderAdapter("googlechat", config, "crabline")).toThrow(
      /Pub\/Sub service-account identity/u,
    );

    config.googlechat!.endpointUrl = "https://chat.example.test/googlechat/webhook";
    config.googlechat!.disableSignatureVerification = true;
    expect(() => new GoogleChatProviderAdapter("googlechat", config, "crabline")).toThrow(
      /signature verification enabled/u,
    );

    config.googlechat!.disableSignatureVerification = false;
    expect(() => new GoogleChatProviderAdapter("googlechat", config, "crabline")).not.toThrow();
  });

  it("verifies HTTP endpoint audience ID tokens", async () => {
    const config = await createLocalMockConfig("googlechat", "/googlechat/webhook");
    config.googlechat!.endpointUrl = "https://chat.example.test/googlechat/webhook";
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now();
    let certificateFetches = 0;
    const authenticate = createGoogleChatWebhookAuthenticator(config, {
      fetch: async () => {
        certificateFetches += 1;
        return Response.json({
          "test-key": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
          ...(certificateFetches > 1
            ? {
                "rotated-key": rotatedKeys.publicKey
                  .export({ format: "pem", type: "spki" })
                  .toString(),
              }
            : {}),
        });
      },
      now: () => now,
    });
    const body = JSON.stringify({ chat: { messagePayload: {} } });
    const signedRequest = signedJwt(keys.privateKey, {
      aud: config.googlechat!.endpointUrl,
      email: "chat@system.gserviceaccount.com",
      email_verified: true,
      exp: Math.floor(now / 1000) + 60,
      iss: "https://accounts.google.com",
    });
    await expect(
      authenticate!(
        new Request(config.googlechat!.endpointUrl, {
          headers: { authorization: `Bearer ${signedRequest}` },
        }),
        body,
      ),
    ).resolves.toBeUndefined();

    const wrongIdentity = signedJwt(keys.privateKey, {
      aud: config.googlechat!.endpointUrl,
      email: "other@example.iam.gserviceaccount.com",
      email_verified: true,
      exp: Math.floor(now / 1000) + 60,
      iss: "https://accounts.google.com",
    });
    await expect(
      authenticate!(
        new Request(config.googlechat!.endpointUrl, {
          headers: { authorization: `Bearer ${wrongIdentity}` },
        }),
        body,
      ),
    ).resolves.toMatchObject({ status: 401 });

    const rotatedRequest = signedJwt(
      rotatedKeys.privateKey,
      {
        aud: config.googlechat!.endpointUrl,
        email: "chat@system.gserviceaccount.com",
        email_verified: true,
        exp: Math.floor(now / 1000) + 60,
        iss: "https://accounts.google.com",
      },
      "rotated-key",
    );
    await expect(
      authenticate!(
        new Request(config.googlechat!.endpointUrl, {
          headers: { authorization: `Bearer ${rotatedRequest}` },
        }),
        body,
      ),
    ).resolves.toBeUndefined();
    expect(certificateFetches).toBe(2);
  });

  it("verifies configured direct webhook bearer tokens", async () => {
    const config = await createLocalMockConfig("googlechat", "/googlechat/webhook");
    config.googlechat!.endpointUrl = "https://chat.example.test/googlechat/webhook";
    config.googlechat!.googleChatProjectNumber = "1234567890";
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now();
    const authenticate = createGoogleChatWebhookAuthenticator(config, {
      fetch: async () =>
        Response.json({
          "test-key": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        }),
      now: () => now,
    });
    expect(authenticate).toBeDefined();
    const url = "https://chat.example.test/googlechat/webhook";
    const body = JSON.stringify({ chat: { messagePayload: {} } });
    expect((await authenticate!(new Request(url), body))?.status).toBe(401);

    const jwt = signedJwt(keys.privateKey, {
      aud: config.googlechat!.googleChatProjectNumber,
      exp: Math.floor(now / 1000) + 60,
      iss: "chat@system.gserviceaccount.com",
    });
    await expect(
      authenticate!(
        new Request(url, {
          headers: { authorization: `Bearer ${jwt}` },
        }),
        body,
      ),
    ).resolves.toBeUndefined();
  });

  it("defaults the Pub/Sub audience to the endpoint URL", async () => {
    const config = await createLocalMockConfig("googlechat", "/googlechat/webhook");
    config.googlechat!.endpointUrl = "https://chat.example.test/pubsub";
    config.googlechat!.pubsubServiceAccountEmail = "chat-push@example.iam.gserviceaccount.com";
    config.googlechat!.useApplicationDefaultCredentials = true;
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now();
    const authenticate = createGoogleChatWebhookAuthenticator(config, {
      fetch: async () =>
        Response.json({
          "test-key": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        }),
      now: () => now,
    });
    const chatEvent = {
      message: {
        name: "spaces/AAAABbbbCCC/messages/msg-push",
        sender: { type: "HUMAN" },
        space: { name: "spaces/AAAABbbbCCC" },
        text: "push message",
      },
    };
    const pubsubPayload = {
      message: { data: Buffer.from(JSON.stringify(chatEvent)).toString("base64") },
      subscription: "projects/example/subscriptions/chat",
    };
    const body = JSON.stringify(pubsubPayload);
    const jwt = signedJwt(keys.privateKey, {
      aud: config.googlechat!.endpointUrl,
      email: config.googlechat!.pubsubServiceAccountEmail,
      email_verified: true,
      exp: Math.floor(now / 1000) + 60,
      iss: "https://accounts.google.com",
    });

    await expect(
      authenticate!(
        new Request("https://chat.example.test/googlechat/webhook", {
          headers: { authorization: `Bearer ${jwt}` },
        }),
        body,
      ),
    ).resolves.toBeUndefined();
    expect(normalizeGoogleChatWebhookPayload(pubsubPayload)).toMatchObject({
      id: "spaces/AAAABbbbCCC/messages/msg-push",
      text: "push message",
      threadId: "spaces/AAAABbbbCCC",
    });

    const wrongIdentityJwt = signedJwt(keys.privateKey, {
      aud: config.googlechat!.endpointUrl,
      email: "other@example.iam.gserviceaccount.com",
      email_verified: true,
      exp: Math.floor(now / 1000) + 60,
      iss: "https://accounts.google.com",
    });
    await expect(
      authenticate!(
        new Request("https://chat.example.test/googlechat/webhook", {
          headers: { authorization: `Bearer ${wrongIdentityJwt}` },
        }),
        body,
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("matches native threads while waiting at space scope", async () => {
    expect(
      matchesGoogleChatThread("spaces/AAAABbbbCCC/threads/BBBBccccDDD", "spaces/AAAABbbbCCC"),
    ).toBe(true);
    expect(
      matchesGoogleChatThread("spaces/OtherSpace/threads/BBBBccccDDD", undefined, {
        channelId: "spaces/AAAABbbbCCC",
      }),
    ).toBe(false);
  });

  it.each(["e30", "%%%%", "e30=trailing"])(
    "rejects non-canonical Pub/Sub base64 data: %s",
    (data) => {
      expect(() =>
        normalizeGoogleChatWebhookPayload({
          message: { data },
          subscription: "projects/example/subscriptions/chat",
        }),
      ).toThrow(/base64-encoded JSON/u);
    },
  );

  it("rejects unbound Workspace add-on payloads and cross-space threads", () => {
    expect(() =>
      normalizeGoogleChatWebhookPayload({
        chat: {
          messagePayload: {
            message: {
              name: "spaces/AAAABbbbCCC/messages/msg-native",
              sender: { type: "HUMAN" },
              space: { name: "spaces/AAAABbbbCCC" },
              text: "native event",
              thread: { name: "spaces/AAAABbbbCCC/threads/BBBBccccDDD" },
            },
          },
        },
      }),
    ).toThrow(/unsupported without a configured deployment identity/u);

    expect(() =>
      normalizeGoogleChatWebhookPayload({
        message: {
          space: { name: "spaces/AAAABbbbCCC" },
          text: "wrong parent",
          thread: { name: "spaces/OtherSpace/threads/BBBBccccDDD" },
        },
      }),
    ).toThrow(/must belong to message\.space\.name/u);
  });
});

runLocalMockProviderContract({
  Adapter: GoogleChatProviderAdapter,
  endpointPath: "/googlechat/webhook",
  expectedChannelId: "spaces/AAAABbbbCCC",
  expectedThreadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
  platform: "googlechat",
  target: { id: "spaces/AAAABbbbCCC", metadata: {} },
  threadTarget: {
    channelId: "spaces/AAAABbbbCCC",
    id: "spaces/AAAABbbbCCC",
    metadata: {},
    threadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
  },
  webhookExpected: {
    author: "user",
    id: "spaces/AAAABbbbCCC/messages/msg-1",
    text: "reply nonce-2",
  },
  webhookPayload: {
    message: {
      name: "spaces/AAAABbbbCCC/messages/msg-1",
      sender: { type: "HUMAN" },
      space: { name: "spaces/AAAABbbbCCC" },
      text: "reply nonce-2",
      thread: { name: "spaces/AAAABbbbCCC/threads/BBBBccccDDD" },
    },
  },
  webhookThreadId: "spaces/AAAABbbbCCC/threads/BBBBccccDDD",
});
