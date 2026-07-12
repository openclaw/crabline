import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMsTeamsWebhookAuthenticator,
  MsTeamsProviderAdapter,
  normalizeMsTeamsWebhookPayload,
} from "../src/providers/builtin/msteams.js";
import {
  createLocalMockConfig,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

const conversationId = "a:opaque-conversation-id";
describe("Microsoft Teams webhook authentication", () => {
  it("rejects non-message activities", () => {
    expect(() => normalizeMsTeamsWebhookPayload({ type: "conversationUpdate" })).toThrow(
      /type=message/u,
    );
  });

  it("verifies Bot Connector bearer tokens for configured app identities", async () => {
    const config = await createLocalMockConfig("msteams", "/msteams/webhook");
    config.msteams!.appId = "teams-app-id";
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now();
    const jwk = keys.publicKey.export({ format: "jwk" });
    const authenticate = createMsTeamsWebhookAuthenticator(config, {
      fetch: async (input: string | URL | Request) =>
        String(input).includes("openidconfiguration")
          ? Response.json({ jwks_uri: "https://login.example.test/keys" })
          : Response.json({ keys: [{ ...jwk, kid: "test-key" }] }),
      now: () => now,
    });
    expect(authenticate).toBeDefined();
    const serviceUrl = "https://smba.trafficmanager.net/emea/";
    const body = JSON.stringify({
      channelId: "msteams",
      conversation: { id: conversationId },
      from: { role: "user" },
      id: "teams-auth",
      serviceUrl,
      text: "authenticated",
      type: "message",
    });

    const url = "https://bot.example.test/msteams/webhook";
    expect((await authenticate!(new Request(url), body))?.status).toBe(401);

    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        aud: "teams-app-id",
        exp: Math.floor(now / 1000) + 60,
        iss: "https://api.botframework.com",
        serviceurl: serviceUrl,
      }),
    ).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      keys.privateKey,
    ).toString("base64url");
    await expect(
      authenticate!(
        new Request(url, {
          headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
        }),
        body,
      ),
    ).resolves.toBeUndefined();

    const mismatchedPayload = Buffer.from(
      JSON.stringify({
        aud: "teams-app-id",
        exp: Math.floor(now / 1000) + 60,
        iss: "https://api.botframework.com",
        serviceurl: "https://smba.trafficmanager.net/amer/",
      }),
    ).toString("base64url");
    const mismatchedSignature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${mismatchedPayload}`),
      keys.privateKey,
    ).toString("base64url");
    await expect(
      authenticate!(
        new Request(url, {
          headers: {
            authorization: `Bearer ${header}.${mismatchedPayload}.${mismatchedSignature}`,
          },
        }),
        body,
      ),
    ).resolves.toMatchObject({ status: 401 });
  });
});

runLocalMockProviderContract({
  Adapter: MsTeamsProviderAdapter,
  endpointPath: "/msteams/webhook",
  expectedChannelId: conversationId,
  invalidTargets: [{ id: "", metadata: {} }],
  platform: "msteams",
  target: { id: conversationId, metadata: {} },
  webhookExpected: { author: "user", id: "teams-activity-1", text: "reply nonce-2" },
  webhookPayload: {
    conversation: { id: conversationId },
    from: { role: "user" },
    id: "teams-activity-1",
    text: "reply nonce-2",
    type: "message",
  },
  webhookThreadId: conversationId,
});
