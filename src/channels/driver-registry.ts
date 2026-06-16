import type { ProviderPlatform } from "../config/schema.js";
import { LocalChannelUpstream } from "./local-upstream.js";
import { TelegramLocalChannelDriver } from "./telegram.js";
import { WhatsAppLocalChannelDriver } from "./whatsapp.js";
import type {
  ChannelActor,
  ChannelAttachment,
  ChannelConversation,
  ChannelDriverMetadata,
  ChannelNativeAction,
} from "./types.js";
import type { NormalizedTarget } from "../providers/types.js";

export type LocalChannelDriver = {
  readonly metadata: ChannelDriverMetadata;
  conversationFromTarget(target: NormalizedTarget): ChannelConversation;
  createAssistantActor(botUserName: string): ChannelActor;
  createMediaAttachment(target: NormalizedTarget): ChannelAttachment | null;
  createNativeAction(target: NormalizedTarget): ChannelNativeAction | null;
  createUserActor(target: NormalizedTarget): ChannelActor;
  ingestEvent: LocalChannelUpstream["ingestEvent"];
  listSince: LocalChannelUpstream["listSince"];
  recordAction: LocalChannelUpstream["recordAction"];
};

export const LOCAL_CHANNEL_DRIVER_METADATA = [
  TelegramLocalChannelDriver.metadata,
  WhatsAppLocalChannelDriver.metadata,
] as const;

export function createLocalChannelDriver(platform: ProviderPlatform): LocalChannelDriver | null {
  if (platform === "telegram") {
    return new TelegramLocalChannelDriver();
  }
  if (platform === "whatsapp") {
    return new WhatsAppLocalChannelDriver();
  }
  return null;
}
