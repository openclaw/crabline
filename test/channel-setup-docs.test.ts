import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ExampleManifest = {
  fixtures?: Array<{
    provider?: string;
    target?: {
      id?: string;
    };
  }>;
};

describe("channel setup contracts", () => {
  it("ships a provider-native Mattermost fixture target", async () => {
    const manifest = parse(
      await fs.readFile("fixtures/examples/crabline.example.yaml", "utf8"),
    ) as ExampleManifest;
    const targetId = manifest.fixtures?.find((fixture) => fixture.provider === "mattermost")?.target
      ?.id;

    expect(targetId).toMatch(/^[a-z0-9]{26}$/u);
  });

  it("documents native target and admin-ingress identifiers", async () => {
    const [readme, channelSetup] = await Promise.all([
      fs.readFile("README.md", "utf8"),
      fs.readFile("docs/channel-setup.md", "utf8"),
    ]);

    for (const document of [readme, channelSetup]) {
      expect(document).toContain("`U1234567890`");
      expect(document).toContain("`iMessage;-;chat-guid`");
      expect(document).toContain("`$eventid:matrix.org`");
      expect(document).toContain("exactly 26 lowercase alphanumeric");
      expect(document).toContain("`a:opaque-conversation-id`");
    }
    expect(channelSetup).toContain("optional `senderName`, `roomName`, `direct`, and `threadId`");
    expect(channelSetup).toContain("`/crabline/zalo/inbound`");
    expect(channelSetup).toContain("`X-Crabline-Admin-Token`");
  });
});
