import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUILTIN_ADAPTERS, ManifestSchema } from "../src/config/schema.js";
import { OPENCLAW_SUPPORT_CATALOG } from "../src/providers/catalog.js";

describe("channel setup contracts", () => {
  it("ships a schema-valid example covering every built-in adapter", async () => {
    const manifest = ManifestSchema.parse(
      parse(await fs.readFile("fixtures/examples/crabline.example.yaml", "utf8")),
    );
    const exampleAdapters = Object.values(manifest.providers)
      .map((provider) => provider.adapter)
      .toSorted();
    const builtinAdapters = BUILTIN_ADAPTERS.filter((adapter) => adapter !== "script").toSorted();

    expect(exampleAdapters).toEqual(builtinAdapters);

    const targetId = manifest.fixtures.find((fixture) => fixture.provider === "mattermost")?.target
      .id;
    expect(targetId).toMatch(/^[a-z0-9]{26}$/u);
  });

  it("keeps documented support lists synchronized with schema and catalog", async () => {
    const [readme, channelSetup] = await Promise.all([
      fs.readFile("README.md", "utf8"),
      fs.readFile("docs/channel-setup.md", "utf8"),
    ]);
    const readmeBuiltinSection = readme.slice(
      readme.indexOf("The built-in providers are:"),
      readme.indexOf("The `script` adapter"),
    );
    const documentedBuiltinAdapters = Array.from(
      readmeBuiltinSection.matchAll(/^- `([^`]+)`$/gmu),
      (match) => match[1],
    ).toSorted();
    const documentedCatalog = Array.from(
      channelSetup.matchAll(/^\| `([^`]+)`\s+\| `(ready|bridge)`\s+\|$/gmu),
      (match) => ({ platform: match[1]!, status: match[2]! }),
    ).toSorted((left, right) => left.platform.localeCompare(right.platform));
    const expectedCatalog = OPENCLAW_SUPPORT_CATALOG.map(({ platform, status }) => ({
      platform,
      status,
    })).toSorted((left, right) => left.platform.localeCompare(right.platform));

    expect(documentedBuiltinAdapters).toEqual(
      BUILTIN_ADAPTERS.filter((adapter) => adapter !== "script").toSorted(),
    );
    expect(documentedCatalog).toEqual(expectedCatalog);
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
    const matrixSection = channelSetup.slice(
      channelSetup.indexOf("### Matrix"),
      channelSetup.indexOf("Slack:"),
    );
    expect(matrixSection).toContain("`endpoints.adminInboundUrl`");
    expect(matrixSection).toContain("`adminToken`");
    expect(matrixSection).toContain("`X-Crabline-Admin-Token`");
  });
});
