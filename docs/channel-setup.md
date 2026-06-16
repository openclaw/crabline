# Channel Setup

This document is the operator checklist for every channel Crabline can exercise.
Keep it in sync with `src/config/schema.ts`, `src/providers/catalog.ts`,
`fixtures/examples/crabline.example.yaml`, and
`fixtures/examples/openclaw-bridge.yaml`.

Crabline does not require a Vercel account. Chat SDK is a TypeScript library;
built-in adapters read platform credentials from config or environment variables.
For smoke CI, put secrets in the CI secret store and reference them through
provider `env` arrays. Do not commit credentials in fixtures.

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

Built-in adapters infer `platform` from `adapter`. `platform` is required only for
`adapter: script`, where Crabline needs to know which OpenClaw channel the bridge
profile exercises.

## Smoke CI Profiles

Recommended initial smoke order:

1. `loopback`: no external dependencies.
2. `telegram` with polling mode: easiest live messaging smoke because it does
   not require a public webhook URL.
3. `slack`, `discord`, `matrix`, or `imessage`: depends on which shared test
   workspace/account OpenClaw already maintains.
4. `whatsapp`: needs a Meta app, a registered WhatsApp Business phone number,
   public webhook reachability, and a live recipient inside WhatsApp's messaging
   rules.
5. `script` bridge profiles: use OpenClaw's own channel credentials and bridge
   commands.

## Built-In Providers

### Loopback

Use for local development and deterministic contract tests.

Required secrets: none.

Provider:

```yaml
providers:
  local:
    adapter: loopback
```

Smoke fixture target:

```yaml
target:
  id: echo-bot
  behavior: echo
```

### Slack

Backed by `@chat-adapter/slack`.

Required secrets:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

External setup:

1. Create or reuse a Slack app in the smoke workspace.
2. Install the app to the workspace and grant bot scopes needed by the smoke
   fixture target.
3. Configure Slack Events to send to the public Crabline/OpenClaw webhook URL
   ending in the provider webhook path, usually `/slack/events`.
4. Subscribe to message events needed by the smoke fixture.
5. Invite the bot to the target channel, or use a dedicated test DM target.

Provider:

```yaml
providers:
  slack-smoke:
    adapter: slack
    env:
      - SLACK_BOT_TOKEN
      - SLACK_SIGNING_SECRET
    slack:
      webhook:
        publicUrl: https://example.ngrok.app/slack/events
```

Target notes:

- Raw channel ids are accepted, for example `C0123456789`.
- Encoded ids are also accepted, for example `slack:C0123456789`.
- For thread replies, set `target.channelId` and `target.threadId`.

### Discord

Backed by `@chat-adapter/discord`.

Required secrets:

- `DISCORD_BOT_TOKEN`

Optional config or env:

- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`

When application id or public key are omitted, Crabline resolves them from the
bot token.

External setup:

1. Create or reuse a Discord application and bot.
2. Install the bot into the smoke guild with permissions to read and send in the
   target channel.
3. For webhook delivery, configure the Discord interactions endpoint to the
   public Crabline/OpenClaw URL ending in `/discord/interactions`.
4. Keep a stable guild id and channel id for smoke fixtures.

Provider:

```yaml
providers:
  discord-smoke:
    adapter: discord
    env:
      - DISCORD_BOT_TOKEN
    discord:
      webhook:
        publicUrl: https://example.ngrok.app/discord/interactions
