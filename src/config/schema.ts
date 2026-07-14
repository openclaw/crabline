import { validateHeaderValue } from "node:http";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { isCanonicalHttpPath } from "../core/http-path.js";
import { isValidNonceFixtureId, NONCE_FIXTURE_ID_ERROR } from "../core/nonces.js";
import { inboundRegexSafetyError } from "../core/safe-regex.js";

export const FIXTURE_MODES = ["probe", "send", "roundtrip", "agent"] as const;
const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addAddress("::1", "ipv6");
LOOPBACK_ADDRESSES.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
const MAX_FIXTURE_RETRIES = 10;
const MAX_TIMER_MS = 2_147_483_647;
const TimerMsSchema = z
  .number()
  .int()
  .max(MAX_TIMER_MS, "timer duration must be at most 2147483647ms");
export const INBOUND_AUTHORS = ["assistant", "user", "system", "any"] as const;
export const INBOUND_STRATEGIES = ["contains", "exact", "regex"] as const;
export const INBOUND_NONCE_MODES = ["contains", "exact", "ignore"] as const;
export const BUILTIN_ADAPTERS = [
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "loopback",
  "matrix",
  "mattermost",
  "msteams",
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
type FixtureModeConstraintInput = {
  inboundMatch: {
    pattern?: string | undefined;
    strategy: (typeof INBOUND_STRATEGIES)[number];
  };
  mode: (typeof FIXTURE_MODES)[number];
};

export function fixtureModeValidationError(value: FixtureModeConstraintInput): string | undefined {
  if (
    value.mode === "agent" &&
    value.inboundMatch.strategy === "exact" &&
    value.inboundMatch.pattern
  ) {
    return "agent mode cannot use inboundMatch.strategy=exact with a static pattern because replies must include the generated ACK nonce";
  }
  return undefined;
}

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https");

const HttpsUrlSchema = HttpUrlSchema.refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "URL must use https");

const HeaderValueSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "secret must not be blank")
  .refine((value) => value === value.trim(), "secret must not contain surrounding whitespace")
  .refine((value) => {
    try {
      validateHeaderValue("x-crabline-secret", value);
      return true;
    } catch {
      return false;
    }
  }, "secret must be a valid HTTP header value");

const WebhookPathSchema = z
  .string()
  .min(1)
  .startsWith("/", "webhook path must start with /")
  .refine(isCanonicalHttpPath, "webhook path must be a canonical URL pathname");

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .replace(/^\[(.*)\]$/u, "$1")
    .toLowerCase()
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const family = isIP(normalized);
  return family === 4
    ? LOOPBACK_ADDRESSES.check(normalized, "ipv4")
    : family === 6
      ? LOOPBACK_ADDRESSES.check(normalized, "ipv6")
      : false;
}

function inferProviderPlatform(adapter: BuiltinAdapterName): ProviderPlatformName | undefined {
  if (adapter === "script") {
    return undefined;
  }

  return adapter;
}

const TargetSchema = z.strictObject({
  id: z.string().min(1),
  channelId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  behavior: z.enum(["agent", "echo", "sink"]).optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});

