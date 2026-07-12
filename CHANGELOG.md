# Changelog

## Unreleased

- Restrict releases to stable version tags and resolve workflow-dispatch inputs through exact tag refs before publication.
- Reject ambiguous fixture/config inputs and keep the published CLI, type dependencies, and README assets aligned with their public contract.
- Poll recorder JSONL incrementally while preserving incomplete trailing records.
- Serialize local mock and WhatsApp webhook startup and cleanup, and honor explicit public webhook URL precedence.
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
