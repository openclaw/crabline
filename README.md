# 🧪 crabline

![crabline banner](docs/assets/readme-banner.jpg)

Deterministic messaging-provider tests for OpenClaw.

`crabline` is config-driven, CI-friendly, and deliberately has no `openclaw` dependency. It now models the full OpenClaw messaging matrix: `bluebubbles`, `discord`, `feishu`, `googlechat`, `imessage`, `irc`, `line`, `matrix`, `mattermost`, `msteams`, `nextcloudtalk`, `nostr`, `signal`, `slack`, `synologychat`, `telegram`, `tlon`, `twitch`, `webchat`, `whatsapp`, `zalo`, `zalouser`.

This project used to be called `multipass`, but was renamed to `crabline` to avoid conflicts with Canonical Multipass.

The current shape is:

- built-in `loopback` provider for local development and contract tests
- built-in `discord` provider
- built-in `feishu` provider
- built-in `googlechat` provider
- built-in `mattermost` provider
- built-in `msteams` provider
- built-in `slack` provider
- built-in `telegram` provider
- built-in `whatsapp` provider
- built-in `zalo` provider
- adapter-backed providers for `matrix` and `imessage`
- `script` bridge for the remaining OpenClaw messaging channels
- webhook-backed recorder mode for Slack `watch` / `webhook`
- interactions-webhook + gateway-backed recorder mode for Discord
- recorder-backed watch mode for Telegram, WhatsApp, Feishu, Google Chat, Mattermost, Microsoft Teams, Zalo, Matrix, and iMessage
- nonce-based `send`, `roundtrip`, `agent`, `probe`, `run`, `watch`, `doctor`
- text output by default, stable `--json` for automation
- core provider model aligned with Vercel Chat SDK concepts

## Install

```bash
pnpm install
pnpm build
pnpm verify
```

Run locally:

```bash
pnpm dev fixtures --config fixtures/examples/crabline.example.yaml
pnpm dev roundtrip loopback-roundtrip --config fixtures/examples/crabline.example.yaml
```

## Quality Gate

Local and CI use the same gate:

```bash
pnpm verify
```

That enforces:

- `oxlint` with strict correctness/suspicious rules plus import and Vitest checks
- `tsc --noEmit` under `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Vitest coverage with global thresholds of 80% for statements, lines, and functions
- `oxfmt --check` formatting

GitHub Actions runs the same `pnpm verify` flow on pushes to `main` and pull requests, and uploads the coverage artifact.

## Config

Config file search order:

1. `--config <path>`
2. `./crabline.yaml`
3. `./crabline.yml`
4. `./crabline.json`

Top-level shape:

```yaml
configVersion: 1
userName: crabline
providers:
  provider-id:
    adapter: loopback | script | slack | discord | feishu | googlechat | mattermost | msteams | telegram | whatsapp | zalo | matrix | imessage
    platform: required only when adapter is script
fixtures:
  - id: string
    provider: string
    accountId: string?
    mode: probe | send | roundtrip | agent
    target:
      id: string
      channelId: string?
      threadId: string?
      behavior: echo | agent | sink?
    inboundMatch:
      author: assistant | user | system | any
      strategy: contains | exact | regex
      nonce: contains | exact | ignore
      pattern: string?
    timeoutMs: number
    retries: number
    tags: string[]
    env: string[]
    notes: string?
