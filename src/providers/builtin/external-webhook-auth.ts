import { CrablineError } from "../../core/errors.js";
import { isLoopbackHost } from "../../servers/http.js";

type WebhookConfig = {
  host?: string | undefined;
  publicUrl?: string | undefined;
};

export function requireExternalWebhookAuthentication(params: {
  authenticated: boolean;
  provider: string;
  requirement: string;
  webhook: WebhookConfig | undefined;
}): void {
  const host = params.webhook?.host ?? "127.0.0.1";
  const externallyReachable = Boolean(params.webhook?.publicUrl) || !isLoopbackHost(host);
  if (externallyReachable && !params.authenticated) {
    throw new CrablineError(
      `${params.provider} externally reachable webhooks require ${params.requirement}.`,
      { kind: "config" },
    );
  }
}