```

Target notes:

- Guild channels need `target.metadata.guildId`.
- Quote Discord snowflakes in YAML so they stay strings.
- DMs omit `target.metadata.guildId`; `target.id` is treated as a user id.

### Telegram

Backed by `@chat-adapter/telegram`.

Required secrets:

- `TELEGRAM_BOT_TOKEN`

Optional env:

- `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_API_BASE_URL`

External setup:

1. Create a bot with Telegram BotFather and store the bot token in
   `TELEGRAM_BOT_TOKEN`.
2. Have the dedicated smoke user send the bot an initial message so the bot can
   message that user.
3. Record the target user/chat id for the smoke fixture.
4. For CI polling mode, set `telegram.mode: polling` and do not configure a
   webhook.
5. For webhook mode, expose a public HTTPS URL ending in `/telegram/webhook` and
   set the bot webhook with the same secret token stored in
   `TELEGRAM_WEBHOOK_SECRET_TOKEN`.

Provider for first smoke CI:

```yaml
providers:
  telegram:
    adapter: telegram
    env:
      - TELEGRAM_BOT_TOKEN
    telegram:
      mode: polling
```

For disposable CI bots where the smoke job should ignore any Telegram updates
queued before the run starts, enable pending-update cleanup:

```yaml
providers:
  telegram:
    adapter: telegram
    env:
      - TELEGRAM_BOT_TOKEN
    telegram:
      mode: polling
      longPolling:
        deleteWebhook: true
        dropPendingUpdates: true
```

Provider for webhook smoke:

```yaml
providers:
  telegram:
    adapter: telegram
    env:
      - TELEGRAM_BOT_TOKEN
      - TELEGRAM_WEBHOOK_SECRET_TOKEN
    telegram:
      mode: webhook
      webhook:
        publicUrl: https://example.ngrok.app/telegram/webhook
```

Target notes:

- Raw `target.id` is encoded as `telegram:{chatId}`.
- Topics use `target.channelId` plus `target.threadId`, encoded as
  `telegram:{chatId}:{messageThreadId}`.
- Do not use another Telegram bot as the reply side; Telegram bots do not
  receive messages from other bots.

### WhatsApp

Backed by `@chat-adapter/whatsapp` for WhatsApp Business Cloud API.

Required secrets:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`

Optional env:

- `WHATSAPP_BOT_USERNAME`
- `WHATSAPP_API_URL`

External setup:

1. Create or reuse a Meta app with the WhatsApp product enabled.
2. Register or select the WhatsApp Business phone number for smoke tests.
3. Store the phone number id in `WHATSAPP_PHONE_NUMBER_ID`.
4. Generate a long-lived/system-user access token for CI and store it in
   `WHATSAPP_ACCESS_TOKEN`.
5. Store the Meta app secret in `WHATSAPP_APP_SECRET`.
6. Choose a webhook verify token and store the same value in
   `WHATSAPP_VERIFY_TOKEN`.
7. Configure the Meta WhatsApp webhook callback URL to the public
   Crabline/OpenClaw URL ending in `/whatsapp/webhook`.
8. Subscribe the webhook to message events.
9. Keep a dedicated recipient phone number for smoke tests and make sure the
   test conversation is inside WhatsApp's allowed messaging window, or add a
   future template-message path before attempting business-initiated smoke
   sends.

Provider:

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
      webhook:
        publicUrl: https://example.ngrok.app/whatsapp/webhook
```

Target notes:

- Raw `target.id` is the recipient WhatsApp id / phone number.
- Raw targets are encoded as `whatsapp:{phoneNumberId}:{userWaId}`.
- WhatsApp Cloud API does not provide normal message history, so smoke tests
  should rely on webhook delivery and the recorder.

### Matrix

Backed by `@beeper/chat-adapter-matrix`.

Required config or env:

- `matrix.baseURL` or `MATRIX_BASE_URL`
- `matrix.auth.accessToken` or `MATRIX_ACCESS_TOKEN`

Alternative auth env:

- `MATRIX_USERNAME`
- `MATRIX_PASSWORD`

Optional env:

- `MATRIX_USER_ID`
- `MATRIX_RECOVERY_KEY`

External setup:

1. Create or reuse a Matrix/Beeper bot account.
2. Join the bot to the smoke room.
3. Store base URL and auth in CI secrets.
4. Record the target room id.

Provider:

```yaml
providers:
  matrix-smoke:
    adapter: matrix
    env:
      - MATRIX_BASE_URL
      - MATRIX_ACCESS_TOKEN
    matrix:
      baseURL: https://matrix.example.com
