import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTERS, ManifestSchema } from "../src/config/schema.js";
import { OPENCLAW_SUPPORT_CATALOG } from "../src/providers/catalog.js";

describe("support catalog", () => {
  it("covers the full OpenClaw channel matrix without duplicates", () => {
    const platforms = OPENCLAW_SUPPORT_CATALOG.map((entry) => entry.platform);
    expect(new Set(platforms).size).toBe(platforms.length);
    expect(platforms).toContain("bluebubbles");
    expect(platforms).toContain("mattermost");
    expect(platforms).toContain("webchat");
    expect(platforms).toContain("zalouser");
    expect(OPENCLAW_SUPPORT_CATALOG.find((entry) => entry.platform === "discord")?.status).toBe(
      "ready",
    );
  });

  it("keeps ready catalog platforms equal to schema built-ins", () => {
    const readyPlatforms = OPENCLAW_SUPPORT_CATALOG.filter((entry) => entry.status === "ready")
      .map((entry) => entry.platform)
      .sort();
    const builtinPlatforms = BUILTIN_ADAPTERS.filter((adapter) => adapter !== "script").sort();

    expect(readyPlatforms).toEqual(builtinPlatforms);
  });

  it("accepts every catalog platform in the manifest schema", () => {
    const providers = Object.fromEntries(
      OPENCLAW_SUPPORT_CATALOG.map((entry) => {
        if (entry.platform === "loopback") {
          return [
            entry.platform,
            {
              adapter: "loopback",
            },
          ];
        }

        if (entry.platform === "slack") {
          return [
            entry.platform,
            {
              adapter: "slack",
              slack: {},
            },
          ];
        }

        if (entry.platform === "telegram") {
          return [
            entry.platform,
            {
              adapter: "telegram",
              telegram: {},
            },
          ];
        }

        if (entry.platform === "feishu") {
          return [
            entry.platform,
            {
              adapter: "feishu",
              feishu: {},
            },
          ];
        }

        if (entry.platform === "googlechat") {
          return [
            entry.platform,
            {
              adapter: "googlechat",
              googlechat: {},
            },
          ];
        }

        if (entry.platform === "mattermost") {
          return [
            entry.platform,
            {
              adapter: "mattermost",
              mattermost: {},
            },
          ];
        }

        if (entry.platform === "msteams") {
          return [
            entry.platform,
            {
              adapter: "msteams",
              msteams: {},
            },
          ];
        }

        if (entry.platform === "whatsapp") {
          return [
            entry.platform,
            {
              adapter: "whatsapp",
              whatsapp: {},
            },
          ];
        }

        if (entry.platform === "zalo") {
          return [
            entry.platform,
            {
              adapter: "zalo",
              zalo: {},
            },
          ];
        }

        return [
          entry.platform,
          {
            adapter: "script",
            platform: entry.platform,
            script: {
              commands: {
                probe: "probe",
                send: "send",
                waitForInbound: "wait",
              },
            },
          },
        ];
      }),
    );

    const fixtures = OPENCLAW_SUPPORT_CATALOG.map((entry) => ({
      id: `${entry.platform}-fixture`,
      mode: "probe",
      provider: entry.platform,
      target: {
        id: "target",
      },
    }));

    expect(() =>
      ManifestSchema.parse({
        configVersion: 1,
        fixtures,
        providers,
      }),
    ).not.toThrow();
  });
});
