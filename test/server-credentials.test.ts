import { afterEach, describe, expect, it } from "vitest";
import {
  startMattermostServer,
  startMatrixServer,
  startSlackServer,
  startTelegramServer,
  startWhatsAppServer,
  startZaloServer,
  type StartedCrablineServer,
} from "../src/index.js";

const servers: StartedCrablineServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("externally bound provider server credentials", () => {
  it("generates fresh provider-shaped defaults and mirrors them into env manifests", async () => {
    const first = await startServers();
    const second = await startServers();

    expect(first.mattermost.manifest.botToken).toMatch(/^[a-f0-9]{26}$/u);
    expect(first.mattermost.manifest.env.MATTERMOST_BOT_TOKEN).toBe(
      first.mattermost.manifest.botToken,
    );
    expect(second.mattermost.manifest.botToken).not.toBe(first.mattermost.manifest.botToken);

    expect(first.matrix.manifest.accessToken).toMatch(/^syt_crabline_[a-f0-9]{24}$/u);
    expect(first.matrix.manifest.env.MATRIX_ACCESS_TOKEN).toBe(first.matrix.manifest.accessToken);
    expect(first.matrix.manifest.env.MATRIX_USER_ID).toBe(first.matrix.manifest.botUserId);
    expect(second.matrix.manifest.accessToken).not.toBe(first.matrix.manifest.accessToken);

    expect(first.slack.manifest.botToken).toMatch(/^xoxb-\d{12}-\d{12}-[A-Za-z0-9_-]{24}$/u);
    expect(first.slack.manifest.signingSecret).toMatch(/^[a-f0-9]{32}$/u);
    expect(first.slack.manifest.env.SLACK_BOT_TOKEN).toBe(first.slack.manifest.botToken);
    expect(first.slack.manifest.env.SLACK_SIGNING_SECRET).toBe(first.slack.manifest.signingSecret);
    expect(second.slack.manifest.botToken).not.toBe(first.slack.manifest.botToken);
    expect(second.slack.manifest.signingSecret).not.toBe(first.slack.manifest.signingSecret);

    expect(first.telegram.manifest.botToken).toMatch(/^424242:[A-Za-z0-9_-]{35}$/u);
    expect(first.telegram.manifest.env.TELEGRAM_BOT_TOKEN).toBe(first.telegram.manifest.botToken);
    expect(second.telegram.manifest.botToken).not.toBe(first.telegram.manifest.botToken);

    expect(first.zalo.manifest.botToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.zalo.manifest.env.ZALO_BOT_TOKEN).toBe(first.zalo.manifest.botToken);
    expect(second.zalo.manifest.botToken).not.toBe(first.zalo.manifest.botToken);
  });

  it("rejects cleartext WhatsApp listeners on non-loopback hosts", async () => {
    await expect(startWhatsAppServer({ host: "0.0.0.0" })).rejects.toThrow(
      /requires a loopback host/u,
    );
  });
});

async function startServers() {
  const mattermost = await startMattermostServer({ host: "0.0.0.0" });
  const matrix = await startMatrixServer({ host: "0.0.0.0" });
  const slack = await startSlackServer({ host: "0.0.0.0" });
  const telegram = await startTelegramServer({ host: "0.0.0.0" });
  const zalo = await startZaloServer({ host: "0.0.0.0" });
  servers.push(mattermost, matrix, slack, telegram, zalo);
  return { mattermost, matrix, slack, telegram, zalo };
}
