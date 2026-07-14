# crabline

![Crabline deterministic messaging-channel QA](assets/crabline-banner.svg)

Deterministic local messaging-channel mocks for OpenClaw QA.

`crabline` is config-driven, CI-friendly, and deliberately has no `openclaw`
dependency. It can run fixture-level local mocks, and it can also serve local
provider APIs that OpenClaw live adapters can target during deterministic QA.

## What It Provides

- local mock providers for `discord`, `feishu`, `googlechat`, `imessage`,
  `loopback`, `matrix`, `mattermost`, `msteams`, `slack`, `telegram`,
  `whatsapp`, and `zalo`
- a `script` bridge for channels that are still exercised by external commands
- per-provider local webhook endpoints for inbound events
- local provider servers for live-adapter smoke tests for Mattermost, Matrix,
  Signal, Slack, Telegram, WhatsApp, and Zalo
- JSONL recorder files for deterministic wait/watch behavior
- nonce-based `send`, `roundtrip`, `agent`, `probe`, `run`, `watch`, and
  `doctor` commands
- text output by default and stable `--json` output for automation

Crabline local servers are not live-provider coverage. They let OpenClaw run its
normal channel adapter code against a local provider-shaped API. Release lanes
still need the `live` driver and real provider credentials.

## Install

```bash
pnpm install
pnpm build
pnpm verify
```

Run locally:

```bash
pnpm dev fixtures --config fixtures/examples/crabline.example.yaml
pnpm dev roundtrip telegram-dm --config fixtures/examples/crabline.example.yaml
```

The source checkout does not link its own `crabline` bin into
`node_modules/.bin`, so use `pnpm dev` there rather than
`pnpm exec crabline`. An installed package exposes the `crabline` command used
in the examples below.

## Quality Gate

```bash
pnpm verify
```

That enforces formatting, typecheck, type-aware lint, and Vitest coverage.

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
  telegram:
    adapter: telegram
    telegram:
      recorder:
        path: ./.crabline/recorders/telegram.jsonl
      webhook:
        host: 127.0.0.1
        port: 8790
        path: /telegram/webhook
fixtures:
  - id: telegram-dm
    provider: telegram
    mode: roundtrip
    target:
      id: "100000001"
      behavior: agent
