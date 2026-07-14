import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createMsTeamsWebhookAuthenticator,
  handleMsTeamsWebhookPayload,
  MsTeamsProviderAdapter,
  normalizeMsTeamsWebhookPayload,
} from "../src/providers/builtin/msteams.js";
import {
  createLocalMockConfig,
  createProviderContext,
  runLocalMockProviderContract,
} from "./local-mock-provider-helpers.js";

const conversationId = "a:opaque-conversation-id";

function jwtForKeyLookup(claims: Record<string, unknown>, kid = "test-key"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.AA`;
}

function endpointFromDetails(details: string[]): string {
  const detail = details.find((entry) => entry.includes("http://"));
  if (!detail) {
    throw new Error(`No Microsoft Teams webhook endpoint found in ${details.join("\n")}`);
  }
  return detail.replace(/^.*?(https?:\/\/\S+)$/u, "$1");
}

describe("Microsoft Teams webhook authentication", () => {
  it("requires the native msteams activity channel", () => {
    expect(() =>
      normalizeMsTeamsWebhookPayload({
        channelId: "webchat",
        conversation: { id: conversationId },
        text: "wrong channel",
        type: "message",
      }),
    ).toThrow(/channelId=msteams/u);
  });

  it("rejects non-message activities", () => {
    expect(() => normalizeMsTeamsWebhookPayload({ type: "conversationUpdate" })).toThrow(
      /type=message/u,
    );
    expect(() =>
      normalizeMsTeamsWebhookPayload({
        message: { text: "nested", threadId: conversationId },
        type: "message",
      }),
    ).toThrow(/channelId=msteams/u);
  });

  it("accepts attachment-only messages and rejects contentless activities", () => {
    expect(
      normalizeMsTeamsWebhookPayload({
        attachments: [{ contentType: "image/png", contentUrl: "https://example.test/image.png" }],
        channelId: "msteams",
        conversation: { id: conversationId },
        type: "message",
      }),
    ).toMatchObject({
      text: "<media:image>",
      threadId: conversationId,
    });
    expect(() =>
      normalizeMsTeamsWebhookPayload({
        attachments: [{}],
        channelId: "msteams",
        conversation: { id: conversationId },
        text: " \n\t",
        type: "message",
      }),
    ).toThrow(/text or attachments/u);
  });

  it("returns the Bot Framework unsupported status for invoke activities", async () => {
    const response = handleMsTeamsWebhookPayload({
      channelId: "msteams",
      name: "task/fetch",
      type: "invoke",
      value: {},
    });

    expect(response?.status).toBe(501);
    await expect(response?.text()).resolves.toBe("");
    expect(handleMsTeamsWebhookPayload({ type: "conversationUpdate" })?.status).toBe(200);
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

    const wrongChannelBody = JSON.stringify({
      ...JSON.parse(body),
      channelId: "webchat",
    });
    await expect(
      authenticate!(
        new Request(url, {
          headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
        }),
        wrongChannelBody,
      ),
    ).resolves.toMatchObject({ status: 401 });

    const emptyEndorsementsAuthenticator = createMsTeamsWebhookAuthenticator(config, {
      fetch: async (input: string | URL | Request) =>
        String(input).includes("openidconfiguration")
          ? Response.json({ jwks_uri: "https://login.example.test/keys" })
          : Response.json({
              keys: [{ ...jwk, endorsements: [], kid: "test-key" }],
            }),
      now: () => now,
    });
    await expect(
      emptyEndorsementsAuthenticator!(
        new Request(url, {
          headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
        }),
        body,
      ),
    ).resolves.toBeUndefined();

    const differentEndorsementAuthenticator = createMsTeamsWebhookAuthenticator(config, {
      fetch: async (input: string | URL | Request) =>
        String(input).includes("openidconfiguration")
          ? Response.json({ jwks_uri: "https://login.example.test/keys" })
          : Response.json({
              keys: [{ ...jwk, endorsements: ["msteams-extra"], kid: "test-key" }],
            }),
      now: () => now,
    });
    await expect(
      differentEndorsementAuthenticator!(
        new Request(url, {
          headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
        }),
        body,
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("distinguishes Bot Connector signing infrastructure failures from invalid credentials", async () => {
    const config = await createLocalMockConfig("msteams", "/msteams/webhook");
    config.msteams!.appId = "teams-app-id";
    const now = Date.now();
    let fetches = 0;
    const authenticate = createMsTeamsWebhookAuthenticator(config, {
      fetch: async () => {
        fetches += 1;
        throw new Error("JWKS unavailable");
      },
      now: () => now,
    });
    const body = JSON.stringify({
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      type: "message",
    });
    const signedRequest = jwtForKeyLookup({
      aud: "teams-app-id",
      exp: Math.floor(now / 1000) + 60,
      iss: "https://api.botframework.com",
      serviceurl: "https://smba.trafficmanager.net/emea/",
    });
    const request = () =>
      new Request("https://bot.example.test/msteams/webhook", {
        headers: { authorization: `Bearer ${signedRequest}` },
      });

    const first = await authenticate!(request(), body);
    expect(first?.status).toBe(503);
    expect(first?.headers.get("cache-control")).toBe("no-store");
    expect(first?.headers.get("www-authenticate")).toBeNull();
    await expect(first?.text()).resolves.toBe("service unavailable");

    await expect(authenticate!(request(), body)).resolves.toMatchObject({ status: 503 });
    expect(fetches).toBe(1);
    await expect(
      authenticate!(new Request("https://bot.example.test/msteams/webhook"), body),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("treats malformed Bot Connector key material as an infrastructure failure", async () => {
    const config = await createLocalMockConfig("msteams", "/msteams/webhook");
    config.msteams!.appId = "teams-app-id";
    const now = Date.now();
    const authenticate = createMsTeamsWebhookAuthenticator(config, {
      fetch: async (input: string | URL | Request) =>
        String(input).includes("openidconfiguration")
          ? Response.json({ jwks_uri: "https://login.example.test/keys" })
          : Response.json({ keys: [{ kty: "RSA" }] }),
      now: () => now,
    });
    const serviceUrl = "https://smba.trafficmanager.net/emea/";
    const signedRequest = jwtForKeyLookup({
      aud: "teams-app-id",
      exp: Math.floor(now / 1000) + 60,
      iss: "https://api.botframework.com",
      serviceurl: serviceUrl,
    });

    await expect(
      authenticate!(
        new Request("https://bot.example.test/msteams/webhook", {
          headers: { authorization: `Bearer ${signedRequest}` },
        }),
        JSON.stringify({ channelId: "msteams", serviceUrl, type: "message" }),
      ),
    ).resolves.toMatchObject({ status: 503 });

    for (const endorsements of ["prefix-msteams-suffix", ["msteams", 1]]) {
      const malformedEndorsementsAuthenticator = createMsTeamsWebhookAuthenticator(config, {
        fetch: async (input: string | URL | Request) =>
          String(input).includes("openidconfiguration")
            ? Response.json({ jwks_uri: "https://login.example.test/keys" })
            : Response.json({ keys: [{ endorsements, kid: "test-key", kty: "RSA" }] }),
        now: () => now,
      });
      await expect(
        malformedEndorsementsAuthenticator!(
          new Request("https://bot.example.test/msteams/webhook", {
            headers: { authorization: `Bearer ${signedRequest}` },
          }),
          JSON.stringify({ channelId: "msteams", serviceUrl, type: "message" }),
        ),
      ).resolves.toMatchObject({ status: 503 });
    }
  });

  it("acknowledges authenticated non-message activities without recording them", async () => {
    const config = await createLocalMockConfig("msteams", "/msteams/webhook");
    config.msteams!.appId = "teams-app-id";
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now();
    const jwk = keys.publicKey.export({ format: "jwk" });
    const provider = new MsTeamsProviderAdapter("msteams", config, "crabline", {
      env: {},
      fetch: async (input: string | URL | Request) =>
        String(input).includes("openidconfiguration")
          ? Response.json({ jwks_uri: "https://login.example.test/keys" })
          : Response.json({ keys: [{ ...jwk, kid: "test-key" }] }),
      now: () => now,
    });
    try {
      const endpoint = endpointFromDetails(
        (
          await provider.probe(
            createProviderContext("msteams", config, {
              id: conversationId,
              metadata: {},
            }),
          )
        ).details,
      );
      const serviceUrl = "https://smba.trafficmanager.net/emea/";
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
        "base64url",
      );
      const jwtPayload = Buffer.from(
        JSON.stringify({
          aud: "teams-app-id",
          exp: Math.floor(now / 1000) + 60,
          iss: "https://api.botframework.com",
          serviceurl: serviceUrl,
        }),
      ).toString("base64url");
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${header}.${jwtPayload}`),
        keys.privateKey,
      ).toString("base64url");
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          channelId: "msteams",
          conversation: { id: conversationId },
          message: { text: "must not record", threadId: conversationId },
          serviceUrl,
          type: "conversationUpdate",
        }),
        headers: {
          authorization: `Bearer ${header}.${jwtPayload}.${signature}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(readFile(config.msteams!.recorder.path!, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await provider.cleanup();
    }
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
    channelId: "msteams",
    conversation: { id: conversationId },
    from: { role: "user" },
    id: "teams-activity-1",
    text: "reply nonce-2",
    type: "message",
  },
  webhookThreadId: conversationId,
  userWebhookPayload: (nonce) => ({
    channelId: "msteams",
    conversation: { id: conversationId },
    from: { role: "user" },
    id: "teams-user-inbound",
    text: `user ${nonce}`,
    type: "message",
  }),
});
