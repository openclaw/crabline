import { CrablineError } from "../../core/errors.js";
import { isLoopbackHost } from "../../servers/http.js";

type WebhookConfig = {
  host?: string | undefined;
  publicUrl?: string | undefined;
};

export function requireExternalWebhookAuthentication(params: {
  authenticated: boolean;
  authenticatedIngressUrl?: string | undefined;
  provider: string;
  requirement: string;
  webhook: WebhookConfig | undefined;
}): void {
  const host = params.webhook?.host ?? "127.0.0.1";
  const hostIsLoopback = isLoopbackHost(host);
  const publicUrl = params.authenticatedIngressUrl ?? params.webhook?.publicUrl;
  const externallyReachable = Boolean(publicUrl) || !hostIsLoopback;
  if (externallyReachable && !params.authenticated) {
    throw new CrablineError(
      `${params.provider} externally reachable webhooks require ${params.requirement}.`,
      { kind: "config" },
    );
  }
  if (!externallyReachable) {
    return;
  }
  if (!publicUrl) {
    throw new CrablineError(
      `${params.provider} authenticated external webhooks require a public callback URL with HTTPS.`,
      { kind: "config" },
    );
  }

  const url = new URL(publicUrl);
  const safeLoopbackHttp =
    url.protocol === "http:" && hostIsLoopback && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !safeLoopbackHttp) {
    throw new CrablineError(
      `${params.provider} authenticated external webhooks require HTTPS; plain HTTP is allowed only for loopback-local ingress.`,
      { kind: "config" },
    );
  }
}
