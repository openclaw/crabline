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

  it("requires Bot Connector auth for externally reachable webhooks", async () => {
    const config = await createLocalMockConfig("msteams", "/msteams/webhook");
    config.msteams!.webhook.host = "0.0.0.0";

    expect(() => new MsTeamsProviderAdapter("msteams", config, "crabline", { env: {} })).toThrow(
      /externally reachable webhooks require msteams\.appId/u,
    );

    config.msteams!.webhook.host = "127.0.0.1";
    config.msteams!.webhook.publicUrl = "https://bot.example.test/msteams/webhook";
    expect(() => new MsTeamsProviderAdapter("msteams", config, "crabline", { env: {} })).toThrow(
      /externally reachable webhooks require msteams\.appId/u,
    );

    config.msteams!.appId = "teams-app-id";
    expect(
      () => new MsTeamsProviderAdapter("msteams", config, "crabline", { env: {} }),
    ).not.toThrow();
  });

  it("verifies Bot Connector bearer tokens for configured app identities", async () => {
    const config = await createLocalMockConfig("msteams", "/msteams/webhook");
    config.msteams!.appId = "teams-app-id";
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now();
    const jwk = keys.publicKey.export({ format: "jwk" });
    const rotatedJwk = rotatedKeys.publicKey.export({ format: "jwk" });
    let keyFetches = 0;
    const authenticate = createMsTeamsWebhookAuthenticator(config, {
      fetch: async (input: string | URL | Request) => {
        if (String(input).includes("openidconfiguration")) {
          return Response.json(
            { jwks_uri: "https://login.example.test/keys" },
            { headers: { "cache-control": "max-age=3600" } },
          );
        }
        keyFetches += 1;
        return Response.json(
          {
            keys: [
              { ...jwk, kid: "test-key" },
              ...(keyFetches > 1 ? [{ ...rotatedJwk, kid: "rotated-key" }] : []),
            ],
          },
          { headers: { "cache-control": "max-age=3600" } },
        );
      },
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

    const rotatedHeader = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "rotated-key" }),
    ).toString("base64url");
    const rotatedSignature = sign(
      "RSA-SHA256",
      Buffer.from(`${rotatedHeader}.${payload}`),
      rotatedKeys.privateKey,
    ).toString("base64url");
    await expect(
      authenticate!(
        new Request(url, {
          headers: {
            authorization: `Bearer ${rotatedHeader}.${payload}.${rotatedSignature}`,
          },
        }),
        body,
      ),
    ).resolves.toBeUndefined();
    expect(keyFetches).toBe(2);

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

    const caseMismatchedBody = JSON.stringify({
      ...JSON.parse(body),
      serviceUrl: "https://smba.trafficmanager.net/EMEA/",
    });
    await expect(
      authenticate!(
        new Request(url, {
          headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
        }),
        caseMismatchedBody,
      ),
    ).resolves.toMatchObject({ status: 401 });

    const missingChannelBody = JSON.stringify({
      ...JSON.parse(body),
      channelId: undefined,
    });
    await expect(
      authenticate!(
        new Request(url, {
          headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
        }),
        missingChannelBody,
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
