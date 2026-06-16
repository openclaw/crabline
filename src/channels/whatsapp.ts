import type { NormalizedTarget } from "../providers/types.js";
import { LocalChannelUpstream } from "./local-upstream.js";
import type {
  ChannelActor,
  ChannelAttachment,
  ChannelConversation,
  ChannelDriverMetadata,
  ChannelNativeAction,
} from "./types.js";

export const WHATSAPP_LOCAL_DRIVER_ID = "whatsapp" as const;
export const WHATSAPP_LOCAL_DRIVER_VERSION = 1;

export const WHATSAPP_LOCAL_DRIVER_METADATA = {
  capabilities: [
    {
      assertions: [
        "inbound direct message is recorded with WhatsApp JID metadata",
        "outbound assistant message is recorded in the same direct chat transcript",
      ],
      id: "whatsapp.dm.text",
      notes: "Direct-message text turn with source-visible transcript assertions.",
      status: "covered",
    },
    {
      assertions: [
        "group messages preserve group JID",
        "sender JID is preserved separately from the group conversation id",
      ],
      id: "whatsapp.group.text",
      notes: "Group chat routing and sender isolation semantics.",
      status: "covered",
    },
    {
      assertions: [
        "quoted message id is preserved as reply metadata",
        "replies stay in the selected chat transcript",
      ],
      id: "whatsapp.reply.quoted",
      notes: "Quoted-message reply identity for threaded context assertions.",
      status: "covered",
    },
    {
      assertions: [
        "interactive button/list reply payload is represented as a native action",
        "action acknowledgements can be asserted independently of model output",
      ],
      id: "whatsapp.action.interactive",
      notes: "Native interactive approval/action event shape.",
      status: "covered",
    },
    {
      assertions: [
        "media kind and provider message id are preserved",
        "media assertions do not require downloading binary payloads",
      ],
      id: "whatsapp.media.metadata",
      notes: "Media metadata placeholder coverage.",
      status: "covered",
    },
    {
      assertions: ["delivery/read receipts appear in the transcript with WhatsApp driver metadata"],
      id: "whatsapp.delivery.receipt",
      notes: "Delivery receipt marker for future Gateway recovery assertions.",
      status: "covered",
    },
  ],
  channel: "whatsapp",
  channelLive: false,
  deterministic: true,
  driverId: WHATSAPP_LOCAL_DRIVER_ID,
  driverVersion: WHATSAPP_LOCAL_DRIVER_VERSION,
  eventKinds: ["message", "action", "connection", "delivery"],
  notes: "Deterministic local WhatsApp upstream shim for OpenClaw QA Lab channel assertions.",
  status: "ready",
} as const satisfies ChannelDriverMetadata;

export class WhatsAppLocalChannelDriver extends LocalChannelUpstream {
  static readonly metadata = WHATSAPP_LOCAL_DRIVER_METADATA;

  constructor() {
    super(WHATSAPP_LOCAL_DRIVER_METADATA);
  }

  conversationFromTarget(target: NormalizedTarget): ChannelConversation {
    const kind = target.metadata.chatType === "group" ? "group" : "dm";
    const id = target.channelId ?? `whatsapp:${kind}:${target.id}`;
    const conversation: ChannelConversation = { id, kind };

    const title = target.metadata.chatTitle ?? target.metadata.groupName;
    if (title) {
      conversation.title = title;
    }

    const topicId = target.threadId ?? target.metadata.quotedMessageId;
    if (topicId) {
      conversation.topicId = topicId;
    }

    return conversation;
  }

  createUserActor(target: NormalizedTarget): ChannelActor {
    return {
      displayName: target.metadata.pushName ?? target.metadata.fromName,
      id: target.metadata.senderJid ?? target.metadata.userJid ?? target.id,
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
    if (!isWhatsAppMediaKind(mediaKind)) {
      return null;
    }

    return {
      id: target.metadata.mediaMessageId ?? target.metadata.messageId ?? "whatsapp-local-media",
      kind: mediaKind,
      metadata: {
        mediaMessageId:
          target.metadata.mediaMessageId ?? target.metadata.messageId ?? "whatsapp-local-media",
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
      id: target.metadata.actionId ?? `${WHATSAPP_LOCAL_DRIVER_ID}:action`,
      label: target.metadata.actionLabel,
      payload: target.metadata.actionPayload ?? "crabline:approval",
      type: actionType,
    };
  }
}

function isWhatsAppMediaKind(value: string | undefined): value is ChannelAttachment["kind"] {
  return (
    value === "audio" ||
    value === "document" ||
    value === "image" ||
    value === "sticker" ||
    value === "video" ||
    value === "voice"
  );
}
