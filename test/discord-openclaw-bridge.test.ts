import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  runOpenClawCrablineProviderReadiness,
  resolveOpenClawCrablineChannelDriverSelection,
  startOpenClawCrablineAdapter,
  type StartedOpenClawCrablineAdapter,
} from "../src/index.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const adapters: StartedOpenClawCrablineAdapter[] = [];
const directories: string[] = [];
const CHANNEL_ID = "135000000000000010";
const THREAD_ID = "135000000000000011";
const USER_ID = "135000000000000012";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(directories.splice(0).map(disposeTempDir));
});

describe("Discord OpenClaw bridge", () => {
  it("builds a credential-local real-plugin binding and probes native identity", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "discord" });
    adapters.push(adapter);
    if (adapter.manifest.provider !== "discord") {
      throw new Error("Expected Discord manifest.");
    }
    expect(adapter.requiredPluginIds).toEqual(["discord"]);
    expect(adapter.createProviderReadinessEnv({ EXISTING: "kept" })).toMatchObject({
      DISCORD_BOT_TOKEN: adapter.manifest.botToken,
      EXISTING: "kept",
    });
    expect(adapter.createGatewayConfig()).toMatchObject({
      channels: {
        discord: {
          applicationId: adapter.manifest.applicationId,
          dm: { enabled: true },
          dmPolicy: "open",
          enabled: true,
          groupPolicy: "open",
          guilds: { "*": { channels: { "*": { enabled: true, requireMention: false } } } },
          replyToMode: "all",
          token: adapter.manifest.botToken,
          voice: { enabled: false },
        },
      },
    });
    await expect(adapter.probe()).resolves.toMatchObject({
      bot: true,
      id: adapter.manifest.botUserId,
    });
  });

  it("translates direct, channel, and thread traffic without changing fixture mocks", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "discord" });
    adapters.push(adapter);
    expect(adapter.createAgentDelivery({ target: `dm:${USER_ID}` })).toMatchObject({
      providerTargetKey: expect.stringMatching(/^\d{17,20}$/u),
      to: `user:${USER_ID}`,
    });
    expect(adapter.createAgentDelivery({ target: `group:${CHANNEL_ID}` })).toMatchObject({
      providerTargetKey: CHANNEL_ID,
      to: `channel:${CHANNEL_ID}`,
    });
    expect(
      adapter.createAgentDelivery({ target: `thread:${CHANNEL_ID}/${THREAD_ID}` }),
    ).toMatchObject({ providerTargetKey: THREAD_ID, to: `channel:${THREAD_ID}` });

    const inbound = adapter.createInbound({
      input: {
        conversation: { id: CHANNEL_ID, kind: "group" },
        senderId: USER_ID,
        senderName: "Alice",
        text: "thread question",
        threadId: THREAD_ID,
      },
    });
    expect(inbound).toMatchObject({
      providerBody: {
        channelId: THREAD_ID,
        content: "thread question",
        parentChannelId: CHANNEL_ID,
        senderId: USER_ID,
      },
      providerTargetKey: THREAD_ID,
      threadId: THREAD_ID,
    });
  });

  it("normalizes only accepted native create-message recorder evidence", async () => {
    const adapter = await startOpenClawCrablineAdapter({ channel: "discord" });
    adapters.push(adapter);
    const targetByProviderTarget = new Map([[THREAD_ID, `thread:${CHANNEL_ID}/${THREAD_ID}`]]);
    const event = {
      accepted: true,
      body: {
        allowed_mentions: { parse: [] },
        content: "answer",
        message_reference: { message_id: "135000000000000099" },
      },
      method: "POST",
      path: `/api/v10/channels/${THREAD_ID}/messages`,
      type: "api",
    };
    expect(
      adapter.createOutboundFromRecorderEvent({ event, targetByProviderTarget }),
    ).toMatchObject({
      text: "answer",
      to: `thread:${CHANNEL_ID}/${THREAD_ID}`,
    });
    expect(
      adapter.createOutboundFromRecorderEvent({
        event: { ...event, accepted: false },
        targetByProviderTarget,
      }),
    ).toBeNull();
  });

  it("publishes validated Discord provider-readiness artifacts", async () => {
    const outputDir = await createTempDir();
    directories.push(outputDir);
    const result = await runOpenClawCrablineProviderReadiness({
      outputDir,
      selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "discord" }),
    });
    const manifest = JSON.parse(
      await fs.readFile(`${outputDir}/${result.manifestPath}`, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({ provider: "discord", version: 1 });
    const readiness = JSON.parse(
      await fs.readFile(`${outputDir}/${result.providerReadinessArtifactPath}`, "utf8"),
    ) as Record<string, unknown>;
    expect(readiness).toMatchObject({ selectedChannel: "discord", version: 2 });
  });
});
