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
    notes: "Built-in provider with interactions webhook and gateway listener.",
    platform: "discord",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in provider for Feishu/Lark.",
    platform: "feishu",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("googlechat", "OpenClaw channel via script bridge."),
  {
    notes: "Adapter-backed provider for iMessage.",
    platform: "imessage",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("irc", "OpenClaw channel via script bridge."),
  createBridgeEntry("line", "OpenClaw plugin channel via script bridge."),
  {
    notes: "Adapter-backed provider for Matrix/Beeper sync.",
    platform: "matrix",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in provider for Mattermost.",
    platform: "mattermost",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("msteams", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("nextcloudtalk", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("nostr", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("signal", "OpenClaw channel via script bridge."),
  {
    notes: "Built-in provider plus local recorder/webhook mode.",
    platform: "slack",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("synologychat", "OpenClaw plugin channel via script bridge."),
  {
    notes: "Built-in provider for Telegram Bot API.",
    platform: "telegram",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("tlon", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("twitch", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("webchat", "OpenClaw web channel via script bridge."),
  {
    notes: "Built-in provider for WhatsApp Business Cloud API.",
    platform: "whatsapp",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in provider for Zalo Bot Platform.",
    platform: "zalo",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("zalouser", "OpenClaw plugin personal-account channel via script bridge."),
] as const satisfies readonly CatalogEntry[];
