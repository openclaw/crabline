import { CrablineError } from "../../core/errors.js";
import { isLoopbackHost } from "../../servers/http.js";

type WebhookConfig = {
  host?: string | undefined;
  publicUrl?: string | undefined;
};

export function requireExternalWebhookAuthentication(params: {
  authenticated: boolean;
  authenticatedIngressUrls?: readonly string[] | undefined;
  provider: string;
  requirement: string;
  webhook: WebhookConfig | undefined;
}): void {
  const host = params.webhook?.host ?? "127.0.0.1";
  const hostIsLoopback = isLoopbackHost(host);
  const publicUrls = [
    ...(params.authenticatedIngressUrls ?? []),
    ...(params.webhook?.publicUrl ? [params.webhook.publicUrl] : []),
  ];
  const callbackUrls = publicUrls.map((publicUrl) => {
    try {
      const url = new URL(publicUrl);
      return {
        isLoopback: hostIsLoopback && isLoopbackHost(url.hostname),
        url,
      };
    } catch (error) {
      throw new CrablineError(`${params.provider} public callback URL is invalid.`, {
        cause: error,
        kind: "config",
      });
    }
  });
  const externallyReachable =
    !hostIsLoopback || callbackUrls.some((callbackUrl) => !callbackUrl.isLoopback);
  if (externallyReachable && !params.authenticated) {
    throw new CrablineError(
      `${params.provider} externally reachable webhooks require ${params.requirement}.`,
      { kind: "config" },
    );
  }
  if (!externallyReachable) {
    return;
  }
  if (publicUrls.length === 0) {
    throw new CrablineError(
      `${params.provider} authenticated external webhooks require a public callback URL with HTTPS.`,
      { kind: "config" },
    );
  }

  for (const callbackUrl of callbackUrls) {
    const safeLoopbackHttp = callbackUrl.url.protocol === "http:" && callbackUrl.isLoopback;
    if (callbackUrl.url.protocol !== "https:" && !safeLoopbackHttp) {
      throw new CrablineError(
        `${params.provider} authenticated external webhooks require HTTPS; plain HTTP is allowed only for loopback-local ingress.`,
        { kind: "config" },
      );
    }
  }
}
