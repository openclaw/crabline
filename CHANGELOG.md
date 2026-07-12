# Changelog

## Unreleased

- Harden release packaging and retries, and make cleanup scripts portable across supported platforms.
- Export the OpenClaw conversation type from the package root.

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
