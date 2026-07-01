# AGENTS.md

## Provider Server Fidelity

- Provider servers under `src/servers/` must emulate the real provider's public
  protocol as faithfully as practical for the supported subset. Implement
  provider-native routes, authentication, status codes, errors, payloads,
  event ordering, connection behavior, and state transitions. Do not implement
  an OpenClaw-shaped shortcut merely because it satisfies one current caller.
- A provider server must remain independently usable by any compatible client.
  Its production code must not import OpenClaw code or contain OpenClaw-specific
  configuration, target syntax, QA assumptions, or conditional behavior.
- OpenClaw integration may live in this repository only under OpenClaw-specific
  bridge code such as `src/openclaw/bridges/`. Gateway configuration, QA target
  translation, recorder normalization, and OpenClaw capability limitations
  belong there or in the OpenClaw repository, never in the provider server.
- Admin ingress is Crabline's out-of-band test control plane. It must translate
  injected state into the provider's normal inbound transport and observable
  behavior rather than exposing a QA-only path to provider clients.
- Verify new provider behavior against authoritative provider documentation or
  source and, when practical, an actual client implementation. Tests that only
  prove OpenClaw accepts the mock are not sufficient evidence of protocol
  fidelity.

## Documentation

- Keep `docs/channel-setup.md` current whenever provider/channel support,
  per-channel secrets, smoke CI setup, adapter config, or example fixtures
  change.
- If a channel is added, removed, moved between built-in and script bridge
  support, or gets new required/optional env vars, update
  `docs/channel-setup.md` in the same change.
- Keep `README.md`, `src/config/schema.ts`, `src/providers/catalog.ts`, and
  `fixtures/examples/*.yaml` aligned with the setup walkthrough.