```

Provider ids are local profile names; fixtures reference them through `provider`.
Built-in adapters infer their platform from `adapter`. Script bridge providers need
`platform` so Crabline knows which OpenClaw channel they exercise. Credentials
stay in env, never in fixtures.

For per-channel secrets, external setup, and smoke CI profile guidance, see
[Channel Setup](docs/channel-setup.md).

## Support Matrix

- `ready`: `loopback`, built-in `slack`, built-in `discord`, built-in `feishu`, built-in `googlechat`, built-in `mattermost`, built-in `msteams`, built-in `telegram`, built-in `whatsapp`, built-in `zalo`, adapter-backed `matrix`, adapter-backed `imessage`
- `bridge`: `bluebubbles`, `irc`, `line`, `nextcloudtalk`, `nostr`, `signal`, `synologychat`, `tlon`, `twitch`, `webchat`, `zalouser`
- Plugin-backed in OpenClaw, available through the bridge: `line`, `nextcloudtalk`, `nostr`, `synologychat`, `tlon`, `twitch`, `zalouser`
- Recommended bridge-only path today: `bluebubbles`, `irc`, `signal`, `webchat`

Telegram notes:

- Use one bot plus one real Telegram user identity for two-way tests.
- Do not model Telegram roundtrip as bot-to-bot; Telegram bots do not receive messages from other bots, and Bot API delivery is update-queue/webhook based rather than arbitrary history fetch.
- Best operator path: DM-first, then group/topic once DM roundtrip is stable.
- For unattended automation, drive the user side with MTProto (for example Telethon), not a second bot.

Telegram provider options:

```yaml
providers:
  telegram:
    adapter: telegram
    env:
      - TELEGRAM_BOT_TOKEN
    telegram:
      mode: webhook # auto | webhook | polling
      recorder:
        path: ./.crabline/recorders/telegram.jsonl
      webhook:
        host: 127.0.0.1
        port: 8790
        path: /telegram/webhook
        publicUrl: https://example.ngrok.app/telegram/webhook # optional
```

Telegram targets use Chat SDK thread ids: `telegram:{chatId}` or `telegram:{chatId}:{messageThreadId}`. Raw `target.id` values are encoded automatically.

WhatsApp provider options:

```yaml
providers:
  whatsapp:
    adapter: whatsapp
    env:
      - WHATSAPP_ACCESS_TOKEN
      - WHATSAPP_APP_SECRET
      - WHATSAPP_PHONE_NUMBER_ID
      - WHATSAPP_VERIFY_TOKEN
    whatsapp:
      recorder:
        path: ./.crabline/recorders/whatsapp.jsonl
      webhook:
        host: 127.0.0.1
        port: 8789
        path: /whatsapp/webhook
        publicUrl: https://example.ngrok.app/whatsapp/webhook # optional
```

WhatsApp targets use Chat SDK thread ids: `whatsapp:{phoneNumberId}:{userWaId}`. Raw `target.id` values are encoded from `WHATSAPP_PHONE_NUMBER_ID` or `whatsapp.phoneNumberId`.

Feishu provider options:

```yaml
providers:
  feishu:
    adapter: feishu
    env:
      - FEISHU_APP_ID
      - FEISHU_APP_SECRET
    feishu:
      recorder:
        path: ./.crabline/recorders/feishu.jsonl
```

Feishu uses the Chat SDK Lark adapter and WebSocket transport. Targets use `lark:{chatId}:{rootId}`. Raw `oc_*` chat ids are encoded automatically; raw `ou_*` user ids are treated as DM targets.

Google Chat provider options:

```yaml
providers:
  googlechat:
    adapter: googlechat
    env:
      - GOOGLE_CHAT_CREDENTIALS
    googlechat:
      googleChatProjectNumber: "1234567890"
      recorder:
        path: ./.crabline/recorders/googlechat.jsonl
      webhook:
        host: 127.0.0.1
        port: 8792
        path: /googlechat/webhook
        publicUrl: https://example.ngrok.app/googlechat/webhook # optional
```

Google Chat raw space targets use `spaces/...` and are encoded as `gchat:spaces/...`. Thread replies use `target.channelId` plus `target.threadId`, encoded as `gchat:{spaceName}:{base64urlThreadName}`.

Mattermost provider options:

```yaml
providers:
  mattermost:
    adapter: mattermost
    env:
      - MATTERMOST_BASE_URL
      - MATTERMOST_BOT_TOKEN
    mattermost:
      recorder:
        path: ./.crabline/recorders/mattermost.jsonl
      webhook:
        host: 127.0.0.1
        port: 8793
        path: /mattermost/webhook
        publicUrl: https://example.ngrok.app/mattermost/webhook # optional
