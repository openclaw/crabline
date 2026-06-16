import { z } from "zod";

export const FIXTURE_MODES = ["probe", "send", "roundtrip", "agent"] as const;
export const INBOUND_AUTHORS = ["assistant", "user", "system", "any"] as const;
export const INBOUND_STRATEGIES = ["contains", "exact", "regex"] as const;
export const INBOUND_NONCE_MODES = ["contains", "exact", "ignore"] as const;
export const BUILTIN_ADAPTERS = [
  "discord",
  "feishu",
  "imessage",
  "loopback",
  "matrix",
  "mattermost",
  "script",
  "slack",
  "telegram",
  "whatsapp",
  "zalo",
] as const;
export const PROVIDER_PLATFORMS = [
  "bluebubbles",
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "loopback",
  "matrix",
  "mattermost",
  "msteams",
  "nextcloudtalk",
  "nostr",
  "signal",
  "slack",
  "synologychat",
  "telegram",
  "tlon",
  "twitch",
  "webchat",
  "whatsapp",
  "zalo",
  "zalouser",
] as const;

type BuiltinAdapterName = (typeof BUILTIN_ADAPTERS)[number];
type ProviderPlatformName = (typeof PROVIDER_PLATFORMS)[number];

function inferProviderPlatform(adapter: BuiltinAdapterName): ProviderPlatformName | undefined {
  if (adapter === "script") {
    return undefined;
  }

  return adapter;
}

const TargetSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  behavior: z.enum(["agent", "echo", "sink"]).optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});

const InboundMatchSchema = z.object({
  author: z.enum(INBOUND_AUTHORS).default("assistant"),
  nonce: z.enum(INBOUND_NONCE_MODES).default("contains"),
  pattern: z.string().min(1).optional(),
  strategy: z.enum(INBOUND_STRATEGIES).default("contains"),
});

const ScriptCommandsSchema = z.object({
  probe: z.string().min(1).optional(),
  send: z.string().min(1).optional(),
  waitForInbound: z.string().min(1).optional(),
  watch: z.string().min(1).optional(),
});

const LoopbackConfigSchema = z.object({
  delayMs: z.number().int().min(0).default(25),
});

const ScriptConfigSchema = z.object({
  commands: ScriptCommandsSchema,
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional(),
});

const SlackRecorderSchema = z.object({
  path: z.string().min(1).optional(),
});

const SlackWebhookSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  path: z.string().min(1).default("/slack/events"),
  port: z.number().int().min(0).max(65_535).default(8787),
  publicUrl: z.string().url().optional(),
});

const SlackConfigSchema = z.object({
  recorder: SlackRecorderSchema.default({}),
  webhook: SlackWebhookSchema.default({
    host: "127.0.0.1",
    path: "/slack/events",
    port: 8787,
  }),
});

const DiscordRecorderSchema = z.object({
  path: z.string().min(1).optional(),
});

const DiscordWebhookSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  path: z.string().min(1).default("/discord/interactions"),
  port: z.number().int().min(0).max(65_535).default(8788),
  publicUrl: z.string().url().optional(),
});

const DiscordConfigSchema = z.object({
  applicationId: z.string().min(1).optional(),
  botToken: z.string().min(1).optional(),
  gatewayDurationMs: z.number().int().min(1000).default(180_000),
  mentionRoleIds: z.array(z.string().min(1)).optional(),
  publicKey: z.string().min(1).optional(),
  recorder: DiscordRecorderSchema.default({}),
  webhook: DiscordWebhookSchema.default({
    host: "127.0.0.1",
    path: "/discord/interactions",
    port: 8788,
  }),
});

const WhatsAppRecorderSchema = z.object({
  path: z.string().min(1).optional(),
});

const WhatsAppWebhookSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  path: z.string().min(1).default("/whatsapp/webhook"),
  port: z.number().int().min(0).max(65_535).default(8789),
  publicUrl: z.string().url().optional(),
});

const WhatsAppConfigSchema = z.object({
  accessToken: z.string().min(1).optional(),
  apiUrl: z.string().url().optional(),
  apiVersion: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
  recorder: WhatsAppRecorderSchema.default({}),
  userName: z.string().min(1).optional(),
  verifyToken: z.string().min(1).optional(),
  webhook: WhatsAppWebhookSchema.default({
    host: "127.0.0.1",
    path: "/whatsapp/webhook",
    port: 8789,
  }),
});