```

Provider ids are local profile names. Fixtures reference them through
`provider`. Built-in adapters infer their platform from `adapter`; `platform` is
required only for `adapter: script`.

Most built-in provider credentials are optional mock metadata. The WhatsApp
webhook requires `appSecret` and `verifyToken` because every verification or
delivery request is authenticated. `doctor` checks explicit `env` declarations,
script command availability, and config shape without requiring live platform
credentials.

When configured, Discord `publicKey`, Feishu `encryptKey`, Google Chat endpoint
or Pub/Sub identity settings, Microsoft Teams `appId`, Slack `signingSecret`,
Telegram `secretToken`, and Zalo `webhookSecret` enforce provider-native
webhook authentication. Feishu `verificationToken` remains an additional or
loopback-only callback check. Microsoft Teams also requires `appId` for
non-loopback or explicitly public webhook endpoints.
Authenticated external webhook ingress must advertise an HTTPS `publicUrl`;
plain HTTP is limited to loopback-local testing.
Feishu text callbacks require valid JSON-encoded `message.content`; malformed
content is rejected.

## Built-In Mock Channels

All built-in mock providers support:

- `probe`
- `send`
- `roundtrip`
- `agent`
- `watch`

The built-in providers are:

- `discord`
- `feishu`
- `googlechat`
- `imessage`
- `loopback`
- `matrix`
- `mattermost`
- `msteams`
- `slack`
- `telegram`
- `whatsapp`
- `zalo`

The `script` adapter can bridge any OpenClaw channel represented by the
configured `platform` enum by running local commands for `probe`, `send`,
`waitForInbound`, or `watch`.

Treat manifests that configure `adapter: script` as executable, trusted code:
Crabline runs their declared commands with the configured environment. Load
them only from sources you trust and review changes before use.

## Local Provider Servers

`serve` starts provider-shaped HTTP APIs for OpenClaw live adapters. This is the
preferred Smoke CI path because OpenClaw still uses its normal channel adapter,
but the provider endpoint is local and deterministic.

Commands in this section use the installed-package form. In a source checkout,
replace `crabline` with `pnpm dev`.

`serve` never accepts credential values in command-line arguments. Set
`CRABLINE_ACCESS_TOKEN`, `CRABLINE_ADMIN_TOKEN`, `CRABLINE_BOT_TOKEN`, or
`CRABLINE_SIGNING_SECRET`, or pass a bounded JSON object through a file
descriptor. Package runners should use stdin:

```bash
pnpm dev --json serve slack --credentials-fd 0 < .crabline/serve-credentials.json
```

The installed CLI can also use an inherited descriptor when its launcher
preserves descriptors above 2:

```bash
crabline --json serve slack --credentials-fd 3 3< .crabline/serve-credentials.json
```

The JSON fields are `accessToken`, `adminToken`, `botToken`, and
`signingSecret`. File-descriptor values override environment fallbacks. Do not
pass descriptors above 2 through package runners such as `pnpm`; use fd 0
instead. Keep credential files owner-readable or pipe the JSON directly from a
secret manager.

Library callers can pass `onEvent` to `startCrablineServer`, an individual
provider server, or `startOpenClawCrablineAdapter`. Crabline awaits the callback
after appending each API/admin event to `recorderPath`, so callers can react in
process while retaining the JSONL artifact as durable evidence.

Recorder files should normally have one filesystem name. If multiple processes
cannot share the same OS account home, the home is read-only, or they write
through hardlinks to the same recorder inode, set
`CRABLINE_RECORDER_LOCK_DIR` to the same absolute writable directory for every
writer. Pre-create that directory with the ownership, group, or ACLs required
by those writers. Crabline refuses hardlinked server-recorder writes without
this shared lock namespace. The configured path must be canonical and contain
no symlink components. Scope each lock directory to one recorder filesystem;
lock identities omit device numbers so containers that mount the same inode
under different device IDs still coordinate. Otherwise, Unix writers coordinate
through the OS account's `~/.cache/crabline/locks/server-recorder` namespace.

Mattermost:

```bash
crabline --json serve mattermost --ready-file .crabline/mattermost-server.json
```

The JSON manifest contains:

- `baseUrl`: OpenClaw `channels.mattermost.baseUrl` / `MATTERMOST_URL`
- `botToken`: OpenClaw `channels.mattermost.botToken` / `MATTERMOST_BOT_TOKEN`
- `webhookToken` / `MATTERMOST_TOKEN`: verifies native outgoing webhook posts
- `endpoints.websocketUrl`: native Mattermost WebSocket endpoint
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `endpoints.adminInboundUrl`: authenticated POST endpoint for inbound messages
- `recorderPath`: JSONL file of local provider API/admin traffic

The server implements a Mattermost API subset for text DM and channel
roundtrips, including REST authentication/status codes, WebSocket
authentication and `hello`, sequenced events, typing, and post
create/edit/delete events. Admin ingress is only the test control plane;
injected messages require native 26-character lowercase channel/user IDs and
are delivered to clients as channel-scoped native `posted` events. Optional
`channelName` and `channelDisplayName` values populate the native event fields.
`POST /api/v4/posts` requires a JSON media type.

Matrix:

```bash
crabline --json serve matrix --ready-file .crabline/matrix-server.json
```

The JSON manifest contains:

- `baseUrl`: OpenClaw `channels.matrix.homeserver`
- `accessToken`: OpenClaw `channels.matrix.accessToken`
- `botUserId`: OpenClaw `channels.matrix.userId`
- `endpoints.clientApiRoot`: Matrix Client-Server API root
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `endpoints.adminInboundUrl`: authenticated POST control endpoint for inbound
  messages
- `recorderPath`: JSONL file of local provider API/admin traffic

The server implements an unencrypted Matrix Client-Server API subset including
`whoami`, filters, push rules, joined rooms and members, room state, `/sync`,
room event sends, typing, and read receipts. Admin ingress is only the test
control plane; injected messages are delivered to clients as native
`m.room.message` events through `/sync`. Optional `roomName` sets newly created
room state, `direct: true` publishes `m.direct` account data, and `threadId`
accepts the raw Matrix root event ID used in the native thread relation.

Slack:

```bash
crabline --json serve slack --ready-file .crabline/slack-server.json
```

The JSON manifest contains:

- `endpoints.apiRoot`: set OpenClaw's Slack API override / `SLACK_API_URL` to
  this value
- `botToken`: set OpenClaw `channels.slack.botToken` to this value
- `signingSecret`: set OpenClaw `channels.slack.signingSecret` to this value
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `endpoints.adminInboundUrl`: authenticated POST endpoint for Events API-shaped
  test user messages
- `endpoints.eventsUrl`: local Slack Events API endpoint
- `recorderPath`: JSONL file of local provider API/admin traffic

The admin token is generated randomly unless `adminToken` is supplied through
the credential ingress above. Implemented Slack Web API endpoints include `auth.test`,
`chat.postMessage`, `conversations.open`, `conversations.info`,
`conversations.history`, and `conversations.replies`.

Signal:

```bash
crabline --json serve signal --ready-file .crabline/signal-server.json
```

The JSON manifest contains:

- `endpoints.apiRoot`: `signal-cli daemon --http`-compatible API root
- `account`: mock Signal account served by the daemon
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `endpoints.adminInboundUrl`: authenticated POST endpoint for inbound messages
- `endpoints.eventsUrl`: `signal-cli` SSE receive endpoint
- `endpoints.rpcUrl`: `signal-cli` JSON-RPC endpoint
- `recorderPath`: JSONL file of local provider API/admin traffic

The server implements the HTTP surface exposed by `signal-cli daemon --http`:
`check`, `events`, and the JSON-RPC methods needed for text sends, typing,
receipts, and reactions. Admin ingress injects text-only receive events. It does
not replace the `signal-cli` client or pretend to be Signal's public service.

Telegram:

```bash
crabline --json serve telegram --ready-file .crabline/telegram-server.json
```

The JSON manifest contains:

- `endpoints.apiRoot`: set OpenClaw `channels.telegram.apiRoot` to this value
- `botToken`: set OpenClaw `channels.telegram.botToken` to this value
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `endpoints.adminInboundUrl`: authenticated POST endpoint for test user
  messages; OpenClaw reads them through Telegram `getUpdates`
- `recorderPath`: JSONL file of local provider API/admin traffic

The admin token is generated randomly unless `adminToken` is supplied through
the credential ingress above. The inbound endpoint rejects requests without
the matching admin header (or `Authorization: Bearer <token>`).

Implemented Telegram Bot API endpoints include `getMe`, `sendMessage`,
`sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, `sendAnimation`, `editMessageText`,
`deleteMessage`, `setMessageReaction`, `createForumTopic`, `editForumTopic`,
`pinChatMessage`, `unpinChatMessage`, `getUpdates`, `deleteWebhook`,
`setWebhook`, `setMyCommands`, `deleteMyCommands`, `sendChatAction`, and
`answerCallbackQuery`. Webhook secrets use Telegram's 1-256 character
letter/digit/underscore/hyphen alphabet. Text and caption fields enforce native
string types and 4,096/1,024 UTF-16 limits, entity metadata is retained, and
`@username` method targets resolve to numeric `Chat.id` values.

