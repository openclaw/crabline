# 🧪 multipass

![multipass banner](docs/assets/readme-banner.jpg)

Deterministic messaging-provider tests for OpenClaw.

`multipass` is config-driven, CI-friendly, and deliberately has no `openclaw` dependency. It now models the full OpenClaw messaging matrix: `bluebubbles`, `discord`, `feishu`, `googlechat`, `imessage`, `irc`, `line`, `matrix`, `mattermost`, `msteams`, `nextcloudtalk`, `nostr`, `signal`, `slack`, `synologychat`, `telegram`, `tlon`, `twitch`, `webchat`, `whatsapp`, `zalo`, `zalouser`.

The v1 shape is:

- built-in `loopback` provider for local development and contract tests
- native `discord` provider backed by the Chat SDK Discord adapter
- native `slack` provider backed by the Chat SDK Slack adapter
- native community adapters for `matrix` and `imessage`
- `script` bridge for the remaining OpenClaw-supported messaging channels
- webhook-backed recorder mode for Slack `watch` / `webhook`
- interactions-webhook + gateway-backed recorder mode for Discord
- recorder-backed watch mode for Matrix and iMessage
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
pnpm dev fixtures --config fixtures/examples/multipass.example.yaml
pnpm dev roundtrip loopback-roundtrip --config fixtures/examples/multipass.example.yaml
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
2. `./multipass.yaml`
3. `./multipass.yml`
4. `./multipass.json`

Top-level shape:

```yaml
configVersion: 1
userName: multipass
providers:
  local:
    adapter: loopback | script | slack | discord | matrix | imessage
    platform: see support matrix below
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

Credentials stay in env, never in fixtures.

## Support Matrix

- `ready`: `loopback`, native `slack`, native `discord`, native-community `matrix`, native-community `imessage`
- `bridge`: `bluebubbles`, `feishu`, `googlechat`, `irc`, `line`, `mattermost`, `msteams`, `nextcloudtalk`, `nostr`, `signal`, `synologychat`, `telegram`, `tlon`, `twitch`, `webchat`, `whatsapp`, `zalo`, `zalouser`
- Plugin-backed in OpenClaw, still supported through the bridge: `feishu`, `line`, `mattermost`, `msteams`, `nextcloudtalk`, `nostr`, `synologychat`, `tlon`, `twitch`, `zalo`, `zalouser`
- Recommended bridge-only path today: `bluebubbles`, `googlechat`, `irc`, `signal`, `telegram`, `webchat`, `whatsapp`

Telegram bridge notes:

- Use one bot plus one real Telegram user identity for two-way tests.
- Do not model Telegram roundtrip as bot-to-bot; Telegram bots do not receive messages from other bots, and Bot API delivery is update-queue/webhook based rather than arbitrary history fetch.
- Best operator path: DM-first, then group/topic once DM roundtrip is stable.
- For unattended automation, drive the user side with MTProto (for example Telethon), not a second bot.

Native Discord provider options:

```yaml
providers:
  discord-native:
    adapter: discord
    platform: discord
    env:
      - DISCORD_BOT_TOKEN
    discord:
      applicationId: "123456789012345678" # optional; auto-discovered from bot token when omitted
      publicKey: "0123456789abcdef..." # optional; auto-discovered from bot token when omitted
      recorder:
        path: ./.multipass/recorders/discord-native.jsonl
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

Discord metadata defaults to token-only setup. When `applicationId` or `publicKey` are omitted, `multipass` fetches them from Discord using the bot token on first connect.

Discord `watch` and `roundtrip` start the local interactions server plus a Discord Gateway listener. `publicUrl` is optional for local gateway-driven receive tests, but needed if you want Discord itself to hit your interactions endpoint from outside your machine.

Native Slack provider options:

```yaml
providers:
  slack-native:
    adapter: slack
    platform: slack
    slack:
      recorder:
        path: ./.multipass/recorders/slack-native.jsonl
      webhook:
        host: 127.0.0.1
        port: 8787
        path: /slack/events
        publicUrl: https://example.ngrok.app/slack/events # optional but useful
```

`watch` (alias: `webhook`) starts the local Slack webhook listener and tails the recorded inbound JSONL stream. `roundtrip` and `agent` also start the webhook listener on demand, and will reuse an already-running listener on the configured port.

Native Matrix provider options:

```yaml
providers:
  matrix-native:
    adapter: matrix
    platform: matrix
    env:
      - MATRIX_BASE_URL
      - MATRIX_ACCESS_TOKEN
    matrix:
      baseURL: https://matrix.example.com
      recorder:
        path: ./.multipass/recorders/matrix-native.jsonl
```

Native iMessage provider options:

```yaml
providers:
  imessage-native:
    adapter: imessage
    platform: imessage
    env:
      - IMESSAGE_API_KEY
      - IMESSAGE_SERVER_URL
    imessage:
      local: false
      serverUrl: https://imessage-gateway.example.com
      recorder:
        path: ./.multipass/recorders/imessage-native.jsonl
```

Matrix and iMessage `watch` tail the local recorder stream. There is no webhook listener for Matrix; iMessage uses the adapter gateway listener under the hood.

## Example fixtures

See [fixtures/examples/multipass.example.yaml](/Users/steipete/Projects/multipass/fixtures/examples/multipass.example.yaml).

Full OpenClaw bridge matrix example:

[openclaw-supported.yaml](/Users/steipete/Projects/multipass/fixtures/examples/openclaw-supported.yaml)

Loopback:

```bash
pnpm dev roundtrip loopback-roundtrip --config fixtures/examples/multipass.example.yaml
pnpm dev agent loopback-agent --config fixtures/examples/multipass.example.yaml
```

Native Slack:

```bash
SLACK_BOT_TOKEN=xoxb-... \
SLACK_SIGNING_SECRET=... \
pnpm dev probe slack-native-agent --config fixtures/examples/multipass.example.yaml

SLACK_BOT_TOKEN=xoxb-... \
SLACK_SIGNING_SECRET=... \
pnpm dev watch slack-native-agent --config fixtures/examples/multipass.example.yaml
```

Native Discord:

```bash
DISCORD_BOT_TOKEN=... \
pnpm dev probe discord-native-agent --config fixtures/examples/multipass.example.yaml

DISCORD_BOT_TOKEN=... \
pnpm dev watch discord-native-agent --config fixtures/examples/multipass.example.yaml
```

Telegram via OpenClaw bridge:

```bash
OPENCLAW_URL=http://127.0.0.1:8080 \
OPENCLAW_TOKEN=... \
pnpm dev roundtrip telegram-openclaw-roundtrip --config fixtures/examples/openclaw-supported.yaml
```

For true Telegram two-way verification, point `target.id` at the dedicated human test account, not another bot.

Native Matrix:

```bash
MATRIX_BASE_URL=https://matrix.example.com \
MATRIX_ACCESS_TOKEN=... \
pnpm dev probe matrix-native-agent --config fixtures/examples/multipass.example.yaml

MATRIX_BASE_URL=https://matrix.example.com \
MATRIX_ACCESS_TOKEN=... \
pnpm dev watch matrix-native-agent --config fixtures/examples/multipass.example.yaml
```

Native iMessage:

```bash
IMESSAGE_SERVER_URL=https://imessage-gateway.example.com \
IMESSAGE_API_KEY=... \
pnpm dev probe imessage-native-agent --config fixtures/examples/multipass.example.yaml

IMESSAGE_SERVER_URL=https://imessage-gateway.example.com \
IMESSAGE_API_KEY=... \
pnpm dev watch imessage-native-agent --config fixtures/examples/multipass.example.yaml
```

Script bridge:

```bash
OPENCLAW_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=secret \
pnpm dev probe slack-openclaw-demo --config fixtures/examples/multipass.example.yaml
```

Full bridge matrix bootstrap:

```bash
OPENCLAW_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=secret \
pnpm dev providers --config fixtures/examples/openclaw-supported.yaml
```

## Commands

```bash
multipass providers
multipass fixtures
multipass probe <fixture|provider>
multipass send <fixture>
multipass roundtrip <fixture>
multipass agent <fixture>
multipass run <fixture...>
multipass watch <fixture>
multipass webhook <fixture>  # alias of watch
multipass doctor
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
2. Set `platform` to one of the supported OpenClaw channel ids from the support matrix.
3. Use `adapter: slack` for native Slack, otherwise `adapter: script` for bridge-based real E2E.
4. Add one or more fixtures that point at stable demo accounts/targets.
5. Run `multipass doctor`, `multipass probe`, then `multipass run ...`.

## Current scope

- Real built-in providers: `loopback`, native `slack`
- Real external bridge: `script` for the full OpenClaw channel matrix
- Not implemented yet: native adapters beyond Slack, richer inbound event storage, rich media/cards, recorder compaction/query tooling