const TelegramLongPollingSchema = z.object({
  allowedUpdates: z.array(z.string().min(1)).optional(),
  deleteWebhook: z.boolean().optional(),
  dropPendingUpdates: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  retryDelayMs: z.number().int().min(0).optional(),
  timeout: z.number().int().min(0).optional(),
});

const TelegramRecorderSchema = z.object({
  path: z.string().min(1).optional(),
});

const TelegramWebhookSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  path: z.string().min(1).default("/telegram/webhook"),
  port: z.number().int().min(0).max(65_535).default(8790),
  publicUrl: z.string().url().optional(),
});

const TelegramConfigSchema = z.object({
  apiUrl: z.string().url().optional(),
  botToken: z.string().min(1).optional(),
  longPolling: TelegramLongPollingSchema.optional(),
  mode: z.enum(["auto", "polling", "webhook"]).default("auto"),
  recorder: TelegramRecorderSchema.default({}),
  secretToken: z.string().min(1).optional(),
  userName: z.string().min(1).optional(),
  webhook: TelegramWebhookSchema.default({
    host: "127.0.0.1",
    path: "/telegram/webhook",
    port: 8790,
  }),
});

const FeishuConfigSchema = z.object({
  appId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  recorder: z.object({ path: z.string().min(1).optional() }).default({}),
  userName: z.string().min(1).optional(),
});

const MattermostRecorderSchema = z.object({
  path: z.string().min(1).optional(),
});

const MattermostWebhookSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  path: z.string().min(1).default("/mattermost/webhook"),
  port: z.number().int().min(0).max(65_535).default(8793),
  publicUrl: z.string().url().optional(),
});

const MattermostWebsocketSchema = z.object({
  enabled: z.boolean().optional(),
  maxReconnectDelayMs: z.number().int().min(0).optional(),
  reconnectDelayMs: z.number().int().min(0).optional(),
});

const MattermostConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  botToken: z.string().min(1).optional(),
  callbackUrl: z.string().url().optional(),
  recorder: MattermostRecorderSchema.default({}),
  userName: z.string().min(1).optional(),
  webhook: MattermostWebhookSchema.default({
    host: "127.0.0.1",
    path: "/mattermost/webhook",
    port: 8793,
  }),
  websocket: MattermostWebsocketSchema.optional(),
});

const ZaloRecorderSchema = z.object({
  path: z.string().min(1).optional(),
});

const ZaloWebhookSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  path: z.string().min(1).default("/zalo/webhook"),
  port: z.number().int().min(0).max(65_535).default(8794),
  publicUrl: z.string().url().optional(),
});

const ZaloConfigSchema = z.object({
  botToken: z.string().min(1).optional(),
  recorder: ZaloRecorderSchema.default({}),
  userName: z.string().min(1).optional(),
  webhook: ZaloWebhookSchema.default({
    host: "127.0.0.1",
    path: "/zalo/webhook",
    port: 8794,
  }),
  webhookSecret: z.string().min(1).optional(),
});

const MatrixAccessTokenAuthSchema = z.object({
  accessToken: z.string().min(1),
  type: z.literal("accessToken"),
  userID: z.string().min(1).optional(),
});

const MatrixPasswordAuthSchema = z.object({
  password: z.string().min(1),
  type: z.literal("password"),
  userID: z.string().min(1).optional(),
  username: z.string().min(1),
});

const MatrixConfigSchema = z.object({
  auth: z.union([MatrixAccessTokenAuthSchema, MatrixPasswordAuthSchema]).optional(),
  baseURL: z.string().url().optional(),
  commandPrefix: z.string().min(1).optional(),
  recorder: z.object({ path: z.string().min(1).optional() }).default({}),
  recoveryKey: z.string().min(1).optional(),
  roomAllowlist: z.array(z.string().min(1)).optional(),
});

const IMessageConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  gatewayDurationMs: z.number().int().min(1000).default(180_000),
  local: z.boolean().optional(),
  recorder: z.object({ path: z.string().min(1).optional() }).default({}),
  serverUrl: z.string().url().optional(),
});

