import type {
  FixtureDefinition,
  FixtureMode,
  InboundAuthor,
  ProviderConfig,
  ProviderPlatform,
} from "../config/schema.js";

export type ProviderSupportStatus = "bridge" | "planned" | "ready";

export type InboundMatchConfig = {
  author: InboundAuthor;
  nonce: "contains" | "exact" | "ignore";
  pattern?: string | undefined;
  strategy: "contains" | "exact" | "regex";
};

export type NormalizedTarget = {
  channelId?: string | undefined;
  id: string;
  metadata: Record<string, string>;
  threadId?: string | undefined;
};

export type InboundEnvelope = {
  author: Exclude<InboundAuthor, "any">;
  id: string;
  provider: string;
  raw?: unknown;
  sentAt: string;
  text: string;
  threadId: string;
};

export type ProbeResult = {
  details: string[];
  healthy: boolean;
};

export type SendResult = {
  accepted: boolean;
  messageId: string;
  threadId: string;
};

export type ProviderContext = {
  config: ProviderConfig;
  fixture: FixtureDefinition;
  manifestPath: string;
  providerId: string;
  signal?: AbortSignal | undefined;
  userName: string;
};

export type SendContext = ProviderContext & {
  mode: Extract<FixtureMode, "agent" | "roundtrip" | "send">;
  nonce: string;
  text: string;
};

export type WaitContext = ProviderContext & {
  excludeIds?: readonly string[] | undefined;
  nonce: string;
  since: string;
  threadId?: string | undefined;
  timeoutMs: number;
};

export type WatchContext = ProviderContext & {
  signal?: AbortSignal | undefined;
  since?: string;
};

export interface ProviderAdapter {
  readonly id: string;
  readonly platform: ProviderPlatform;
  readonly status: ProviderSupportStatus;
  readonly supports: readonly FixtureMode[];
  normalizeTarget(target: FixtureDefinition["target"]): NormalizedTarget;
  probe(context: ProviderContext): Promise<ProbeResult>;
  send(context: SendContext): Promise<SendResult>;
  waitForInbound(context: WaitContext): Promise<InboundEnvelope | null>;
  watch?(context: WatchContext): AsyncIterable<InboundEnvelope>;
  /** Stops external admission synchronously before cleanup drains accepted work. */
  beginCleanup?(): void;
  cleanup?(): Promise<void>;
}

export type LoopbackMessage = {
  author: {
    isMe: boolean;
    userName: string;
  };
  formatted: string;
  id: string;
  metadata: {
    dateSent: Date;
    edited: boolean;
    editedAt?: Date;
  };
  raw: {
    author: "assistant" | "user";
    id: string;
    text: string;
    threadId: string;
    timestamp: string;
  };
  text: string;
  threadId: string;
};

export type LoopbackRawMessage = {
  author: "assistant" | "user";
  id: string;
  text: string;
  threadId: string;
  timestamp: string;
};
