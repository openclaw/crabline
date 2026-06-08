import type {
  ChannelActor,
  ChannelAttachment,
  ChannelConversation,
  ChannelDriverMetadata,
  ChannelNativeAction,
  ChannelTranscriptEntry,
  ChannelTranscriptKind,
} from "./types.js";

export type IngestChannelEventInput = {
  action?: ChannelNativeAction | undefined;
  actor: ChannelActor;
  attachments?: ChannelAttachment[] | undefined;
  conversation: ChannelConversation;
  kind?: ChannelTranscriptKind | undefined;
  raw?: Record<string, unknown> | undefined;
  replyToId?: string | undefined;
  sentAt?: string | undefined;
  text?: string | undefined;
};

export type RecordChannelActionInput = {
  action?: ChannelNativeAction | undefined;
  actor: ChannelActor;
  attachments?: ChannelAttachment[] | undefined;
  conversation: ChannelConversation;
  kind?: ChannelTranscriptKind | undefined;
  raw?: Record<string, unknown> | undefined;
  replyToId?: string | undefined;
  sentAt?: string | undefined;
  text?: string | undefined;
};

export class LocalChannelUpstream {
  readonly metadata: ChannelDriverMetadata;

  readonly #transcript: ChannelTranscriptEntry[] = [];
  #sequence = 0;

  constructor(metadata: ChannelDriverMetadata) {
    this.metadata = metadata;
  }

  ingestEvent(input: IngestChannelEventInput): ChannelTranscriptEntry {
    return this.#append("inbound", input);
  }

  recordAction(input: RecordChannelActionInput): ChannelTranscriptEntry {
    return this.#append("outbound", input);
  }

  listTranscript(conversation?: ChannelConversation): ChannelTranscriptEntry[] {
    if (!conversation) {
      return [...this.#transcript];
    }

    return this.#transcript.filter(
      (entry) =>
        entry.conversation.id === conversation.id &&
        entry.conversation.topicId === conversation.topicId,
    );
  }

  listSince(params: {
    conversation: ChannelConversation;
    direction?: "inbound" | "outbound" | undefined;
    since?: string | undefined;
  }): ChannelTranscriptEntry[] {
    const sinceTime = params.since ? new Date(params.since).getTime() : Number.NEGATIVE_INFINITY;
    return this.listTranscript(params.conversation).filter((entry) => {
      if (params.direction && entry.direction !== params.direction) {
        return false;
      }
      return new Date(entry.sentAt).getTime() >= sinceTime;
    });
  }

  #append(
    direction: "inbound" | "outbound",
    input: IngestChannelEventInput | RecordChannelActionInput,
  ): ChannelTranscriptEntry {
    this.#sequence += 1;
    const id = `${this.metadata.driverId}:event:${this.#sequence}`;
    const entry: ChannelTranscriptEntry = {
      actor: input.actor,
      attachments: input.attachments ?? [],
      channel: this.metadata.channel,
      conversation: input.conversation,
      direction,
      driverId: this.metadata.driverId,
      id,
      kind: input.kind ?? "message",
      raw: input.raw ?? {},
      sentAt: input.sentAt ?? new Date(1_767_225_600_000 + this.#sequence).toISOString(),
      text: input.text ?? "",
    };

    if (input.action) {
      entry.action = input.action;
    }
    if (input.replyToId) {
      entry.replyToId = input.replyToId;
    }

    this.#transcript.push(entry);
    return entry;
  }
}