```

Target notes:

- Room ids can be raw, for example `!room:example.com`.
- Crabline encodes raw room ids into Chat SDK Matrix ids.

### iMessage

Backed by `chat-adapter-imessage`.

Local mode:

- No Crabline env is required when `imessage.local` is true or omitted and the
  local adapter runtime is available.

Remote gateway mode secrets:

- `IMESSAGE_SERVER_URL`
- `IMESSAGE_API_KEY`

Optional env:

- `IMESSAGE_LOCAL=false` to force remote gateway mode.

External setup:

1. Choose local adapter mode or a remote iMessage gateway.
2. For remote gateway mode, store server URL and API key in CI secrets.
3. Record a stable chat guid or target id for the smoke fixture.

Provider:

```yaml
providers:
  imessage-smoke:
    adapter: imessage
    env:
      - IMESSAGE_SERVER_URL
      - IMESSAGE_API_KEY
    imessage:
      local: false
      serverUrl: https://imessage-gateway.example.com
```

## Script Bridge Providers

Script bridge providers exercise OpenClaw channels through external
commands instead of built-in providers. Crabline only needs OpenClaw bridge
credentials; per-channel secrets live in OpenClaw or that channel's OpenClaw
plugin configuration.

Required secrets for all script bridge profiles:

- `OPENCLAW_URL`
- `OPENCLAW_TOKEN`

Required provider fields:

- `adapter: script`
- `platform: <channel id>`
- `script.commands.send`
- `script.commands.waitForInbound`

Optional commands:

- `script.commands.probe`
- `script.commands.watch`

Shared provider template:

```yaml
x-openclaw-bridge: &openclaw-bridge
  adapter: script
  env:
    - OPENCLAW_URL
    - OPENCLAW_TOKEN
  script:
    commands:
      probe: node ./scripts/openclaw-bridge-probe.mjs
      send: node ./scripts/openclaw-bridge-send.mjs
      waitForInbound: node ./scripts/openclaw-bridge-wait.mjs
      watch: node ./scripts/openclaw-bridge-watch.mjs
```

For bridge smoke, `platform` is routing metadata passed to the bridge command.
It must match an OpenClaw channel id. Bridge platform ids are
`bluebubbles`, `discord`, `feishu`, `googlechat`, `imessage`, `irc`, `line`,
`matrix`, `mattermost`, `msteams`, `nextcloudtalk`, `nostr`, `signal`, `slack`,
`synologychat`, `telegram`, `tlon`, `twitch`, `webchat`, `whatsapp`, `zalo`,
and `zalouser`.

Telegram and WhatsApp can also be exercised through script bridge profiles when
the smoke goal is full OpenClaw channel routing rather than built-in
adapter behavior. In that case, use `platform: telegram` or `platform: whatsapp`
with the shared OpenClaw bridge secrets above.

### OpenClaw E2E Smoke CI

For OpenClaw E2E, Crabline can be wired in two ways:

1. Direct external-channel driver: a built-in Crabline adapter acts as the outside
   test identity on the real platform and sends messages to the OpenClaw bot or
   channel. This does not need an OpenClaw bridge, but it is only viable when
   the platform allows that test identity to talk to the OpenClaw SUT and observe
   replies.
2. OpenClaw QA bridge: a script provider delegates send/wait/probe to
   OpenClaw's own QA harness. This is the preferred path when the smoke run
   should use OpenClaw-owned credentials, OpenClaw private QA setup, or a channel
   topology that Crabline cannot drive directly.

The bridge path runs Crabline as a client against an already configured OpenClaw
smoke environment:

1. OpenClaw owns the real channel credentials and target-channel setup.
2. CI provides Crabline only `OPENCLAW_URL` and `OPENCLAW_TOKEN`.
3. The Crabline config contains one `adapter: script` provider per OpenClaw
   channel being exercised.
4. The bridge command maps Crabline's script payloads onto OpenClaw QA
   operations.
5. The job selects concrete fixture ids with `crabline run`.

OpenClaw already has a private QA stack for deterministic `qa-channel` scenarios
and live transport lanes such as Telegram, WhatsApp, Slack, and Discord. The
missing Crabline-specific piece is a small command/API wrapper that implements
Crabline's script adapter contract on top of that QA stack. That wrapper should
live with OpenClaw QA code because it knows OpenClaw's private QA CLI/API
surface.

`fixtures/examples/openclaw-bridge.yaml` is a catalog template. Do not run it
as-is in CI because its targets are placeholders. Use a private/generated smoke
config with stable test targets:

```yaml
configVersion: 1
userName: crabline

