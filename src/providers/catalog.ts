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
    notes: "Built-in local reference mock for development and tests.",
    platform: "loopback",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry(
    "bluebubbles",
    "OpenClaw channel via script bridge. Recommended iMessage path.",
  ),
  {
    notes: "Built-in local Discord mock with interactions webhook shape.",
    platform: "discord",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in local Feishu/Lark mock.",
    platform: "feishu",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in local Google Chat mock.",
    platform: "googlechat",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in local iMessage mock.",
    platform: "imessage",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("irc", "OpenClaw channel via script bridge."),
  createBridgeEntry("line", "OpenClaw plugin channel via script bridge."),
  {
    notes: "Built-in local Matrix mock.",
    platform: "matrix",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in local Mattermost mock.",
    platform: "mattermost",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in local Microsoft Teams mock.",
    platform: "msteams",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("nextcloudtalk", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("nostr", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry(
    "signal",
    "OpenClaw channel via script bridge; native local provider server available.",
  ),
  {
    notes: "Built-in local Slack mock with events webhook shape.",
    platform: "slack",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("synologychat", "OpenClaw plugin channel via script bridge."),
  {
    notes: "Built-in local Telegram mock with Bot API-style webhook shape.",
    platform: "telegram",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("tlon", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("twitch", "OpenClaw plugin channel via script bridge."),
  createBridgeEntry("webchat", "OpenClaw web channel via script bridge."),
  {
    notes: "Built-in local WhatsApp mock with Business webhook and Baileys WebSocket shapes.",
    platform: "whatsapp",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  {
    notes: "Built-in local Zalo mock.",
    platform: "zalo",
    status: "ready",
    supports: COMMON_BRIDGE_SUPPORT,
  },
  createBridgeEntry("zalouser", "OpenClaw plugin personal-account channel via script bridge."),
] as const satisfies readonly CatalogEntry[];