export const ProviderConfigSchema = z
  .object({
    adapter: z.enum(BUILTIN_ADAPTERS),
    capabilities: z.array(z.enum(FIXTURE_MODES)).default(["probe", "send", "roundtrip", "agent"]),
    discord: DiscordConfigSchema.optional(),
    env: z.array(z.string().min(1)).default([]),
    feishu: FeishuConfigSchema.optional(),
    imessage: IMessageConfigSchema.optional(),
    loopback: LoopbackConfigSchema.optional(),
    matrix: MatrixConfigSchema.optional(),
    mattermost: MattermostConfigSchema.optional(),
    notes: z.string().optional(),
    platform: z.enum(PROVIDER_PLATFORMS).optional(),
    slack: SlackConfigSchema.optional(),
    script: ScriptConfigSchema.optional(),
    status: z.enum(["active", "disabled", "planned"]).default("active"),
    telegram: TelegramConfigSchema.optional(),
    whatsapp: WhatsAppConfigSchema.optional(),
    zalo: ZaloConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const platform = value.platform ?? inferProviderPlatform(value.adapter);

    if (value.adapter === "script" && !value.script) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "script adapter requires a script configuration",
        path: ["script"],
      });
    }

    if (value.adapter === "script" && !value.platform) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "script adapter requires platform",
        path: ["platform"],
      });
    }

    if (value.adapter === "loopback" && platform !== "loopback") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loopback adapter must use platform=loopback",
        path: ["platform"],
      });
    }

    if (value.adapter === "slack" && platform !== "slack") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slack adapter must use platform=slack",
        path: ["platform"],
      });
    }

    if (value.adapter === "discord" && platform !== "discord") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discord adapter must use platform=discord",
        path: ["platform"],
      });
    }

    if (value.adapter === "feishu" && platform !== "feishu") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feishu adapter must use platform=feishu",
        path: ["platform"],
      });
    }

    if (value.adapter === "mattermost" && platform !== "mattermost") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mattermost adapter must use platform=mattermost",
        path: ["platform"],
      });
    }

    if (value.adapter === "whatsapp" && platform !== "whatsapp") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "whatsapp adapter must use platform=whatsapp",
        path: ["platform"],
      });
    }

    if (value.adapter === "telegram" && platform !== "telegram") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "telegram adapter must use platform=telegram",
        path: ["platform"],
      });
    }

    if (value.adapter === "matrix" && platform !== "matrix") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "matrix adapter must use platform=matrix",
        path: ["platform"],
      });
    }

    if (value.adapter === "imessage" && platform !== "imessage") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "imessage adapter must use platform=imessage",
        path: ["platform"],
      });
    }

    if (value.adapter === "zalo" && platform !== "zalo") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "zalo adapter must use platform=zalo",
        path: ["platform"],
      });
    }
  })
  .transform((value) => ({
    ...value,
    platform: value.platform ?? inferProviderPlatform(value.adapter) ?? "loopback",
  }));

export const FixtureSchema = z.object({
  accountId: z.string().min(1).optional(),
  env: z.array(z.string().min(1)).default([]),
  id: z.string().min(1),
  inboundMatch: InboundMatchSchema.default({
    author: "assistant",
    nonce: "contains",
    strategy: "contains",
  }),
  mode: z.enum(FIXTURE_MODES),
  notes: z.string().optional(),
  provider: z.string().min(1),
  retries: z.number().int().min(0).default(0),
  tags: z.array(z.string().min(1)).default([]),
  target: TargetSchema,
  timeoutMs: z.number().int().min(100).default(30_000),
});

export const ManifestSchema = z.object({
  configVersion: z.literal(1).default(1),
  fixtures: z.array(FixtureSchema).default([]),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  userName: z.string().min(1).default("crabline"),
});

export type BuiltinAdapterId = BuiltinAdapterName;
export type FixtureDefinition = z.infer<typeof FixtureSchema>;
export type FixtureMode = (typeof FIXTURE_MODES)[number];
export type InboundAuthor = (typeof INBOUND_AUTHORS)[number];
export type ManifestDefinition = z.infer<typeof ManifestSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderPlatform = ProviderPlatformName;