x-openclaw-bridge: &openclaw-bridge
  adapter: script
  env:
    - OPENCLAW_URL
    - OPENCLAW_TOKEN
  script:
    commands:
      probe: node ./scripts/openclaw-bridge-probe.mjs
      send: node ./scripts/openclaw-bridge-send.mjs
      waitForInbound: node ./scripts/openclaw-bridge-wait.mjs

providers:
  telegram-openclaw:
    <<: *openclaw-bridge
    platform: telegram
  whatsapp-openclaw:
    <<: *openclaw-bridge
    platform: whatsapp

fixtures:
  - id: telegram-openclaw-roundtrip
    provider: telegram-openclaw
    mode: roundtrip
    target:
      id: "123456789"
    inboundMatch:
      nonce: contains

  - id: whatsapp-openclaw-roundtrip
    provider: whatsapp-openclaw
    mode: roundtrip
    target:
      id: "15551234567"
    inboundMatch:
      nonce: contains
```

Minimal job shape:

```bash
pnpm install --frozen-lockfile
pnpm build
rm -rf .crabline/recorders
pnpm dev doctor --config crabline.smoke.yaml
pnpm dev run telegram-openclaw-roundtrip whatsapp-openclaw-roundtrip --config crabline.smoke.yaml
```

Crabline does not interpolate environment variables inside YAML today. If target
ids should not live in the repository, generate `crabline.smoke.yaml` in CI from
the CI secret store or fetch it from the same private place that owns the smoke
OpenClaw deployment.

Literal GitHub Actions setup:

1. Create a GitHub Environment, for example `crabline-smoke`.
2. Add environment secrets:
   - `OPENCLAW_URL`: public or private URL for the OpenClaw smoke bridge.
   - `OPENCLAW_TOKEN`: token accepted by that bridge.
3. Add environment variables for non-sensitive target ids, or secrets if the
   ids should be masked:
   - `CRABLINE_TELEGRAM_TARGET_ID`
   - `CRABLINE_WHATSAPP_TARGET_ID`
   - `CRABLINE_SMOKE_FIXTURES`, for example
     `telegram-openclaw-roundtrip whatsapp-openclaw-roundtrip`
4. Make the bridge commands available to the Crabline job. In practice, these
   should come from the OpenClaw checkout or an installed OpenClaw QA CLI because
   they wrap OpenClaw's private QA harness. The commands are the only part that
   knows the actual OpenClaw API surface.
5. Generate the concrete smoke config inside the workflow and run it.

Example workflow job:

```yaml
jobs:
  openclaw-smoke:
    runs-on: ubuntu-latest
    environment: crabline-smoke
    env:
      OPENCLAW_URL: ${{ secrets.OPENCLAW_URL }}
      OPENCLAW_TOKEN: ${{ secrets.OPENCLAW_TOKEN }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10.32.1

      - uses: actions/setup-node@v4
        with:
          cache: pnpm
          node-version: 22

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - name: Write Crabline smoke config
        run: |
          cat > crabline.smoke.yaml <<YAML
          configVersion: 1
          userName: crabline

          x-openclaw-bridge: &openclaw-bridge
            adapter: script
            env:
              - OPENCLAW_URL
              - OPENCLAW_TOKEN
            script:
              commands:
                probe: node ./scripts/openclaw-bridge-probe.mjs
                send: node ./scripts/openclaw-bridge-send.mjs
                waitForInbound: node ./scripts/openclaw-bridge-wait.mjs

          providers:
            telegram-openclaw:
              <<: *openclaw-bridge
              platform: telegram
            whatsapp-openclaw:
              <<: *openclaw-bridge
              platform: whatsapp

          fixtures:
            - id: telegram-openclaw-roundtrip
              provider: telegram-openclaw
              mode: roundtrip
              target:
                id: "${CRABLINE_TELEGRAM_TARGET_ID}"
              inboundMatch:
                nonce: contains

            - id: whatsapp-openclaw-roundtrip
              provider: whatsapp-openclaw
              mode: roundtrip
              target:
                id: "${CRABLINE_WHATSAPP_TARGET_ID}"
              inboundMatch:
                nonce: contains
          YAML
        env:
          CRABLINE_TELEGRAM_TARGET_ID: ${{ vars.CRABLINE_TELEGRAM_TARGET_ID }}
          CRABLINE_WHATSAPP_TARGET_ID: ${{ vars.CRABLINE_WHATSAPP_TARGET_ID }}

      - run: pnpm dev doctor --config crabline.smoke.yaml

      - run: pnpm dev run $CRABLINE_SMOKE_FIXTURES --config crabline.smoke.yaml
        env:
          CRABLINE_SMOKE_FIXTURES: ${{ vars.CRABLINE_SMOKE_FIXTURES }}
```

If the target ids are stored as GitHub secrets instead of variables, use
`${{ secrets.CRABLINE_TELEGRAM_TARGET_ID }}` and
`${{ secrets.CRABLINE_WHATSAPP_TARGET_ID }}` in the config-generation step.
Do not commit the generated `crabline.smoke.yaml`.

## Session Isolation

Normal `roundtrip` and `agent` runs are isolated from previous sessions by
default:

- Crabline creates a new nonce for each send attempt.
- Crabline records `since` immediately before sending and passes it into
  `waitForInbound`.
- Built-in recorder-backed providers ignore recorded events whose platform
  `sentAt` is older than `since`.
- Fixtures default to `inboundMatch.nonce: contains`, so an old response should
  not satisfy a new run.

Old sessions can still add noise in these cases:

- `watch` tails the configured recorder and can emit old entries unless the
  caller supplies a `since` value.
- Recorder JSONL files accumulate until the operator rotates or deletes them.
- Telegram polling can have pending updates from before the CI job starts.
- Webhook providers can receive platform retries from earlier deliveries.
- Script bridge commands can muddy results if they ignore Crabline's `since`,
  `threadId`, or nonce inputs.

Recommended CI hygiene:

1. Use dedicated smoke bots/accounts and dedicated target chats or recipients.
2. Keep the default nonce matcher for live smoke fixtures.
3. Use a run-scoped recorder path, or delete `.crabline/recorders` before each
   smoke job.
4. For Telegram polling profiles where old queued updates are not useful, set
   `telegram.longPolling.dropPendingUpdates: true`.
5. Make script bridge `waitForInbound` and `watch` commands filter by `since`,
   `threadId`, and nonce before returning an event.

## CI Secret Checklist

Minimum built-in smoke set:

```text
TELEGRAM_BOT_TOKEN
```

Webhook Telegram smoke adds:

```text
TELEGRAM_WEBHOOK_SECRET_TOKEN
```

WhatsApp smoke adds:

```text
WHATSAPP_ACCESS_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN
```

OpenClaw bridge smoke adds:

```text
OPENCLAW_URL
OPENCLAW_TOKEN
```

Run the same checks locally or in CI before enabling a profile:

```bash
pnpm dev doctor --config fixtures/examples/crabline.example.yaml
pnpm dev probe <fixture-id> --config fixtures/examples/crabline.example.yaml
pnpm dev roundtrip <fixture-id> --config fixtures/examples/crabline.example.yaml
```