const InboundMatchSchema = z
  .strictObject({
    author: z.enum(INBOUND_AUTHORS).default("assistant"),
    nonce: z.enum(INBOUND_NONCE_MODES).default("contains"),
    pattern: z.string().min(1).optional(),
    strategy: z.enum(INBOUND_STRATEGIES).default("contains"),
  })
  .superRefine((value, ctx) => {
    if (value.strategy === "exact" && value.pattern && value.nonce !== "ignore") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inboundMatch.strategy=exact requires inboundMatch.nonce=ignore",
        path: ["nonce"],
      });
    }
    if (value.strategy !== "regex" || !value.pattern) {
      return;
    }
    try {
      RegExp(value.pattern, "u");
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inboundMatch.pattern must be a valid Unicode regular expression",
        path: ["pattern"],
      });
      return;
    }
    const safetyError = inboundRegexSafetyError(value.pattern);
    if (safetyError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inboundMatch.pattern ${safetyError}`,
        path: ["pattern"],
      });
    }
  });

const ScriptCommandSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "script command must not be blank");

const ScriptCommandsSchema = z.strictObject({
  probe: ScriptCommandSchema.optional(),
  send: ScriptCommandSchema.optional(),
  waitForInbound: ScriptCommandSchema.optional(),
  watch: ScriptCommandSchema.optional(),
});

const LoopbackConfigSchema = z.strictObject({
  delayMs: TimerMsSchema.min(0).default(25),
});

const ScriptConfigSchema = z.strictObject({
  commands: ScriptCommandsSchema,
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional(),
});

const SlackRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const SlackWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/slack/events"),
  port: z.number().int().min(0).max(65_535).default(8787),
  publicUrl: HttpUrlSchema.optional(),
});

const SlackConfigSchema = z.strictObject({
  recorder: SlackRecorderSchema.default({}),
  signingSecret: z.string().min(1).optional(),
  webhook: SlackWebhookSchema.default({
    host: "127.0.0.1",
    path: "/slack/events",
    port: 8787,
  }),
});

const DiscordRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const DiscordWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/discord/interactions"),
  port: z.number().int().min(0).max(65_535).default(8788),
  publicUrl: HttpUrlSchema.optional(),
});

const DiscordConfigSchema = z.strictObject({
  applicationId: z.string().min(1).optional(),
  botToken: z.string().min(1).optional(),
  gatewayDurationMs: TimerMsSchema.min(1000).default(180_000),
  mentionRoleIds: z.array(z.string().min(1)).optional(),
  publicKey: z.string().min(1).optional(),
  recorder: DiscordRecorderSchema.default({}),
  webhook: DiscordWebhookSchema.default({
    host: "127.0.0.1",
    path: "/discord/interactions",
    port: 8788,
  }),
});

const WhatsAppRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const WhatsAppWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/whatsapp/webhook"),
  port: z.number().int().min(0).max(65_535).default(8789),
  publicUrl: HttpUrlSchema.optional(),
});

const WhatsAppConfigSchema = z.strictObject({
  accessToken: z.string().min(1).optional(),
  apiUrl: HttpUrlSchema.optional(),
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

const MsTeamsFederatedSchema = z.strictObject({
  clientAudience: z.string().min(1).optional(),
  clientId: z.string().min(1),
});

const MsTeamsRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const MsTeamsWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/msteams/webhook"),
  port: z.number().int().min(0).max(65_535).default(8791),
  publicUrl: HttpsUrlSchema.optional(),
});

const MsTeamsConfigSchema = z.strictObject({
  apiUrl: HttpUrlSchema.optional(),
  appId: z.string().min(1).optional(),
  appPassword: z.string().min(1).optional(),
  appTenantId: z.string().min(1).optional(),
  appType: z.enum(["MultiTenant", "SingleTenant"]).optional(),
  dialogOpenTimeoutMs: TimerMsSchema.min(0).optional(),
  federated: MsTeamsFederatedSchema.optional(),
  recorder: MsTeamsRecorderSchema.default({}),
  userName: z.string().min(1).optional(),
  webhook: MsTeamsWebhookSchema.default({
    host: "127.0.0.1",
    path: "/msteams/webhook",
    port: 8791,
  }),
});

const GoogleChatCredentialsSchema = z
  .object({
    client_email: z.string().min(1),
    private_key: z.string().min(1),
    project_id: z.string().min(1).optional(),
  })
  .passthrough();

const GoogleChatRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const GoogleChatWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/googlechat/webhook"),
  port: z.number().int().min(0).max(65_535).default(8792),
  publicUrl: HttpUrlSchema.optional(),
});

const GoogleChatConfigSchema = z
  .strictObject({
    apiUrl: HttpUrlSchema.optional(),
    credentials: GoogleChatCredentialsSchema.optional(),
    disableSignatureVerification: z.boolean().optional(),
    endpointUrl: HttpUrlSchema.optional(),
    googleChatProjectNumber: z.string().min(1).optional(),
    impersonateUser: z.string().min(1).optional(),
    pubsubAudience: z.string().min(1).optional(),
    pubsubServiceAccountEmail: z.string().min(1).optional(),
    pubsubTopic: z.string().min(1).optional(),
    recorder: GoogleChatRecorderSchema.default({}),
    useApplicationDefaultCredentials: z.boolean().optional(),
    userName: z.string().min(1).optional(),
    webhook: GoogleChatWebhookSchema.default({
      host: "127.0.0.1",
      path: "/googlechat/webhook",
      port: 8792,
    }),
  })
  .superRefine((value, ctx) => {
    if (
      value.pubsubAudience &&
      !value.disableSignatureVerification &&
      !value.pubsubServiceAccountEmail &&
      !value.credentials?.client_email
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pubsubAudience requires a Pub/Sub service-account identity",
        path: ["pubsubAudience"],
      });
    }
  });

const TelegramLongPollingSchema = z.strictObject({
  allowedUpdates: z.array(z.string().min(1)).optional(),
  deleteWebhook: z.boolean().optional(),
  dropPendingUpdates: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  retryDelayMs: TimerMsSchema.min(0).optional(),
  timeout: z.number().int().min(0).optional(),
});

const TelegramRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const TelegramWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/telegram/webhook"),
  port: z.number().int().min(0).max(65_535).default(8790),
  publicUrl: HttpUrlSchema.optional(),
});

const TelegramConfigSchema = z.strictObject({
  apiUrl: HttpUrlSchema.optional(),
  botToken: z.string().min(1).optional(),
  longPolling: TelegramLongPollingSchema.optional(),
  mode: z.enum(["auto", "polling", "webhook"]).default("auto"),
  recorder: TelegramRecorderSchema.default({}),
  secretToken: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{1,256}(?![\s\S])/u,
      "Telegram secretToken must use 1-256 letters, digits, underscores, or hyphens",
    )
    .optional(),
  userName: z.string().min(1).optional(),
  webhook: TelegramWebhookSchema.default({
    host: "127.0.0.1",
    path: "/telegram/webhook",
    port: 8790,
  }),
});

const FeishuConfigSchema = z.strictObject({
  appId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  encryptKey: z.string().min(1).optional(),
  recorder: z.strictObject({ path: z.string().min(1).optional() }).default({}),
  userName: z.string().min(1).optional(),
  verificationToken: z.string().min(1).optional(),
  webhook: z
    .strictObject({
      host: z.string().min(1).default("127.0.0.1"),
      path: WebhookPathSchema.default("/feishu/webhook"),
      port: z.number().int().min(0).max(65_535).default(8795),
      publicUrl: HttpUrlSchema.optional(),
    })
    .default({
      host: "127.0.0.1",
      path: "/feishu/webhook",
      port: 8795,
    }),
});

const MattermostRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const MattermostWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/mattermost/webhook"),
  port: z.number().int().min(0).max(65_535).default(8793),
  publicUrl: HttpUrlSchema.optional(),
});

const MattermostWebsocketSchema = z.strictObject({
  enabled: z.boolean().optional(),
  maxReconnectDelayMs: TimerMsSchema.min(0).optional(),
  reconnectDelayMs: TimerMsSchema.min(0).optional(),
});

const MattermostConfigSchema = z.strictObject({
  baseUrl: HttpUrlSchema.optional(),
  botToken: z.string().min(1).optional(),
  callbackUrl: HttpUrlSchema.optional(),
  recorder: MattermostRecorderSchema.default({}),
  userName: z.string().min(1).optional(),
  webhook: MattermostWebhookSchema.default({
    host: "127.0.0.1",
    path: "/mattermost/webhook",
    port: 8793,
  }),
  webhookToken: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "webhookToken must not be blank")
    .optional(),
  websocket: MattermostWebsocketSchema.optional(),
});

const ZaloRecorderSchema = z.strictObject({
  path: z.string().min(1).optional(),
});

const ZaloWebhookSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  path: WebhookPathSchema.default("/zalo/webhook"),
  port: z.number().int().min(0).max(65_535).default(8794),
  publicUrl: HttpUrlSchema.optional(),
});

const ZaloConfigSchema = z.strictObject({
  botToken: HeaderValueSchema.optional(),
  recorder: ZaloRecorderSchema.default({}),
  userName: z.string().min(1).optional(),
  webhook: ZaloWebhookSchema.default({
    host: "127.0.0.1",
    path: "/zalo/webhook",
    port: 8794,
  }),
  webhookSecret: HeaderValueSchema.optional(),
});

const MatrixAccessTokenAuthSchema = z.strictObject({
  accessToken: z.string().min(1),
  type: z.literal("accessToken"),
  userID: z.string().min(1).optional(),
});

const MatrixPasswordAuthSchema = z.strictObject({
  password: z.string().min(1),
  type: z.literal("password"),
  userID: z.string().min(1).optional(),
  username: z.string().min(1),
});

const MatrixConfigSchema = z.strictObject({
  auth: z.union([MatrixAccessTokenAuthSchema, MatrixPasswordAuthSchema]).optional(),
  baseURL: HttpUrlSchema.optional(),
  commandPrefix: z.string().min(1).optional(),
  recorder: z.strictObject({ path: z.string().min(1).optional() }).default({}),
  recoveryKey: z.string().min(1).optional(),
  roomAllowlist: z.array(z.string().min(1)).optional(),
  webhook: z
    .strictObject({
      host: z.string().min(1).default("127.0.0.1"),
      path: WebhookPathSchema.default("/matrix/webhook"),
      port: z.number().int().min(0).max(65_535).default(8797),
      publicUrl: HttpUrlSchema.optional(),
    })
    .default({
      host: "127.0.0.1",
      path: "/matrix/webhook",
      port: 8797,
    }),
});

const IMessageConfigSchema = z.strictObject({
  apiKey: z.string().min(1).optional(),
  gatewayDurationMs: TimerMsSchema.min(1000).default(180_000),
  local: z.boolean().optional(),
  recorder: z.strictObject({ path: z.string().min(1).optional() }).default({}),
  serverUrl: HttpUrlSchema.optional(),
  webhook: z
    .strictObject({
      host: z.string().min(1).default("127.0.0.1"),
      path: WebhookPathSchema.default("/imessage/webhook"),
      port: z.number().int().min(0).max(65_535).default(8796),
      publicUrl: HttpUrlSchema.optional(),
    })
    .default({
      host: "127.0.0.1",
      path: "/imessage/webhook",
      port: 8796,
    }),
});

export const ProviderConfigSchema = z
  .strictObject({
    adapter: z.enum(BUILTIN_ADAPTERS),
    capabilities: z.array(z.enum(FIXTURE_MODES)).default(["probe", "send", "roundtrip", "agent"]),
    discord: DiscordConfigSchema.optional(),
    env: z.array(z.string().min(1)).default([]),
    feishu: FeishuConfigSchema.optional(),
    googlechat: GoogleChatConfigSchema.optional(),
    imessage: IMessageConfigSchema.optional(),
    loopback: LoopbackConfigSchema.optional(),
    matrix: MatrixConfigSchema.optional(),
    mattermost: MattermostConfigSchema.optional(),
    msteams: MsTeamsConfigSchema.optional(),
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

    for (const adapterConfigKey of BUILTIN_ADAPTERS) {
      if (adapterConfigKey === value.adapter || value[adapterConfigKey] === undefined) {
        continue;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          value.adapter === "script"
            ? `script adapter cannot use ${adapterConfigKey} configuration; configure provider behavior through script.commands`
            : `${adapterConfigKey} configuration requires adapter=${adapterConfigKey}, got adapter=${value.adapter}`,
        path: [adapterConfigKey],
      });
    }

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

    if (value.adapter === "script" && value.status === "active" && value.script) {
      const requiredCommands = new Set<"probe" | "send" | "waitForInbound">();
      for (const capability of value.capabilities) {
        if (capability === "probe") {
          requiredCommands.add("probe");
        }
        if (capability === "send" || capability === "roundtrip" || capability === "agent") {
          requiredCommands.add("send");
        }
        if (capability === "roundtrip" || capability === "agent") {
          requiredCommands.add("waitForInbound");
        }
      }

      for (const command of requiredCommands) {
        if (!value.script.commands[command]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `active script provider requires script.commands.${command} for its declared capabilities`,
            path: ["script", "commands", command],
          });
        }
      }
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

    if (value.adapter === "googlechat" && platform !== "googlechat") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "googlechat adapter must use platform=googlechat",
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

    if (value.adapter === "msteams" && platform !== "msteams") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "msteams adapter must use platform=msteams",
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

export const FixtureSchema = z
  .strictObject({
    accountId: z.string().min(1).optional(),
    env: z.array(z.string().min(1)).default([]),
    id: z.string().min(1).refine(isValidNonceFixtureId, NONCE_FIXTURE_ID_ERROR),
    inboundMatch: InboundMatchSchema.default({
      author: "assistant",
      nonce: "contains",
      strategy: "contains",
    }),
    mode: z.enum(FIXTURE_MODES),
    notes: z.string().optional(),
    provider: z.string().min(1),
    retries: z.number().int().min(0).max(MAX_FIXTURE_RETRIES).default(0),
    tags: z.array(z.string().min(1)).default([]),
    target: TargetSchema,
    timeoutMs: TimerMsSchema.min(100).default(30_000),
  })
  .superRefine((value, ctx) => {
    const validationError = fixtureModeValidationError(value);
    if (validationError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validationError,
        path: ["inboundMatch", "strategy"],
      });
    }
  });

const MANIFEST_EXTENSION_KEY_PATTERN = /^x-[a-z0-9][a-z0-9._-]*$/u;

function omitManifestExtensions(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const entries = Object.entries(value);
  const manifestEntries = entries.filter(([key]) => !MANIFEST_EXTENSION_KEY_PATTERN.test(key));
  return manifestEntries.length === entries.length ? value : Object.fromEntries(manifestEntries);
}

const StrictManifestSchema = z
  .strictObject({
    configVersion: z.literal(1).default(1),
    fixtures: z.array(FixtureSchema).default([]),
    providers: z.record(z.string().min(1), ProviderConfigSchema).default({}),
    userName: z.string().min(1).default("crabline"),
  })
  .superRefine((manifest, ctx) => {
    for (const [providerId, provider] of Object.entries(manifest.providers)) {
      if (
        provider.adapter !== "matrix" &&
        provider.adapter !== "mattermost" &&
        provider.adapter !== "imessage"
      ) {
        continue;
      }
      const webhook = provider[provider.adapter]?.webhook;
      if (webhook?.publicUrl || (webhook && !isLoopbackHost(webhook.host))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${provider.adapter} provider ${providerId} does not support external webhook ingress`,
          path: ["providers", providerId, provider.adapter, "webhook"],
        });
      }
    }

    const seenFixtureIds = new Set<string>();
    for (const [index, fixture] of manifest.fixtures.entries()) {
      if (seenFixtureIds.has(fixture.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate fixture id: ${fixture.id}`,
          path: ["fixtures", index, "id"],
        });
      }
      seenFixtureIds.add(fixture.id);

      if (!Object.hasOwn(manifest.providers, fixture.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fixture ${fixture.id} references unknown provider ${fixture.provider}`,
          path: ["fixtures", index, "provider"],
        });
        continue;
      }

      const provider = manifest.providers[fixture.provider]!;
      if (!provider.capabilities.includes(fixture.mode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fixture ${fixture.id} uses mode ${fixture.mode}, but provider ${fixture.provider} declares capabilities ${provider.capabilities.join(", ") || "(none)"}`,
          path: ["fixtures", index, "mode"],
        });
      }
    }
  });

export const ManifestSchema = z.preprocess(omitManifestExtensions, StrictManifestSchema);

export type BuiltinAdapterId = BuiltinAdapterName;
export type FixtureDefinition = z.infer<typeof FixtureSchema>;
export type FixtureMode = (typeof FIXTURE_MODES)[number];
export type InboundAuthor = (typeof INBOUND_AUTHORS)[number];
export type ManifestDefinition = z.infer<typeof ManifestSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderPlatform = ProviderPlatformName;
