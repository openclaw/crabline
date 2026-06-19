# Channel Setup

Crabline is a local mock service for OpenClaw channel contracts. It does not
connect to Slack, Discord, Telegram, WhatsApp, Matrix, iMessage, or any other
live chat service, and it does not depend on chat provider SDK packages.

Live channel testing belongs in OpenClaw's live channel adapters. Crabline
belongs in deterministic smoke CI and local QA where the test needs
channel-shaped behavior without external services.

## Provider Shape

Provider ids are local profile names:

```yaml
providers:
  telegram:
    adapter: telegram
```

Fixtures reference provider ids:

```yaml
fixtures:
  - id: telegram-dm
    provider: telegram
```

Built-in adapters infer `platform` from `adapter`. `platform` is required only
for `adapter: script`, where Crabline needs to know which OpenClaw channel the
bridge profile represents.

## Built-In Local Mocks

| Adapter      | Default Webhook Path    | Default Port |
| ------------ | ----------------------- | ------------ |
| `discord`    | `/discord/interactions` | `8788`       |
| `feishu`     | `/feishu/webhook`       | `8795`       |
| `googlechat` | `/googlechat/webhook`   | `8792`       |
| `imessage`   | `/imessage/webhook`     | `8796`       |
| `matrix`     | `/matrix/webhook`       | `8797`       |
| `mattermost` | `/mattermost/webhook`   | `8793`       |
| `msteams`    | `/msteams/webhook`      | `8791`       |
| `slack`      | `/slack/events`         | `8787`       |
| `telegram`   | `/telegram/webhook`     | `8790`       |
| `whatsapp`   | `/whatsapp/webhook`     | `8789`       |
| `zalo`       | `/zalo/webhook`         | `8794`       |

`loopback` has no externally meaningful webhook surface and is primarily useful
for local direct adapter checks.

## Mock Config

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
```

Provider credential fields such as `botToken`, `accessToken`, `baseURL`, or
`serverUrl` are optional metadata for compatibility with older configs. They
are not required for local mock execution.

## Webhook Payload

All mock webhooks accept the same simple JSON shape:

```json
{
  "id": "inbound-1",
  "threadId": "slack:C1234567890",
  "text": "reply nonce-123",
  "author": "assistant"
}
```

The nested form is also accepted:

```json
{
  "message": {
    "id": "inbound-1",
    "threadId": "slack:C1234567890",
    "text": "reply nonce-123"
  }
}
```

Missing `threadId` or `text` returns `400`. Non-JSON requests return `415`.

## Target Encoding

Most local mocks encode raw targets as:

```text
{platform}:{target.id}
```

Thread fixtures encode as:

```text
{platform}:{channelId}:{threadId}
```

Telegram and Discord keep channel-specific target conventions for the cases QA
already models:

- Telegram topics: `telegram:{chatId}:{messageThreadId}`
- Discord guild channels: `discord:{guildId}:{channelId}`
- Discord threads: `discord:{guildId}:{channelId}:{threadId}`
- Discord DMs: `discord:@me:dm-{target.id}`

## Smoke CI Guidance

For deterministic CI, use Crabline through a mock channel driver:

```yaml
profile: smoke-ci
channelDriver: mock
```

The scenario channel should remain the real channel contract:

```yaml
execution:
  channel: telegram
```

That means "run Telegram-shaped behavior through the mock Telegram backend."
It does not mean "connect to live Telegram."

For release or live verification, use OpenClaw's live driver:

```yaml
profile: release
channelDriver: live
```

If a live driver does not support a requested channel, the QA run should report
unsupported coverage. Crabline should not be used as a substitute for live
transport coverage.
