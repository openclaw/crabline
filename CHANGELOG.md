# Changelog

## Unreleased

- Hold serve ready-file ownership across startup and shutdown, preserve live manifests on failed replacement, and retain compound cleanup failures.
- Reject invalid matchers and provider/fixture mismatches before side effects, drain aborted provider work before cleanup, preserve frozen primary smoke failures, and recover stale smoke locks after PID reuse.
- Authenticate WhatsApp webhook verification and deliveries and reject malformed batches atomically.
- Cancel silent script watches and redact configured payload secrets from subprocess diagnostics.
- Randomize externally bound provider credentials, preserve Slack MPIM and Matrix sync errors, bound server shutdown, and enforce safe Zalo webhooks.
- Order lazy cleanup after admitted dispatch, isolate loopback message state, and enforce effective modes and inbound deadlines.
- Fence OpenClaw smoke artifact paths, clean abandoned generations safely, preserve primary probe failures and replacement files, and report post-commit lock cleanup failures.
- Isolate verified release packaging from OIDC-enabled npm publication and inspect the generated tarball before upload.
- Reject Telegram protocol errors returned with HTTP 200 and preserve numeric identities without unsafe integer coercion.
- Retire serve ready files on shutdown, preserve replacement manifests, and redact text-mode credentials unless explicitly requested.
- Pin privileged release workflow actions to immutable revisions.
- Redact inherited secret-named environment values from script diagnostics.
- Verify production tarballs through their installed npm command shims.
- Enforce Telegram method and long-poll contracts, hide shared server exception details, and return native Matrix filter and internal errors.
- Preserve recorder continuity across file replacement, keep fixture waits on one outbound until a match, and require canonical nonce tokens.
- Enforce provider capability and adapter-config contracts, share native target normalization across lazy adapters, and make WhatsApp cleanup terminal.
- Serialize WhatsApp Noise frames per session and reject invalid X25519 peer keys.
- Serialize recorder persistence, atomically switch owner-only OpenClaw smoke generations under ownership-safe renewable locks, secure stable file identities with platform-native permissions, and enforce strict QA target and recorder normalization.
- Make CLI failures machine-readable, preserve stage-specific failure contracts, validate fixture provider references, redact script commands, and verify production-only tarball installs.
- Normalize provider bridge thread IDs and round-trip canonical Telegram topic targets.
- Drain authentication-rejected provider bodies, bound Zalo parsing, and enforce Telegram media fields.
- Hide webhook handler exception details from public 500 responses.
- Implement Telegram `getUpdates` long polling with timeout wakeups, offset confirmation, negative offsets, and shutdown cleanup.
- Restrict releases to stable version tags and resolve workflow-dispatch inputs through exact tag refs before publication.
- Reject ambiguous fixture/config inputs and keep the published CLI, type dependencies, and README assets aligned with their public contract.
- Poll recorder JSONL incrementally while preserving incomplete trailing records.
- Serialize local mock and WhatsApp webhook startup and cleanup, and honor explicit public webhook URL precedence.
- Bound Matrix, Mattermost, Signal, Slack, and WhatsApp request bodies, validate JSON object payloads with native errors, and keep rejected authentication out of recorder events.
- Harden release packaging and retries, and make cleanup scripts portable across supported platforms.
- Export the OpenClaw conversation type from the package root.
- Harden CLI lifecycle cleanup, ready-file publication, run diagnostics, and config validation.
- Harden script provider subprocess limits and result validation, recorder polling and JSONL parsing, and local webhook startup and IPv6 URLs.
- Fix built-in runtime fidelity for Discord component interactions, split UTF-8 script output, and opaque Microsoft Teams conversation IDs.
- Fix provider normalization for loopback pagination and thread codecs, Telegram edited channel posts, Feishu and Matrix thread roots, and complete WhatsApp webhook batches.
- Harden provider server fidelity with idempotent Matrix send transactions, valid Telegram IPv6 URLs, provider-native malformed JSON errors, signed Slack Events API delivery, and bounded Zalo webhook delivery.
- Serve WhatsApp Cloud API requests on provider-native Graph routes, queue acknowledged Baileys inbound messages until a session opens, and bound binary frame decoding.
- Accept uint64 unknown fields in WhatsApp handshakes and bound recursive binary-node decoding.
- Harden OpenClaw bridges for provider-level probe failures, whitespace-preserving message capture, stable symbolic Telegram IDs, and unsupported thread targets.
- Reject invalid Telegram topic IDs in explicit OpenClaw QA targets instead of silently dropping or coercing them.
- Bound every OpenClaw provider probe to five seconds and label timeout failures.

## 0.1.9 - 2026-07-03

- Add in-process provider event observers while retaining JSONL recorder artifacts.

## 0.1.8 - 2026-07-03

- Add the Zalo provider server with an isolated OpenClaw bridge.

## 0.1.7 - 2026-07-01

- Add Telegram native command entities to OpenClaw admin inbound injection.

## 0.1.6 - 2026-06-29

- Add Telegram media send support to the local server for `sendPhoto`, `sendDocument`, `sendVideo`, and `sendAnimation`.

## 0.1.5 - 2026-06-29

- Rename fake-server internals and public server APIs while preserving fake-provider compatibility aliases and artifact paths.

## 0.1.4 - 2026-06-29

- Add the Baileys WebSocket WhatsApp fake provider server for OpenClaw WebSocket URL smoke runs.

## 0.1.3 - 2026-06-26

- Add the Slack fake provider server and WhatsApp runtime socket factory to the releasable package.
- Preserve generated WhatsApp inbound message IDs when recorder-backed runtime sockets replay admin inbound messages.

## 0.1.1 - 2026-06-24

- Add the WhatsApp fake provider server with Baileys-style mock socket support for OpenClaw QA runs.
- Move OpenClaw fake-provider binding code to typed per-provider bridge adapters for Telegram and WhatsApp.
- Update release and CI GitHub Actions dependency pins.

## 0.1.0 - 2026-06-23

- Harden deterministic provider mocks, fake Telegram APIs, recorder isolation, cleanup, and CLI behavior.
- Add repository security automation, CodeQL, dependency review, stale handling, and provenance-capable npm releases.
- Add package documentation and OpenClaw ecosystem branding.

## 0.0.0 - 2026-06-23

- Harden repository automation, security policy, and npm release plumbing.
