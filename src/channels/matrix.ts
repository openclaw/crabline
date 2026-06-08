import type { ChannelCapabilityMatrixRow } from "./types.js";
import { TELEGRAM_LOCAL_DRIVER_ID, TELEGRAM_LOCAL_DRIVER_METADATA } from "./telegram.js";

export const LOCAL_CHANNEL_DRIVER_MATRIX = [
  ...TELEGRAM_LOCAL_DRIVER_METADATA.capabilities.map(
    (capability): ChannelCapabilityMatrixRow => ({
      capabilityId: capability.id,
      channel: "telegram",
      driverId: TELEGRAM_LOCAL_DRIVER_ID,
      notes: capability.notes,
      status: capability.status,
    }),
  ),
  {
    capabilityId: "discord.dm.text",
    channel: "discord",
    notes: "Planned local Discord upstream driver.",
    status: "planned",
  },
  {
    capabilityId: "slack.dm.text",
    channel: "slack",
    notes: "Planned local Slack upstream driver.",
    status: "planned",
  },
  {
    capabilityId: "whatsapp.dm.text",
    channel: "whatsapp",
    notes: "Planned local WhatsApp upstream driver.",
    status: "planned",
  },
] as const satisfies readonly ChannelCapabilityMatrixRow[];
