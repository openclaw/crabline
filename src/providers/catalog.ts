import type { FixtureMode, ProviderPlatform } from "../config/schema.js";
import type { ProviderSupportStatus } from "./types.js";

export type CatalogEntry = {
  notes: string;
  platform: ProviderPlatform;
  status: ProviderSupportStatus;
  supports: readonly FixtureMode[];
};

const COMMON_BRIDGE_SUPPORT = ["probe", "send", "roundtrip", "agent"] as const;

function createBridgeEntry(platform: ProviderPlatform, notes: string): CatalogEntry {
  return {
    notes,
    platform,
    status: "bridge",
    supports: COMMON_BRIDGE_SUPPORT,
  };
}

export const OPENCLAW_SUPPORT_CATALOG = [
  {
    notes: "Built-in local reference provider for development and tests.",
    platform: "loopback",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry(
    "bluebubbles",
    "OpenClaw channel via script bridge. Recommended iMessage path.",
  ),
  {
    notes: "Native Chat SDK adapter with interactions webhook and gateway listener.",
    platform: "discord",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("feishu", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("googlechat", "OpenClaw channel via script bridge."),
  {
    notes: "Community Chat SDK adapter for iMessage.",
    platform: "imessage",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("irc", "OpenClaw channel via script bridge."),
  createBridgeEntry("line", "OpenClaw plugin channel via script bridge."),
  {
    notes: "Community Chat SDK adapter for Matrix/Beeper sync.",
    platform: "matrix",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("mattermost", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("msteams", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("nextcloudtalk", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("nostr", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("signal", "OpenClaw channel via script bridge."),
  {
    notes: "Native Chat SDK adapter plus local recorder/webhook mode.",
    platform: "slack",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("synologychat", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry(
    "telegram",
    "OpenClaw channel via script bridge; deterministic local driver available via adapter=channel.",
  ),
  createBridgeEntry("tlon", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("twitch", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("webchat", "OpenClaw web channel via script bridge."),
  createBridgeEntry(
    "whatsapp",
    "OpenClaw channel via script bridge; deterministic local driver available via adapter=channel.",
  ),
  createBridgeEntry("zalo", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("zalouser", "OpenClaw plugin personal-account channel via script bridge."),
] as const satisfies readonly CatalogEntry[];
