# Channel Setup

Crabline is a local mock service for OpenClaw channel contracts. It has two
surfaces:

- fixture-level local mocks used directly by the Crabline CLI
- local provider servers that OpenClaw live adapters can target

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

Each provider selects exactly one adapter and may include only that adapter's
config block. For example, `adapter: slack` may use `slack:`, but it cannot also
contain `telegram:` or `script:`. When migrating an older mixed provider entry,
remove stale config blocks or split them into separate provider ids.

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

## Script Bridge Config

Script providers use only the `script:` config block. Their required `platform`
labels the OpenClaw channel represented by the bridge; it does not allow the
matching built-in block such as `slack:` or `telegram:`. Move any behavior from
those blocks into the commands or command environment when migrating:

```yaml
providers:
  slack-openclaw:
    adapter: script
    platform: slack
    capabilities: [probe, send, roundtrip]
    env:
      - OPENCLAW_URL
      - OPENCLAW_TOKEN
    script:
      commands:
        probe: node ./scripts/openclaw-bridge-probe.mjs
        send: node ./scripts/openclaw-bridge-send.mjs
        waitForInbound: node ./scripts/openclaw-bridge-wait.mjs
```

The complete multi-channel script fixture is available in
`fixtures/examples/openclaw-bridge.yaml`.

## Local Provider Servers

Server-backed channels currently include Mattermost, Matrix, Signal, Slack,
Telegram, and WhatsApp.

### Mattermost

Start the server:

```bash
crabline --json serve mattermost --ready-file .crabline/mattermost-server.json
```

Use the manifest's `baseUrl` and `botToken` as OpenClaw's Mattermost endpoint
and credential. Because the server is loopback HTTP, trusted QA configuration
must also set `channels.mattermost.network.dangerouslyAllowPrivateNetwork` to
`true`. The OpenClaw bridge does this automatically.

Admin inbound accepts `channelId`, `senderId`, `text`, optional `senderName`,
`channelType`, and `rootId`. It emits the message through Mattermost's native
`/api/v4/websocket` `posted` event. Text sends through `POST /api/v4/posts` are
written to the manifest's recorder. QA agent delivery currently supports DM and
channel targets; thread targets require the later OpenClaw QA wiring step.

The server itself is provider-shaped and has no OpenClaw runtime dependency. It
implements Mattermost REST error/status behavior plus WebSocket authentication,
`hello`, event sequencing, typing, and post mutation events for the supported
subset. OpenClaw configuration and QA target mapping remain in the separate
OpenClaw bridge.

### Matrix

Start the server:

```bash
crabline --json serve matrix --ready-file .crabline/matrix-server.json
```

Use the manifest's `baseUrl`, `accessToken`, and `botUserId` as OpenClaw's
Matrix homeserver, access token, and user ID. Set encryption to `false` and,
because the server is loopback HTTP, enable
`channels.matrix.network.dangerouslyAllowPrivateNetwork`. The OpenClaw bridge
applies those settings automatically.

Admin inbound accepts native `roomId`, `senderId`, and `text` fields plus
optional `senderName` and `threadId`. It queues a native `m.room.message` event
for delivery through Matrix `/sync`. Outbound room sends through
`PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId` are written to the
manifest recorder.

The provider server implements the unencrypted Client-Server API subset needed
by the normal Matrix SDK: versions, `whoami`, filters, push rules, joined rooms
and members, room state, `/sync`, room sends, typing, and read receipts. The
`/crabline/matrix/inbound` endpoint is a test control plane and is not part of
the Matrix API. OpenClaw configuration and QA target mapping remain in the
separate OpenClaw bridge.

Local provider servers sit below OpenClaw's normal channel adapters. QA starts
the server, writes the emitted runtime manifest into OpenClaw config/env, and
then OpenClaw talks to the local provider instead of the public provider.

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

Signal:

```bash
crabline --json serve signal --ready-file .crabline/signal-server.json
```

Manifest fields:

- `endpoints.apiRoot`: `signal-cli daemon --http`-compatible API root
- `account`: mock Signal account served by the daemon
- `adminToken`: value for the `X-Crabline-Admin-Token` header on admin ingress
- `endpoints.adminInboundUrl`: authenticated admin ingress for test user messages
- `endpoints.eventsUrl`: `signal-cli` SSE receive endpoint
- `endpoints.rpcUrl`: `signal-cli` JSON-RPC endpoint
- `recorderPath`: JSONL provider traffic recorder

The admin ingress accepts JSON like:

```json
{
  "groupId": "signal-group-1",
  "sourceName": "Alice",
  "sourceNumber": "+15551234567",
  "text": "user nonce-123"
}
```

