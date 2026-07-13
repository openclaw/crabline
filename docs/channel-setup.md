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
`serverUrl` are optional mock metadata for loopback execution. Externally
reachable Discord webhooks require `publicKey` or `DISCORD_PUBLIC_KEY`.

Optional webhook credentials enforce each provider's native authentication
header before JSON parsing or recorder writes:

- Authenticated external ingress must set `webhook.publicUrl` to an HTTPS URL;
  Google Chat may use its HTTPS `endpointUrl` as the signed public callback
  instead. A non-loopback bind without a public HTTPS endpoint is rejected even
  when request credentials are configured. Plain HTTP is reserved for local
  tests where both the listener host and advertised URL host are loopback.
- Discord `publicKey` or `DISCORD_PUBLIC_KEY` verifies
  `X-Signature-Ed25519` over `X-Signature-Timestamp` plus the raw request body.
- Google Chat `endpointUrl` verifies Google ID tokens for the configured HTTP
  audience. `googleChatProjectNumber` selects project-number JWT verification
  instead. Authenticated Pub/Sub delivery uses `pubsubAudience` plus
  `pubsubServiceAccountEmail`; `pubsubAudience` falls back to `endpointUrl`
  when omitted, and `credentials.client_email` remains the service-account
  email fallback when inline credentials are configured. Wrapped Pub/Sub
  `message.data` must be canonical base64 before Google Chat event
  normalization.
  Google Workspace add-on `chat.messagePayload` events are rejected until the
  adapter can bind the verified request to a configured add-on deployment
  identity.
- Microsoft Teams `appId` or `TEAMS_APP_ID` verifies Bot Connector bearer
  tokens, including the activity channel and exact `serviceUrl`. An `appId` is
  required when the webhook host is non-loopback or `publicUrl` is set; an
  unauthenticated webhook remains available only on loopback.
- Matrix webhook ingress currently has no provider-native authentication mode,
  so it is restricted to loopback hosts and cannot set `publicUrl`.
- Mattermost and iMessage webhook ingress currently have no provider-native
  authentication mode, so those adapter webhooks are restricted to loopback
  hosts and cannot set `publicUrl`. Their API credentials do not authenticate
  inbound callbacks.
- Feishu `verificationToken` or `FEISHU_VERIFICATION_TOKEN` verifies plaintext
  callback tokens on loopback and remains an additional check when configured
  with encryption. Externally reachable webhooks require `encryptKey` or
  `FEISHU_ENCRYPT_KEY` to verify `X-Lark-Signature` on event callbacks and
  decrypt encrypted envelopes before normalization. Initial encrypted
  `url_verification` challenges may omit signature headers and are accepted
  only when their decrypted token matches the configured verification token.
  Text events must carry `message.content` as valid JSON containing a string
  `text` field; malformed JSON is rejected instead of treated as plaintext.
- Slack `signingSecret` or `SLACK_SIGNING_SECRET` verifies
  `X-Slack-Request-Timestamp` and `X-Slack-Signature`; it is required when the
  webhook host is non-loopback or `publicUrl` is set.
- Telegram `secretToken` or `TELEGRAM_WEBHOOK_SECRET_TOKEN` verifies
  `X-Telegram-Bot-Api-Secret-Token`. The value must contain 1-256 letters,
  digits, underscores, or hyphens; control characters are rejected.
- Zalo `webhookSecret` or `ZALO_WEBHOOK_SECRET` verifies
  `X-Bot-Api-Secret-Token`.

Webhook `path` values must already be canonical URL pathnames. Authority-form
paths, dot-segment or backslash traversal, query strings, fragments, spaces,
and other values changed by URL normalization are rejected.

The built-in `whatsapp` adapter implements Meta's GET verification challenge
and requires `X-Hub-Signature-256` on POST requests. Set `whatsapp.appSecret`
and `whatsapp.verifyToken` (or `WHATSAPP_APP_SECRET` and
`WHATSAPP_VERIFY_TOKEN`) before starting its webhook.

## Script Bridge Config

Script providers use only the `script:` config block. Their required `platform`
labels the OpenClaw channel represented by the bridge; it does not allow the
matching built-in block such as `slack:` or `telegram:`. Move any behavior from
those blocks into the commands or command environment when migrating:

Treat manifests containing script providers as executable, trusted code.
Crabline runs their declared commands with the configured environment, so load
them only from sources you trust and review changes before use.

Crabline does not ship a generic OpenClaw gateway command bridge. Supply and
version the command implementations with the manifest that uses them:

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
        probe: node ./bridge/probe.mjs
        send: node ./bridge/send.mjs
        waitForInbound: node ./bridge/wait-for-inbound.mjs