```

Mattermost raw channel ids are encoded as `mattermost:{base64urlChannelId}`. Thread replies use `target.channelId` plus `target.threadId`, encoded as `mattermost:{base64urlChannelId}:{base64urlRootPostId}`. User DMs can set `target.metadata.targetType: user`.

Microsoft Teams provider options:

```yaml
providers:
  msteams:
    adapter: msteams
    env:
      - TEAMS_APP_ID
      - TEAMS_APP_PASSWORD
    msteams:
      recorder:
        path: ./.crabline/recorders/msteams.jsonl
      webhook:
        host: 127.0.0.1
        port: 8791
        path: /msteams/webhook
        publicUrl: https://example.ngrok.app/msteams/webhook # optional
```

Microsoft Teams raw conversation targets require `target.metadata.serviceUrl` so Crabline can encode Chat SDK thread ids as `teams:{conversationId}:{serviceUrl}`. Encoded `teams:` ids are passed through.

Zalo provider options:

```yaml
providers:
  zalo:
    adapter: zalo
    env:
      - ZALO_BOT_TOKEN
      - ZALO_WEBHOOK_SECRET
    zalo:
      recorder:
        path: ./.crabline/recorders/zalo.jsonl
      webhook:
        host: 127.0.0.1
        port: 8794
        path: /zalo/webhook
        publicUrl: https://example.ngrok.app/zalo/webhook # optional
```

Zalo targets use Chat SDK thread ids: `zalo:{chatId}`. Raw `target.id` values are encoded automatically.

Discord provider options:

```yaml
providers:
  discord:
    adapter: discord
    env:
      - DISCORD_BOT_TOKEN
    discord:
      applicationId: "123456789012345678" # optional; auto-discovered from bot token when omitted
      publicKey: "0123456789abcdef..." # optional; auto-discovered from bot token when omitted
      recorder:
        path: ./.crabline/recorders/discord.jsonl
      webhook:
        host: 127.0.0.1
        port: 8788
        path: /discord/interactions
        publicUrl: https://example.ngrok.app/discord/interactions # optional
```

Discord fixture targeting rules:

- Guild channels: set `target.metadata.guildId` and either a raw channel id or a fully encoded `discord:guild:channel[:thread]` id.
- DMs: omit `target.metadata.guildId`; `target.id` is treated as the user id.
- Quote Discord snowflakes in YAML so they stay strings.

Discord metadata defaults to token-only setup. When `applicationId` or `publicKey` are omitted, `crabline` fetches them from Discord using the bot token on first connect.

Discord `watch` and `roundtrip` start the local interactions server plus a Discord Gateway listener. `publicUrl` is optional for local gateway-driven receive tests, but needed if you want Discord itself to hit your interactions endpoint from outside your machine.

Slack provider options:

```yaml
providers:
  slack:
    adapter: slack
    slack:
      recorder:
        path: ./.crabline/recorders/slack.jsonl
      webhook:
        host: 127.0.0.1
        port: 8787
        path: /slack/events
        publicUrl: https://example.ngrok.app/slack/events # optional but useful
```

`watch` (alias: `webhook`) starts the local Slack webhook listener and tails the recorded inbound JSONL stream. `roundtrip` and `agent` also start the webhook listener on demand, and will reuse an already-running listener on the configured port.

Matrix provider options:

```yaml
providers:
  matrix:
    adapter: matrix
    env:
      - MATRIX_BASE_URL
      - MATRIX_ACCESS_TOKEN
    matrix:
      baseURL: https://matrix.example.com
      recorder:
        path: ./.crabline/recorders/matrix.jsonl