Clients consume that message through the `signal-cli` SSE surface; outbound text
sends are recorded through its `send` JSON-RPC method. The local server also
accepts typing, receipt, and reaction RPCs. OpenClaw-specific config and target
mapping live in Crabline's OpenClaw bridge, outside the provider server.

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
sends are recorded through Telegram `sendMessage` and the media send endpoints
`sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, and `sendAnimation`.

WhatsApp:

```bash
crabline --json serve whatsapp --ready-file .crabline/whatsapp-server.json
```

Manifest fields:

- `endpoints.apiRoot`: versioned WhatsApp Graph API root
- `endpoints.phoneNumberUrl`: provider-native phone-number resource
- `endpoints.baileysWebSocketUrl`: Baileys-compatible WebSocket URL for
  `waWebSocketUrl`, including the local provider access token query parameter
- `accessToken`: bearer token for local provider requests
- `adminToken`: value for the `X-Crabline-Admin-Token` header on admin ingress
- `selfJid`: local authenticated WhatsApp user JID
- `env.CLOUD_API_ACCESS_TOKEN`: same value as `accessToken`
- `env.CLOUD_API_VERSION`: Graph API version used by the local server
- `env.WA_BASE_URL`: local Graph API origin
- `env.WA_PHONE_NUMBER_ID`: local sender phone-number resource ID
- `endpoints.adminInboundUrl`: authenticated admin ingress for test user
  messages using the WhatsApp Business webhook payload shape
- `endpoints.messagesUrl`: provider-native Cloud API message and status endpoint
- `endpoints.statusUrl`: alias for the same provider-native status endpoint
- `recorderPath`: JSONL provider traffic recorder for HTTP traffic and Baileys
  WebSocket stanzas

Pass `endpoints.baileysWebSocketUrl` to Baileys as `waWebSocketUrl` when a
runtime needs to connect through the local provider. Cloud API-compatible
clients can send text messages through
`POST /v25.0/<phone-number-id>/messages` with a bearer token. The local server completes
the Baileys Noise handshake, serves bootstrap/device/prekey queries, and records
encrypted outbound WebSocket stanzas. The WebSocket endpoint rejects clients
that do not present the access token embedded in the manifest URL. The admin
token is generated randomly unless `--admin-token <token>` is provided.

OpenClaw bridge callers should post injected user messages with the
`providerUrl`, `providerHeaders`, and `providerBody` returned by
`createOpenClawCrablineInbound()`.

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

### Zalo Server

Start the server:

```bash
crabline --json serve zalo --ready-file .crabline/zalo-server.json
```

Set trusted `ZALO_API_URL` to `endpoints.apiRoot` and configure the emitted
`botToken` as `channels.zalo.botToken` or `ZALO_BOT_TOKEN`. The OpenClaw bridge
does this mapping without adding provider-server-specific behavior to the Zalo
adapter.

The server accepts the provider-native `/bot<TOKEN>/<METHOD>` API shape over
GET or POST. It implements bot identity, single-update long polling, text and
photo sends, chat actions, and webhook lifecycle calls. A configured webhook
receives the native Zalo `{ ok, result }` event envelope with
`X-Bot-Api-Secret-Token`;
otherwise injected messages are returned by `getUpdates`. Provider errors use
Zalo's `{ ok, error_code, description }` shape.

The authenticated admin ingress is only a test control plane. Post a message
such as:

```json
{
  "chatId": "group-1",
  "chatType": "GROUP",
  "senderId": "user-1",
  "senderName": "Alice",
  "text": "user nonce-123"
}
```

Crabline translates that state change into the normal Zalo polling or webhook
transport. Outbound `sendMessage` and `sendPhoto` calls are written to the
manifest's `recorderPath` with the bot token redacted.

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

OpenClaw bridge QA targets reserve the exact forms `dm:<id>`, `group:<id>`,
`channel:<id>`, and `thread:<id>/<thread-id>`. Reserved forms require non-blank
components, and inbound thread IDs are trimmed before the matching QA target is
emitted. Numeric Telegram DM IDs must be positive; group, channel, and thread
chat IDs must be negative. Zero is invalid for every Telegram target kind.

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

OpenClaw smoke runs claim their output directory exclusively across processes.
The credential-bearing server manifest is atomically replaced with owner-only
permissions, including when an older manifest was more permissive. POSIX hosts
use mode `0600`. Windows hosts require `powershell.exe` with `Set-Acl`; Crabline
resolves it from the absolute local `SystemRoot`, creates an empty temporary
file, applies and verifies a protected DACL containing only the current user SID
with full control, keeps the creator handle open, verifies the file identity,
and only then writes credentials. The identity is checked again before and after
the atomic replacement. If `SystemRoot`, the ACL tooling, or verification is
unavailable, publication aborts without replacing the previous manifest. Lock
owners record both PID and process-start identity. Dead owners, and stale locks
whose PID was reused by the next Crabline process, are reclaimed on the next
run. A 10-minute lease also bounds stale locks when an unrelated live process
has inherited the abandoned PID.

For release or live verification, use OpenClaw's live driver:

```yaml
profile: release
channelDriver: live
```

If a live driver does not support a requested channel, the QA run should report
unsupported coverage. Crabline should not be used as a substitute for live
transport coverage.