WhatsApp:

```bash
crabline --json serve whatsapp --ready-file .crabline/whatsapp-server.json
```

The JSON manifest contains:

- `endpoints.apiRoot`: versioned WhatsApp Graph API root
- `endpoints.phoneNumberUrl`: provider-native phone-number resource
- `endpoints.baileysWebSocketUrl`: Baileys-compatible WebSocket URL for
  `waWebSocketUrl`, including the local provider access token query parameter
- `accessToken`: bearer token for local provider requests
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `selfJid`: canonical local authenticated WhatsApp user JID; legacy `@c.us`
  input is normalized to `@s.whatsapp.net`
- `env.CLOUD_API_ACCESS_TOKEN`: same value as `accessToken`
- `env.CLOUD_API_VERSION`: Graph API version used by the local server
- `env.WA_BASE_URL`: local Graph API origin
- `env.WA_PHONE_NUMBER_ID`: local sender phone-number resource ID
- `endpoints.adminInboundUrl`: authenticated POST endpoint for test user
  messages using the WhatsApp Business webhook payload shape
- `endpoints.messagesUrl`: provider-native Cloud API message and status endpoint
- `endpoints.statusUrl`: alias for the same provider-native status endpoint
- `recorderPath`: JSONL file of local provider API/admin traffic and Baileys
  WebSocket stanzas

Pass `endpoints.baileysWebSocketUrl` to Baileys as `waWebSocketUrl` when a
runtime needs to connect through the local provider. Cloud API-compatible
clients can send text messages through
`POST /v25.0/<phone-number-id>/messages` with a bearer token. The local server completes
the Baileys Noise handshake, serves bootstrap/device/prekey queries, and records
encrypted outbound WebSocket stanzas. Direct `msg` and `pkmsg` text sends are
also recorded as normalized accepted-send evidence for the OpenClaw bridge.
Group outbound uses sender-key `skmsg` encryption and is outside this supported
subset, so OpenClaw Crabline outbound targets are direct users only. Group
inbound injection remains supported. The WebSocket endpoint rejects clients
that do not present the access token embedded in the manifest URL. The admin
token is generated randomly unless `adminToken` is supplied through the
credential ingress above.

OpenClaw bridge callers should post injected user messages with the
`providerUrl`, `providerHeaders`, and `providerBody` returned by
`createOpenClawCrablineInbound()`.

Zalo:

```bash
crabline --json serve zalo --ready-file .crabline/zalo-server.json
```

The JSON manifest contains:

- `endpoints.apiRoot`: trusted `ZALO_API_URL`
- `botToken`: OpenClaw `channels.zalo.botToken` / `ZALO_BOT_TOKEN`
- `botId`: local Zalo bot identity
- `adminToken`: send this as the `X-Crabline-Admin-Token` header when posting
  test user messages
- `endpoints.adminInboundUrl`: authenticated POST control endpoint for inbound
  messages
- `recorderPath`: JSONL file of local provider API/admin traffic

The server implements the Zalo Bot API subset used by OpenClaw: `getMe`,
single-update long polling through `getUpdates`, `sendMessage`, `sendPhoto`,
`sendChatAction`, and webhook registration, inspection, and deletion. These Bot
API methods accept GET query parameters or POST requests. Admin
ingress injects a native Zalo update into the active polling or webhook
transport. Webhook delivery posts the native `{ event_name, message }` update
directly. OpenClaw-specific endpoint, config, and target mapping remain in the
isolated bridge.

The admin ingress accepts JSON like:

```json
{
  "chatId": "6ede9afa66b88fe6d6a9",
  "chatType": "PRIVATE",
  "senderId": "6ede9afa66b88fe6d6a9",
  "senderName": "Alice",
  "text": "user nonce-123"
}
```

## Target IDs

Built-in providers accept native channel identifiers. Crabline does not add
`telegram:`, `discord:`, `slack:`, or other local prefixes.

```yaml
target:
  id: "C1234567890"
```

Thread targets use the platform's native thread identifier:

```yaml
target:
  id: "C1234567890"
  channelId: "C1234567890"
  threadId: "1700000000.000100"
```

Examples:

- Slack conversations: `C1234567890`, `G1234567890`, or `D1234567890`
- Slack direct sends may also target user IDs such as `U1234567890` or
  `W1234567890`
- Slack threads: `1700000000.000100`
- Telegram chats: `-1001234567890` or `@channelusername`
- Telegram topics: `42`
- Telegram username targets require `@`, contain 4-32 letters, digits, or
  underscores, and normalize to lowercase. Numeric chat IDs must be nonzero and
  have an absolute value no greater than `2^52 - 1`.
- WhatsApp Cloud API users: digits-only `wa_id` values such as `15551234567`
- WhatsApp groups: `120363001234567890@g.us`
- Discord channels and threads: Discord snowflake ids such as
  `123456789012345678`
- iMessage recipients: E.164 phone numbers such as `+15551234567`, email
  addresses such as `user@example.com`, or chat GUIDs such as
  `iMessage;-;chat-guid` and `SMS;+;chat-guid`
- Matrix rooms: scoped IDs such as `!abcdef:matrix.org` or Matrix v12
  domainless room IDs; thread IDs are raw root event IDs such as
  `$eventid:matrix.org`
- Mattermost channels, users, and root posts: exactly 26 lowercase alphanumeric
  characters, such as `abcdefghijklmnopqrstuvwx12`
- Microsoft Teams: non-empty opaque Bot Connector `conversation.id` values such
  as `a:opaque-conversation-id` or `19:conversation@thread.v2`
- Zalo users, OAs, and chats: non-whitespace provider IDs such as `user-1` or
  `group-1`

## Webhooks

Each built-in provider starts a local webhook during `probe`, `waitForInbound`,
or `watch`. Webhook requests can use the provider's native event shape, or this
simple JSON shape with native thread ids:

```json
{
  "id": "slack-inbound-1",
  "threadId": "C1234567890",
  "text": "reply nonce-123",
  "author": "assistant"
}
```

Nested message payloads are also accepted:

```json
{
  "message": {
    "id": "slack-inbound-1",
    "threadId": "C1234567890",
    "text": "reply nonce-123"
  }
}
```

Malformed webhooks return `400`, and non-JSON requests return `415`.
Configured webhook paths must be canonical URL pathnames without normalization,
query, or fragment ambiguity.

## Evidence Flow

`send` records an outbound user event in the provider recorder. For `roundtrip`
and `agent` modes, the local mock also records a deterministic assistant reply:

```text
[telegram mock] hello nonce-123
```

`waitForInbound` reads the recorder until it finds a matching non-user event.
`watch` streams matching recorder events. This gives CI channel coverage without
live service latency, external credentials, webhooks exposed to the internet, or
provider SDK state.

Recorder files remain JSONL. Individual events use one object per line; an
accepted multi-message webhook is committed as one versioned batch object so
readers never observe a partial batch. Crabline's recorder APIs flatten those
batch objects back into their individual events.

## More Setup Detail

See [Channel Setup](docs/channel-setup.md) for the provider matrix, webhook
paths, and OpenClaw live-vs-mock guidance.