```

iMessage provider options:

```yaml
providers:
  imessage:
    adapter: imessage
    env:
      - IMESSAGE_API_KEY
      - IMESSAGE_SERVER_URL
    imessage:
      local: false
      serverUrl: https://imessage-gateway.example.com
      recorder:
        path: ./.crabline/recorders/imessage.jsonl
```

Matrix and iMessage `watch` tail the local recorder stream. There is no webhook listener for Matrix; iMessage uses the adapter gateway listener under the hood.

## Example fixtures

See [fixtures/examples/crabline.example.yaml](fixtures/examples/crabline.example.yaml).

Full OpenClaw bridge matrix example:

[openclaw-bridge.yaml](fixtures/examples/openclaw-bridge.yaml)

Loopback:

```bash
pnpm dev roundtrip loopback-roundtrip --config fixtures/examples/crabline.example.yaml
pnpm dev agent loopback-agent --config fixtures/examples/crabline.example.yaml
```

Slack:

```bash
SLACK_BOT_TOKEN=xoxb-... \
SLACK_SIGNING_SECRET=... \
pnpm dev probe slack-agent --config fixtures/examples/crabline.example.yaml

SLACK_BOT_TOKEN=xoxb-... \
SLACK_SIGNING_SECRET=... \
pnpm dev watch slack-agent --config fixtures/examples/crabline.example.yaml
```

Discord:

```bash
DISCORD_BOT_TOKEN=... \
pnpm dev probe discord-agent --config fixtures/examples/crabline.example.yaml

DISCORD_BOT_TOKEN=... \
pnpm dev watch discord-agent --config fixtures/examples/crabline.example.yaml
```

Telegram:

```bash
TELEGRAM_BOT_TOKEN=... \
pnpm dev probe telegram-dm --config fixtures/examples/crabline.example.yaml

TELEGRAM_BOT_TOKEN=... \
pnpm dev watch telegram-dm --config fixtures/examples/crabline.example.yaml
```

For true Telegram two-way verification, point `target.id` at the dedicated human test account, not another bot.

WhatsApp:

```bash
WHATSAPP_ACCESS_TOKEN=... \
WHATSAPP_APP_SECRET=... \
WHATSAPP_PHONE_NUMBER_ID=... \
WHATSAPP_VERIFY_TOKEN=... \
pnpm dev probe whatsapp-dm --config fixtures/examples/crabline.example.yaml

WHATSAPP_ACCESS_TOKEN=... \
WHATSAPP_APP_SECRET=... \
WHATSAPP_PHONE_NUMBER_ID=... \
WHATSAPP_VERIFY_TOKEN=... \
pnpm dev watch whatsapp-dm --config fixtures/examples/crabline.example.yaml
```

Feishu:

```bash
FEISHU_APP_ID=... \
FEISHU_APP_SECRET=... \
pnpm dev probe feishu-chat --config fixtures/examples/crabline.example.yaml

FEISHU_APP_ID=... \
FEISHU_APP_SECRET=... \
pnpm dev watch feishu-chat --config fixtures/examples/crabline.example.yaml
```

Mattermost:

```bash
MATTERMOST_BASE_URL=https://mattermost.example.com \
MATTERMOST_BOT_TOKEN=... \
pnpm dev probe mattermost-channel --config fixtures/examples/crabline.example.yaml

MATTERMOST_BASE_URL=https://mattermost.example.com \
MATTERMOST_BOT_TOKEN=... \
pnpm dev watch mattermost-channel --config fixtures/examples/crabline.example.yaml
```

Microsoft Teams:

```bash
TEAMS_APP_ID=... \
TEAMS_APP_PASSWORD=... \
pnpm dev probe msteams-channel --config fixtures/examples/crabline.example.yaml

TEAMS_APP_ID=... \
TEAMS_APP_PASSWORD=... \
pnpm dev watch msteams-channel --config fixtures/examples/crabline.example.yaml
```

Google Chat:

```bash
GOOGLE_CHAT_CREDENTIALS='{"client_email":"...","private_key":"..."}' \
pnpm dev probe googlechat-space --config fixtures/examples/crabline.example.yaml

