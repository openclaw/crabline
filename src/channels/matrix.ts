import type { ChannelCapabilityMatrixRow } from "./types.js";
import { LOCAL_CHANNEL_DRIVER_METADATA } from "./driver-registry.js";

export const LOCAL_CHANNEL_DRIVER_MATRIX = [
  ...LOCAL_CHANNEL_DRIVER_METADATA.flatMap((driver) =>
    driver.capabilities.map(
      (capability): ChannelCapabilityMatrixRow => ({
        capabilityId: capability.id,
        channel: driver.channel,
        driverId: driver.driverId,
        notes: capability.notes,
        status: capability.status,
      }),
    ),
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
] as const satisfies readonly ChannelCapabilityMatrixRow[];
