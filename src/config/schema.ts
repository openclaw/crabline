import { z } from "zod";

export const FIXTURE_MODES = ["probe", "send", "roundtrip", "agent"] as const;
export const INBOUND_AUTHORS = ["assistant", "user", "system", "any"] as const;
export const INBOUND_STRATEGIES = ["contains", "exact", "regex"] as const;
export const INBOUND_NONCE_MODES = ["contains", "exact", "ignore"] as const;
export const BUILTIN_ADAPTERS = [
  "discord",
  "imessage",
  "loopback",
  "matrix",
  "script",
  "slack",
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
    imessage: IMessageConfigSchema.optional(),
    loopback: LoopbackConfigSchema.optional(),
    matrix: MatrixConfigSchema.optional(),
    notes: z.string().optional(),
    platform: z.enum(PROVIDER_PLATFORMS).default("loopback"),
    slack: SlackConfigSchema.optional(),
    script: ScriptConfigSchema.optional(),
    status: z.enum(["active", "disabled", "planned"]).default("active"),
  })
  .superRefine((value, ctx) => {
    if (value.adapter === "script" && !value.script) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "script adapter requires a script configuration",
        path: ["script"],
      });
    }

    if (value.adapter === "loopback" && value.platform !== "loopback") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loopback adapter must use platform=loopback",
        path: ["platform"],
      });
    }

    if (value.adapter === "slack" && value.platform !== "slack") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slack adapter must use platform=slack",
        path: ["platform"],
      });
    }

    if (value.adapter === "discord" && value.platform !== "discord") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discord adapter must use platform=discord",
        path: ["platform"],
      });
    }

    if (value.adapter === "matrix" && value.platform !== "matrix") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "matrix adapter must use platform=matrix",
        path: ["platform"],
      });
    }

    if (value.adapter === "imessage" && value.platform !== "imessage") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "imessage adapter must use platform=imessage",
        path: ["platform"],
      });
    }
  });

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

export type BuiltinAdapterId = (typeof BUILTIN_ADAPTERS)[number];
export type FixtureDefinition = z.infer<typeof FixtureSchema>;
export type FixtureMode = (typeof FIXTURE_MODES)[number];
export type InboundAuthor = (typeof INBOUND_AUTHORS)[number];
export type ManifestDefinition = z.infer<typeof ManifestSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderPlatform = (typeof PROVIDER_PLATFORMS)[number];