GOOGLE_CHAT_CREDENTIALS='{"client_email":"...","private_key":"..."}' \
pnpm dev watch googlechat-space --config fixtures/examples/crabline.example.yaml
```

Zalo:

```bash
ZALO_BOT_TOKEN=... \
ZALO_WEBHOOK_SECRET=... \
pnpm dev probe zalo-chat --config fixtures/examples/crabline.example.yaml

ZALO_BOT_TOKEN=... \
ZALO_WEBHOOK_SECRET=... \
pnpm dev watch zalo-chat --config fixtures/examples/crabline.example.yaml
```

Matrix:

```bash
MATRIX_BASE_URL=https://matrix.example.com \
MATRIX_ACCESS_TOKEN=... \
pnpm dev probe matrix-agent --config fixtures/examples/crabline.example.yaml

MATRIX_BASE_URL=https://matrix.example.com \
MATRIX_ACCESS_TOKEN=... \
pnpm dev watch matrix-agent --config fixtures/examples/crabline.example.yaml
```

iMessage:

```bash
IMESSAGE_SERVER_URL=https://imessage-gateway.example.com \
IMESSAGE_API_KEY=... \
pnpm dev probe imessage-agent --config fixtures/examples/crabline.example.yaml

IMESSAGE_SERVER_URL=https://imessage-gateway.example.com \
IMESSAGE_API_KEY=... \
pnpm dev watch imessage-agent --config fixtures/examples/crabline.example.yaml
```

Script bridge:

```bash
OPENCLAW_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=secret \
pnpm dev probe slack-openclaw-demo --config fixtures/examples/crabline.example.yaml
```

Full bridge matrix bootstrap:

```bash
OPENCLAW_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=secret \
pnpm dev providers --config fixtures/examples/openclaw-bridge.yaml
```

## Commands

```bash
crabline providers
crabline fixtures
crabline probe <fixture|provider>
crabline send <fixture>
crabline roundtrip <fixture>
crabline agent <fixture>
crabline run <fixture...>
crabline watch <fixture>
crabline webhook <fixture>  # alias of watch
crabline doctor
```

## Script adapter contract

`script` providers receive JSON on stdin and must emit JSON on stdout.

`probe` input:

```json
{
  "fixture": { "...": "fixture config" },
  "provider": {
    "id": "slack-openclaw",
    "manifestPath": "...",
    "config": { "...": "provider config" }
  }
}
```

`probe` output:

```json
{
  "healthy": true,
  "details": ["token ok", "channel reachable"]
}
```

`send` output:

```json
{
  "accepted": true,
  "messageId": "123",
  "threadId": "slack:C123:thread"
}
```

`waitForInbound` output:

```json
{
  "message": {
    "id": "456",
    "author": "assistant",
    "sentAt": "2026-03-13T21:00:00.000Z",
    "text": "ACK mp-demo-...",
    "threadId": "slack:C123:thread"
  }
}
```

or:

```json
{ "timeout": true }
```

## Add a provider

1. Add a configured provider instance under `providers`.
2. Use a built-in adapter when one exists; otherwise use `adapter: script` for bridge-based real E2E.
3. Set `platform` only for `adapter: script`.
4. Add one or more fixtures that point at stable demo accounts/targets.
5. Run `crabline doctor`, `crabline probe`, then `crabline run ...`.

## Current scope

- Real built-in providers: `loopback`, built-in `slack`, built-in `discord`, built-in `feishu`, built-in `googlechat`, built-in `mattermost`, built-in `msteams`, built-in `telegram`, built-in `whatsapp`, built-in `zalo`, adapter-backed `matrix`, adapter-backed `imessage`
- Real external bridge: `script` for the full OpenClaw channel matrix
- Not implemented yet: richer recorder compaction/query tooling, live-model response generation