```

Each command receives one JSON document on stdin. Every payload contains the
parsed `fixture` plus `provider.config`, `provider.id`, and
`provider.manifestPath`. `send` adds `outbound` with `mode`, `nonce`, normalized
`target`, and `text`; `waitForInbound` adds `wait` with `excludeIds`, `nonce`,
`since`, `threadId`, normalized `target`, and `timeoutMs`. A stateless wait bridge must
exclude messages whose IDs are listed in `excludeIds` while retaining later
messages with the same timestamp. Crabline retains at most 1024 unmatched IDs
per wait. `watch` adds `watch` with optional `since` and normalized `target`.

Non-watch commands must write exactly one JSON value to stdout:

- `probe`: `{ "healthy": boolean, "details"?: string[] }`
- `send`: `{ "accepted": boolean, "messageId": string, "threadId": string }`
- `waitForInbound`: either `{ "timeout": true }` or
  `{ "message": { "author": "assistant" | "system" | "user", "id": string,
"sentAt": string, "text": string, "threadId": string, "raw"?: unknown } }`

`watch` writes one message object per JSONL line using the same message schema.
Blank lines are ignored. Non-watch stdout plus stderr is limited to 1 MiB.
Watch stderr, each JSONL line, and any unterminated buffered line are each
limited to 1 MiB. Commands inherit the process environment, use the configured
`cwd` and `shell`. Non-watch commands are terminated at their operation timeout;
watch commands are terminated when cancellation fires.

## Local Provider Servers

Server-backed channels currently include Mattermost, Matrix, Signal, Slack,
Telegram, WhatsApp, and Zalo. Loopback binds retain stable local credentials for
fixture compatibility. Non-loopback binds generate fresh provider-shaped
credentials unless the corresponding credential is supplied.
WhatsApp is loopback-only because its HTTP and WebSocket endpoints carry bearer
credentials over cleartext and the built-in server does not terminate TLS.

Commands in this section use the installed-package form. In a source checkout,
replace `crabline` with `pnpm dev`; `pnpm exec crabline` is not available.

`serve` rejects credential values in command-line arguments because argv and
shell history are not secret-safe. Use the `CRABLINE_ADMIN_TOKEN`,
`CRABLINE_ACCESS_TOKEN`, `CRABLINE_BOT_TOKEN`, and
`CRABLINE_SIGNING_SECRET` environment fallbacks, or pass a JSON object through
stdin or an inherited file descriptor:

```bash
crabline --json serve slack --credentials-fd 0 < .crabline/serve-credentials.json
crabline --json serve slack --credentials-fd 3 3< .crabline/serve-credentials.json
```

The accepted JSON fields are `adminToken`, `accessToken`, `botToken`, and
`signingSecret`. The input is bounded to 64 KiB, must contain only string
values, and overrides environment fallbacks field by field. Keep credential
files owner-readable or pipe the JSON directly from a secret manager.

### Mattermost

Start the server:

```bash
crabline --json serve mattermost --ready-file .crabline/mattermost-server.json
```

Use the manifest's `baseUrl` and `botToken` as OpenClaw's Mattermost endpoint
and credential. Because the server is loopback HTTP, trusted QA configuration
must also set `channels.mattermost.network.dangerouslyAllowPrivateNetwork` to
`true`. The OpenClaw bridge does this automatically.

Admin inbound accepts 26-character lowercase Mattermost `channelId` and
`senderId` values, `text`, optional `senderName`, `channelType`, `rootId`,
`channelName`, and `channelDisplayName`. It emits the message through
Mattermost's native `/api/v4/websocket` channel-scoped `posted` event, including
the configured channel names. Text sends through `POST /api/v4/posts` require a
JSON media type and are written to the manifest's recorder. QA agent delivery
currently supports DM and channel targets; thread targets require the later
OpenClaw QA wiring step.

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
Recorder-to-outbound translation requires the server-owned `accepted: true`
outcome together with the provider's exact send method and path. Rejected
requests and lookalike route suffixes can remain diagnostic recorder entries,
but they are never exposed as successful outbound deliveries.

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

The admin token is generated randomly unless `adminToken` is supplied through
the credential ingress above. Requests may also use
`Authorization: Bearer <token>`.

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
Compatible clients may switch to webhook delivery with `setWebhook`, including
an optional `secret_token` that Crabline returns as
`X-Telegram-Bot-Api-Secret-Token`. `deleteWebhook` restores polling. While a
webhook is configured, `getUpdates` returns Telegram's native conflict error
instead of consuming updates. The secret accepts only 1-256 letters, digits,
underscores, or hyphens. Bot API text fields are string-only and limited to
4,096 UTF-16 code units; media captions are string-only and limited to 1,024.
Admin-injected message entities preserve native `url`, `user`, `language`, and
`custom_emoji_id` metadata. Calls addressed to `@username` return a numeric
`Chat.id`, as Telegram does.

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
- `selfJid`: canonical local authenticated WhatsApp user JID; legacy `@c.us`
  input is normalized to `@s.whatsapp.net`
- `env.CLOUD_API_ACCESS_TOKEN`: same value as `accessToken`
- `env.CLOUD_API_VERSION`: Graph API version used by the local server
- `env.WA_BASE_URL`: local Graph API origin
- `env.WA_PHONE_NUMBER_ID`: local sender phone-number resource ID
- `endpoints.adminInboundUrl`: authenticated admin ingress for test user
  messages using the WhatsApp Business webhook payload shape
- `endpoints.messagesUrl`: provider-native Cloud API message and status endpoint
- `endpoints.statusUrl`: alias for the same provider-native status endpoint
- `recorderPath`: JSONL provider traffic recorder for HTTP traffic and Baileys
  WebSocket stanzas. Multi-message webhook deliveries use one versioned batch
  line that Crabline's recorder APIs flatten into individual events.

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
receives the native Zalo `{ event_name, message }` update directly with
`X-Bot-Api-Secret-Token`;
otherwise injected messages are returned by `getUpdates`. Provider errors use
Zalo's `{ ok, error_code, description }` shape.

`setWebhook` requires HTTPS, matching Zalo's public API. A loopback-bound
Crabline server also accepts a loopback HTTP URL for independent local client
tests. Non-loopback binds reject webhook destinations that resolve to private,
loopback, or link-local addresses.

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
- Built-in WhatsApp Cloud API users: digits-only `wa_id` values such as
  `15551234567`
- OpenClaw WhatsApp bridge users: `15551234567@s.whatsapp.net`
  (legacy `15551234567@c.us` inputs are accepted and canonicalized)
- OpenClaw WhatsApp bridge groups: `120363001234567890@g.us`
- Discord channels and threads: Discord snowflake ids such as
  `123456789012345678`
- Google Chat spaces: `spaces/AAAABbbbCCC`
- Google Chat threads: `spaces/AAAABbbbCCC/threads/BBBBccccDDD`
- Matrix rooms: scoped ids such as `!abcdef:matrix.org` or Matrix v12
  domainless room ids
- Zalo users, OAs, and chats: provider-native non-whitespace string ids such as
  `user-1` or `group-1`

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

Crabline provider-readiness runs claim their output directory exclusively across
processes. `runOpenClawCrablineProviderReadiness` probes the selected local
provider API; it does not claim that OpenClaw started or completed a channel
roundtrip. Real OpenClaw channel proof comes from QA scenarios that launch the
gateway and run its normal channel adapter against the local provider.

Crabline stages the manifest, capability report, and provider-readiness report
inside one owner-only generation directory under the legacy
`.crabline-smoke-artifacts/` store name, atomically installs the complete
directory, and then atomically switches the single `current.json` pointer.
Readers therefore see either the prior complete generation or the next complete
generation, never per-file mixtures. Setup, probe, cleanup, staging, or
ownership failures leave the prior pointer unchanged. Crash-leftover staging
directories and installed-but-uncommitted generations remain owner-only.
Publication rollback removes them when possible, and the next lock-owning
publisher prunes any leftovers before staging a new generation. Post-commit
cleanup retains only the current and previous pointer generations.

POSIX generation directories use mode `0700` and files use mode `0600`. Windows
hosts require `powershell.exe` with `Set-Acl`; Crabline resolves it from the
absolute local `SystemRoot` and applies a protected, inheritable DACL containing
only the current user SID to an empty generation directory before creating
sensitive files. Directory and file identities are verified throughout
publication. If `SystemRoot`, the ACL tooling, or identity verification is
unavailable, publication aborts without switching the pointer. Readiness results
contain `capabilityReport` and `providerReadiness` payloads while their manifest,
capability, and provider-readiness paths identify the authoritative immutable
generation.

Lock owners record both PID and process-start identity. Dead owners, and stale
locks whose PID was reused by the next Crabline process, are reclaimed on the
next run. New lock owners renew a 10-minute lease while the readiness run
remains active, so a live run retains exclusive ownership beyond the initial
lease. A heartbeat failure or lost ownership aborts publication before the
generation is committed. Recovery first atomically moves a stale candidate away
from the heartbeat path, then revalidates its token-specific lease before
deletion; a renewal that wins the rename race is restored rather than reclaimed.
The lease also bounds stale locks when an unrelated live process has inherited
the abandoned PID. Older owner records remain PID-protected for compatibility
and are reclaimed only after their recorded process exits.

For release or live verification, use OpenClaw's live driver:

```yaml
profile: release
channelDriver: live
```

If a live driver does not support a requested channel, the QA run should report
unsupported coverage. Crabline should not be used as a substitute for live
transport coverage.
