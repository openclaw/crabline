import { describe, expect, it } from "vitest";
import { CrablineError } from "../src/core/errors.js";
import { requireExternalWebhookAuthentication } from "../src/providers/builtin/external-webhook-auth.js";

const base = {
  provider: "Example",
  requirement: "example.signingSecret",
};

describe("external webhook authentication policy", () => {
  it("requires authentication before exposing webhook ingress", () => {
    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: false,
        webhook: { host: "0.0.0.0" },
      }),
    ).toThrow(/externally reachable webhooks require example\.signingSecret/u);
  });

  it("requires an HTTPS public URL for authenticated external ingress", () => {
    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        webhook: { host: "0.0.0.0" },
      }),
    ).toThrow(/public callback URL with HTTPS/u);

    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        authenticatedIngressUrls: ["http://hooks.example.test/events"],
        webhook: { host: "0.0.0.0" },
      }),
    ).toThrow(/require HTTPS/u);

    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        authenticatedIngressUrls: ["https://hooks.example.test/events"],
        webhook: {
          host: "127.0.0.1",
          publicUrl: "http://hooks.example.test/secondary",
        },
      }),
    ).toThrow(/require HTTPS/u);

    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        webhook: {
          host: "127.0.0.1",
          publicUrl: "http://hooks.example.test/events",
        },
      }),
    ).toThrow(/require HTTPS/u);
  });

  it("classifies malformed public callback URLs as configuration errors", () => {
    let failure: unknown;
    try {
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        webhook: { host: "0.0.0.0", publicUrl: "not a URL" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CrablineError);
    expect(failure).toMatchObject({
      kind: "config",
      message: "Example public callback URL is invalid.",
    });
  });

  it("allows HTTPS frontends and loopback-local HTTP", () => {
    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        webhook: {
          host: "0.0.0.0",
          publicUrl: "https://hooks.example.test/events",
        },
      }),
    ).not.toThrow();

    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        authenticatedIngressUrls: ["https://hooks.example.test/events"],
        webhook: { host: "0.0.0.0" },
      }),
    ).not.toThrow();

    for (const publicUrl of [
      "http://127.0.0.1:8787/events",
      "http://localhost:8787/events",
      "http://[::1]:8787/events",
    ]) {
      expect(() =>
        requireExternalWebhookAuthentication({
          ...base,
          authenticated: true,
          webhook: { host: "127.0.0.1", publicUrl },
        }),
      ).not.toThrow();
    }

    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: true,
        authenticatedIngressUrls: ["http://localhost:8787/primary"],
        webhook: {
          host: "127.0.0.1",
          publicUrl: "http://127.0.0.1:8787/secondary",
        },
      }),
    ).not.toThrow();
  });

  it("allows unauthenticated ingress only when it stays on loopback", () => {
    expect(() =>
      requireExternalWebhookAuthentication({
        ...base,
        authenticated: false,
        webhook: { host: "localhost" },
      }),
    ).not.toThrow();
  });
});
