# Channel Setup

Crabline is a local mock service for OpenClaw channel contracts. It has two
surfaces:

- fixture-level local mocks used directly by the Crabline CLI
- fake provider servers that OpenClaw live adapters can target

Live channel testing belongs in OpenClaw's live channel adapters. Crabline
belongs in deterministic smoke CI and local QA where the test needs
provider-shaped behavior without external services.

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
`serverUrl` are optional mock metadata. They are not required for local mock
execution.

## Fake Provider Servers

Fake provider servers sit below OpenClaw's normal channel adapters. QA starts the
server, writes the emitted runtime manifest into OpenClaw config/env, and then
OpenClaw talks to the local fake provider instead of the public provider.

Slack:

```bash
crabline --json serve slack --ready-file .crabline/slack-server.json
```

Manifest fields:

- `endpoints.apiRoot`: OpenClaw Slack Web API root / `SLACK_API_URL`
- `botToken`: OpenClaw `channels.slack.botToken`
- `signingSecret`: OpenClaw `channels.slack.signingSecret`
- `adminToken`: value for the `X-Crabline-Admin-Token` header on admin ingress
- `endpoints.adminInboundUrl`: authenticated admin ingress for test user messages
- `endpoints.eventsUrl`: local Slack Events API endpoint
- `recorderPath`: JSONL provider traffic recorder

The admin ingress accepts JSON like:

```json
{
  "channel": "C1234567890",
  "threadTs": "1700000000.000100",
  "user": "U1234567890",
  "text": "user nonce-123"
}
```

OpenClaw consumes that message through Slack Events API shape; outbound adapter
sends are recorded through Slack `chat.postMessage`.

Telegram:

```bash
crabline --json serve telegram --ready-file .crabline/telegram-server.json
```

Manifest fields:

- `endpoints.apiRoot`: OpenClaw `channels.telegram.apiRoot`
- `botToken`: OpenClaw `channels.telegram.botToken`
- `adminToken`: value for the `X-Crabline-Admin-Token` header on admin ingress
- `endpoints.adminInboundUrl`: authenticated admin ingress for test user messages
- `recorderPath`: JSONL provider traffic recorder

The admin token is generated randomly unless `--admin-token <token>` is
provided. Requests may also use `Authorization: Bearer <token>`.

The admin ingress accepts JSON like:

```json
{
  "chatId": "-1001234567890",
  "messageThreadId": 42,
  "fromId": 100001,
  "text": "user nonce-123"
}
```

OpenClaw consumes that message through Telegram `getUpdates`; outbound adapter
sends are recorded through Telegram `sendMessage`.

WhatsApp:

```bash
crabline --json serve whatsapp --ready-file .crabline/whatsapp-server.json
```

Manifest fields:

- `endpoints.apiRoot`: Crabline WhatsApp fake provider API root
- `accessToken`: bearer token for fake provider requests
- `adminToken`: value for the `X-Crabline-Admin-Token` header on admin ingress
- `selfJid`: fake authenticated WhatsApp user JID
- `endpoints.adminInboundUrl`: authenticated admin ingress for test user
  messages; subscribed Baileys mock sockets receive them as `messages.upsert`
- `endpoints.messagesUrl`: text send endpoint used by the Baileys-shaped mock
- `endpoints.presenceUrl`: presence endpoint used by `sendPresenceUpdate`
- `recorderPath`: JSONL provider traffic recorder

Use the started server's `createBaileysMockSocket()` when a test needs a
Baileys-style `sendMessage()` / `sendPresenceUpdate()` surface backed by the
same fake provider server. The admin token is generated randomly unless
`--admin-token <token>` is provided.

OpenClaw bridge callers should post injected user messages with the
`providerUrl`, `providerHeaders`, and `providerBody` returned by
`createOpenClawCrablineInbound()`. For WhatsApp, inbound `messages.upsert`
delivery is an in-process Baileys mock socket behavior: create the fake server
and Baileys mock socket in the same Node process when testing listener-driven
inbound delivery. If the socket is created outside the started server, pass the
same `WhatsAppBaileysMockRegistry` to the server and socket helper.

The admin ingress accepts JSON like:

```json
{
  "chatJid": "120363001234567890@g.us",
  "senderJid": "15551234567@s.whatsapp.net",
  "text": "user nonce-123"
}
```

Outbound text sends and composing presence are recorded through the fake
provider messages and presence endpoints.

## Webhook Payload

Mock webhooks accept provider-native event payloads where Crabline has a built-in
adapter for the channel. They also accept this simple JSON shape with native
thread ids:

```json
{
  "id": "inbound-1",
  "threadId": "C1234567890",
  "text": "reply nonce-123",
  "author": "assistant"
}
```

The nested form is also accepted:

```json
{
  "message": {
    "id": "inbound-1",
    "threadId": "C1234567890",
    "text": "reply nonce-123"
  }
}
```

Missing `threadId` or `text` returns `400`. Non-JSON requests return `415`.

## Target IDs

Targets use native channel identifiers. Crabline does not add local prefixes such
as `telegram:`, `discord:`, or `slack:`.

- Slack conversations: `C1234567890`, `G1234567890`, or `D1234567890`
- Slack threads: `1700000000.000100`
- Telegram chats: `-1001234567890` or `@channelusername`
- Telegram topics: `42`
- WhatsApp users: `15551234567@s.whatsapp.net`
- WhatsApp groups: `120363001234567890@g.us`
- Discord channels and threads: Discord snowflake ids such as
  `123456789012345678`
- Google Chat spaces: `spaces/AAAABbbbCCC`
- Google Chat threads: `spaces/AAAABbbbCCC/threads/BBBBccccDDD`

## Smoke CI Guidance

For deterministic CI, use Crabline through a mock channel driver:

```yaml
profile: smoke-ci
channelDriver: crabline
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
