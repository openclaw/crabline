import type { ProviderPlatform } from "../config/schema.js";

export type ChannelLiveMode = "local" | "live";
export type ChannelDirection = "inbound" | "outbound";
export type ChannelConversationKind = "dm" | "group";
export type ChannelTranscriptKind = "action" | "connection" | "delivery" | "message";
export type ChannelCapabilityStatus = "covered" | "planned" | "unsupported";

export type LocalChannelDriverId = "telegram";

export type ChannelConversation = {
  id: string;
  kind: ChannelConversationKind;
  title?: string | undefined;
  topicId?: string | undefined;
};

export type ChannelActor = {
  displayName?: string | undefined;
  id: string;
  isBot: boolean;
  role: "assistant" | "system" | "user";
};

export type ChannelAttachment = {
  id: string;
  kind: "document" | "image" | "location" | "sticker" | "voice";
  metadata: Record<string, string>;
};

export type ChannelNativeAction = {
  id: string;
  label?: string | undefined;
  payload: string;
  type: "button" | "command" | "reaction";
};

export type ChannelTranscriptEntry = {
  action?: ChannelNativeAction | undefined;
  actor: ChannelActor;
  attachments: ChannelAttachment[];
  channel: ProviderPlatform;
  conversation: ChannelConversation;
  direction: ChannelDirection;
  driverId: LocalChannelDriverId;
  id: string;
  kind: ChannelTranscriptKind;
  raw: Record<string, unknown>;
  replyToId?: string | undefined;
  sentAt: string;
  text: string;
};

export type ChannelCapability = {
  assertions: readonly string[];
  id: string;
  notes: string;
  status: ChannelCapabilityStatus;
};

export type ChannelDriverMetadata = {
  capabilities: readonly ChannelCapability[];
  channel: ProviderPlatform;
  channelLive: false;
  deterministic: true;
  driverId: LocalChannelDriverId;
  driverVersion: number;
  eventKinds: readonly ChannelTranscriptKind[];
  notes: string;
  status: "ready";
};

export type ChannelCapabilityMatrixRow = {
  capabilityId: string;
  channel: ProviderPlatform;
  driverId?: LocalChannelDriverId | undefined;
  notes: string;
  status: ChannelCapabilityStatus;
};
