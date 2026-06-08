import type { NormalizedTarget } from "../providers/types.js";
import type {
  ChannelActor,
  ChannelAttachment,
  ChannelConversation,
  ChannelDriverMetadata,
  ChannelNativeAction,
} from "./types.js";
import { LocalChannelUpstream } from "./local-upstream.js";

export const TELEGRAM_LOCAL_DRIVER_ID = "telegram-local-v1" as const;

export const TELEGRAM_LOCAL_DRIVER_METADATA = {
  capabilities: [
    {
      assertions: [
        "inbound user message is recorded with Telegram chat metadata",
        "outbound assistant message is recorded in the same DM transcript",
      ],
      id: "telegram.dm.text",
      notes: "Direct-message text turn with source-visible transcript assertions.",
      status: "covered",
    },
    {
      assertions: [
        "group messages preserve chat id",
        "mention metadata can be asserted without changing the target channel",
      ],
      id: "telegram.group.mention",
      notes: "Group mention semantics for routing and reply isolation.",
      status: "covered",
    },
    {
      assertions: [
        "forum topic id is preserved separately from group id",
        "replies stay in the selected topic transcript",
      ],
      id: "telegram.group.topic",
      notes: "Forum topic/thread identity for group conversations.",
      status: "covered",
    },
    {
      assertions: [
        "inline button callback payload is represented as a native action",
        "action acknowledgements can be asserted independently of model output",
      ],
      id: "telegram.action.inline_button",
      notes: "Native approval/action event shape.",
      status: "covered",
    },
    {
      assertions: [
        "media kind and provider file id are preserved",
        "media assertions do not require downloading binary payloads",
      ],
      id: "telegram.media.metadata",
      notes: "Media/location metadata placeholder coverage.",
      status: "covered",
    },
    {
      assertions: ["connection events appear in the transcript with Telegram driver metadata"],
      id: "telegram.connection.reconnect",
      notes: "Reconnect marker for future Gateway recovery assertions.",
      status: "covered",
    },
  ],
  channel: "telegram",
  channelLive: false,
  deterministic: true,
  driverId: TELEGRAM_LOCAL_DRIVER_ID,
  eventKinds: ["message", "action", "connection", "delivery"],
  notes: "Deterministic local Telegram upstream shim for OpenClaw QA Lab channel assertions.",
  status: "ready",
} as const satisfies ChannelDriverMetadata;

export class TelegramLocalChannelDriver extends LocalChannelUpstream {
  constructor() {
    super(TELEGRAM_LOCAL_DRIVER_METADATA);
  }

  conversationFromTarget(target: NormalizedTarget): ChannelConversation {
    const kind = target.metadata.chatType === "group" ? "group" : "dm";
    const id = target.channelId ?? `telegram:${kind}:${target.id}`;
    const conversation: ChannelConversation = { id, kind };

    const title = target.metadata.chatTitle;
    if (title) {
      conversation.title = title;
    }

    const topicId = target.threadId ?? target.metadata.topicId;
    if (topicId) {
      conversation.topicId = topicId;
    }

    return conversation;
  }

  createUserActor(target: NormalizedTarget): ChannelActor {
    return {
      displayName: target.metadata.userName ?? target.metadata.fromName,
      id: target.metadata.userId ?? target.id,
      isBot: false,
      role: "user",
    };
  }

  createAssistantActor(botUserName: string): ChannelActor {
    return {
      displayName: botUserName,
      id: botUserName,
      isBot: true,
      role: "assistant",
    };
  }

  createMediaAttachment(target: NormalizedTarget): ChannelAttachment | null {
    const mediaKind = target.metadata.mediaKind;
    if (!isTelegramMediaKind(mediaKind)) {
      return null;
    }

    return {
      id: target.metadata.fileId ?? "telegram-local-file",
      kind: mediaKind,
      metadata: {
        fileId: target.metadata.fileId ?? "telegram-local-file",
        mimeType: target.metadata.mimeType ?? "application/octet-stream",
      },
    };
  }

  createNativeAction(target: NormalizedTarget): ChannelNativeAction | null {
    const actionType = target.metadata.actionType;
    if (actionType !== "button" && actionType !== "command" && actionType !== "reaction") {
      return null;
    }

    return {
      id: target.metadata.actionId ?? `${TELEGRAM_LOCAL_DRIVER_ID}:action`,
      label: target.metadata.actionLabel,
      payload: target.metadata.actionPayload ?? "crabline:approval",
      type: actionType,
    };
  }
}

function isTelegramMediaKind(value: string | undefined): value is ChannelAttachment["kind"] {
  return (
    value === "document" ||
    value === "image" ||
    value === "location" ||
    value === "sticker" ||
    value === "voice"
  );
}
