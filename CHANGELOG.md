# Changelog

## Unreleased

- Parse Google signing certificates as X.509 and redact Discord and Slack webhook tokens before recorder persistence.
- Contain WhatsApp acceptance timeout cleanup failures, enforce compressed binary-node payload limits, and require explicit interop JID server tokens.
- Preserve class-based OpenClaw bridge adapters, reject non-native Mattermost target identifiers, and close successful Signal probe bodies.
- Bound shared HTTP responses, Matrix sync payloads, stalled webhook DNS recovery, unmatched request bodies, and admitted local-mock hook cleanup.
- Reject Signal JSON-RPC integral IDs that cannot round-trip safely while preserving fractional and string IDs, and register SSE clients before exposing connected response headers.
- Keep Telegram multipart fields prototype-safe, synthetic chat IDs within 52 significant bits, and topic identities scoped to their chats.
- Preserve opaque Mattermost identifiers exactly instead of trimming REST and WebSocket inputs.
- Preserve Zalo polling arrival order until each older HTTP response commits.
- Classify empty Zalo and Mattermost webhook credentials as configuration failures.
- Confine Discord's generated recorder path to Crabline's recorder directory.
- Isolate the local iMessage adapter from ambient gateway environment variables and accept native nested `imsg` notifications.
- Reject empty loopback cursors, preserve Slack edit event identity, and prune settled WhatsApp wait cursors during concurrent waits.
- Use the canonical Matrix identifier validators for local targets and webhook envelopes.
- Classify empty JWT key sets and failed refresh cooldowns as signing-key infrastructure failures.
- Reject malformed UTF-8 and empty explicit config paths, and require canonical Zalo header credentials.
- Keep channel setup defaults and secret-handling guidance synchronized with the schema.
- Escape C1 controls in JSON reports and fail commands whose successful payload cannot be serialized.
- Reject corrupt retained capability matrices before artifact rotation and cancel failed OpenClaw probe response bodies.
- Recursively inspect referenced local actions, include Go manifests in dependency review, and allow production package source-map checks to complete under load.
- Cryptographically verify npm provenance and bind existing releases to the expected package digest, repository, workflow, tag, and commit.
- Keep server recorder hardlink transitions on compatible identity locks and reject non-regular recorder handles before publication.
- Bind Windows recorder and lock-root ACL checks to validated no-follow namespaces, with owner-only ACLs for Crabline-managed directories.
- Fail closed when Windows script Job Object containment is unavailable.
- Stream Telegram multipart uploads with bounded parser metadata instead of copying complete files through `FormData`.
- Keep Unix recorder identity locks in one validated private per-user namespace across processes and recorder path changes.
- Reject non-positive Telegram admin message IDs and enforce native Mattermost channel types and unique normalized usernames.
- Preserve local-mock webhook acceptance when clients disconnect or post-commit settlement hooks fail.
- Scope iMessage direct waits and Matrix and Mattermost thread correlation to their native conversations.
- Open Windows recorder files with truncation-capable handles while preserving serialized append behavior.
- Keep Matrix incremental syncs sparse while separating canonical local identities from historical event senders.
- Reject Signal RPC calls that select an account the local daemon does not serve.
- Coordinate recorder repair by file identity, limit existing-file durability syncs to the immediate parent, and reject provider lock roots beneath unsafe Unix namespaces.
- Stop retrying and resending accepted outbound messages after permanent inbound authentication or configuration failures.
- Escape visually unsafe Unicode controls in JSON reports, return a stable error document for unserializable values, and preserve Node write encoding semantics in test captures.
- Ignore typeless Slack callbacks and redact URL fragments from Zalo recorder evidence.
- Redact Feishu verification tokens from recorder payloads and release replay reservations after recorder failures.
- Reject Windows ACL reparse and identity substitution, bound PowerShell ACL execution, and allow harmless inherit-only mutation ACEs.
- Bind agent acknowledgements to the expected nonce instead of accepting an unrelated ACK.
- Skip aborted Windows script helper bootstrap and retry Job Object isolation after transient bootstrap failures.
- Bound manifest file loading, honor probe retries, and reject empty resolved Zalo webhook secrets.
- Require exact provider readiness recorder routes, explicit v2 artifact pointers, and normalized missing-generation corruption errors.
- Track actionlint updates, container image pins, and pull-request governance in the repository security checks.
- Revalidate release tags before idempotent publication success and enforce the development toolchain's Node floor.
- Honor HTTP response age when caching JWT keys, reject unsupported critical JWS headers and malformed provider key metadata, preserve signing-service failure status, and protect webhook routing and framing headers.
- Enforce Telegram destination prefixes, username canonicalization, topic IDs, and signed 52-bit chat identifier boundaries.
- Bound GET and HEAD webhook bodies, reject invalid loopback callback exposure, and cancel response streams when clients disconnect.
- Bound stalled WhatsApp acceptance, reserve message IDs and one-time prekeys atomically, enforce Cloud text limits, align binary-node encode limits, and require native webhook envelopes.
- Verify downloaded npm tarball integrity, retry transient provenance lookups, and revalidate release tags immediately before publication mutations.
- Validate effective fixture mode overrides and stop retrying permanent provider send failures.
- Bound watch iterator return and provider cleanup during CLI shutdown, forcing process exit after deadline failures.
- Correct provider-native channel target examples, admin-ingress setup, and contract maintenance coverage.
- Document the complete ready and script-bridge channel matrix and validate the shipped example against the manifest schema.
- Preserve native Slack rich text and block fallbacks, isolate Feishu replay identities, ignore non-message Google Chat interactions, and fail closed on invalid Zalo adapter inputs.
- Correlate complete NAT64 discovery pairs and retain DNS capacity until abandoned lookups settle.
- Verify loopback bindings by their listening address, sanitize framing and connection-nominated Fetch response headers, and advertise usable endpoints for every wildcard address spelling.
- Route local-mock GET hooks through the real server and parse structured JSON media types as JSON.
- Bound Matrix and Mattermost committed state, authenticate and redact native Mattermost outgoing webhooks, enforce native transport, post lifecycle, and direct-channel identity semantics, and serialize Signal timestamps, SSE cleanup, JSON-RPC strings, and username identity.
- Enforce Telegram native identity and UTF-16 entity boundaries without synthetic chat collisions, while accepting four-character collectible chat usernames and scheduled zero message IDs.
- Randomize WhatsApp server credentials, canonicalize direct delivery JIDs, restrict read receipts to accepted inbound messages, and bound queued, session, and binary-node resources without evicting live Signal sessions.
- Reject malformed, unencodable, or non-canonical loopback v2 addresses instead of aliasing thread identities.
- Reject invalid loopback encoder components and history timestamps while preserving lossless address round trips and monotonic message order.
- Encode generic local-mock target components without channel or thread identity collisions while preserving canonical target idempotence.
- Keep fixture-local iMessage target IDs separate from provider-native thread aliases.
- Case-fold Zalo recorder credential keys and fully redact ambiguous malformed URL authorities.
- Keep lazy provider watches registered for cleanup after nonterminal iterator throws.
- Version artifact generations so legacy recorder manifests can migrate while new snapshots retain explicit presence, locality, identity, and completeness checks.
- Terminate complete Windows script process trees through kill-on-close Job Objects.
- Create private publication ancestry with owner-only permissions, recognize trusted Windows system ownership, and fence file publication and recursive removal with identity-checked mutation claims.
- Revalidate recorder hardlink identities with full-width file IDs, persist full path durability on every append, canonicalize newly created durability boundaries through symlink aliases, recover recycled recorder-owner PIDs, departed runtime namespaces, terminated worker contexts, malformed or interrupted owner publication, post-publication verification failures, stale pre-upgrade locks, and aged exact owners after repeated identity inspection failures behind identity-checked durable recovery claims and directory-scoped abandonment markers, preserve cross-platform machine fencing and shared Windows coordination behind cached private local roots that detect inode reuse and ACL changes and recover once after concurrent deletion or replacement without hanging on continuous churn, retry transient release coordination and disappearing Windows repair paths, fall back to non-attach Darwin process identities, use identity-verified Windows tail repair, bind stale-claim owner fingerprints across inspection and cleanup, preserve retained claims for their originating wrapper before identity inspection, fence failed publication and partial recovery-chain cleanup without deleting replacement paths, and create or migrate owner-only Windows lock roots.
- Randomize WhatsApp XEdDSA signatures with fresh entropy while preserving their wire encoding.
- Suppress serve readiness output when shutdown begins during ready-file publication.
- Treat Unicode format characters as continuations when recognizing standalone acknowledgement tokens.
- Stream webhook responses with backpressure and cancel unfinished bodies when clients disconnect.
- Keep timed-out signed-JWT key loads single-flighted during a bounded cooldown, fence late generations, and reject malformed or oversized remote key sets.
- Distinguish Microsoft Teams signing-service failures from invalid bearer tokens and preserve invoke response status semantics.
- Preserve committed provider recorder errors during final identity confirmation and strictly parse quoted JWT cache lifetimes.
- Lint repository tooling in the type-aware verification gate.
- Preserve WhatsApp acknowledgement races by sharing in-flight acceptance results without stale pending state or false deduplication.
- Derive Telegram multipart media identity from upload bytes while preserving filenames and file reference reuse.
- Require valid OpenClaw readiness recorder evidence and allow unauthenticated loopback callback URLs.
- Merge repeated WhatsApp handshake message occurrences according to protobuf semantics.
- Close inherited credential descriptors and preserve runtime failure classification and accepted-send diagnostics.
- Validate every configured webhook callback independently and gracefully drain admitted provider responses before bounded connection teardown.
- Preserve Telegram media identity and username chat types, and honor top-level generic topic fallbacks.
- Confine generated local-mock recorder paths by rejecting absolute and parent-traversal provider IDs.
- Accept native Zalo image callbacks, honor injected webhook auth environments, and bound recursive credential redaction.
- Use one case-insensitive numeric identity for Telegram username chats across provider sends, OpenClaw inbound injection, and recorder correlation.
- Validate signed-JWT registered claims, clock skew, and synchronous key-loader failure cleanup.
- Reject stale or far-future signed Discord interactions before payload handling.
- Normalize malformed callback URLs, artifact pointers, and loopback thread addresses into stable domain errors.
- Honor injected WhatsApp runtime credentials during delayed webhook startup.
- Generate Signal bundle public keys with the provider-required type prefix while preserving raw WhatsApp wire encoding.
- Reject nonce fixture IDs outside the extractor alphabet and share one validation boundary.
- Keep smoke-lock staging claim-local, confine commit paths, and add backward-compatible sub-second Darwin process identities.
- Reject provider and fixture timer durations above Node's supported ceiling.
- Round-trip every supported WhatsApp handshake protobuf variant without dropping fields.
- Reject unsupported Zalo thread targets during normalization, matching OpenClaw bridge execution.
- Enforce Discord uint64 snowflakes and Telegram safe-integer chat and topic identifiers.
- Reject credential-bearing CLI arguments and add bounded stdin or inherited-fd ingress for `serve` secrets.
- Bound fixture inbound candidate tracking, reuse compiled regex matchers, and keep deadlines monotonic across wall-clock changes.
- Bound shared JSON ingress, reject non-object payloads precisely, and strictly normalize loopback IP addresses.
- Commit Signal sends only after recorder publication, emit canonical native source numbers, and canonicalize OpenClaw outbound recipient identity.
- Harden WhatsApp send evidence, direct-JID correlation, cursor and cleanup races, and cleartext listener exposure.
- Revalidate npm package version, integrity, and provenance after every release publication outcome.
- Authenticate Feishu signatures before encrypted callback decryption and bound callback ciphertext work.
- Correct Slack edited-message identity and text fallback handling, acknowledge unsupported callbacks, and fairly budget Events API address failover.
- Preserve provider recorder cursors across parse failures, report post-commit lock cleanup failures without rejecting committed appends, and synchronize hardlink aliases.
- Confine server recorder publication and locking to stable resolved paths and explicitly shared hardlink identities across symlink retargets, preserve Signal timestamp capacity after rejected queue admission, start observers in durable append order without blocking later requests, snapshot observed events, classify post-commit lock cleanup failures, and preserve existing file modes.
- Cover local GitHub Actions with ownership, CodeQL, immutable image, and test-tool runtime policies.
- Publish Matrix direct-room account data and share strict native identifier validation across server, target, and inbound paths.
- Materialize Mattermost thread roots, keep root posts channel-scoped, and reject oversized WebSocket post events atomically without disconnecting unrelated clients.
- Create Windows private files with atomic owner-only ACLs before publishing credentials.
- Protect pnpm install-script policy and enforce immutable action pins across reusable workflows and composite actions.
- Stop shipping a non-runnable OpenClaw script fixture and clarify source-checkout CLI invocation.
- Bind npm and GitHub release mutations to the revalidated tag commit and fail closed on release lookup errors.
- Correct the OpenClaw artifact setup guide to reflect runtime pruning of abandoned generations.
- Enforce native Telegram username bounds, map OpenClaw inbound usernames to numeric chat identities, and align direct sender identity.
- Bound JWKS cache lifetimes and start unknown-key refresh cooldowns after refresh completion.
- Require HTTPS public URLs for authenticated external webhook ingress while preserving loopback-local HTTP.
- Reject webhook paths changed by URL normalization and clear stale response headers before fallback errors.
- Expose synchronous provider cleanup fences and prune inactive LocalMock wait cursors after concurrent waits settle.
- Tighten Telegram message, entity, username-target, and webhook-secret fidelity; reject malformed Feishu message content; and align Mattermost ingress IDs, REST bodies, and WebSocket post events.
- Acknowledge authenticated non-message chat callbacks without recording them, and tighten Slack, Google Chat, Teams, Zalo, Matrix, and shared local-mock normalization.
- Stop suite dispatch while timed-out cleanup is unsettled and report every requested or skipped fixture.
- Require exact agent acknowledgement tokens with canonical nonces and safely normalize non-string error messages.
- Canonicalize recorder aliases, bound lock and rotation retries, preserve rotated-inode writers during rollback, classify published provider writes, and redact rejected Zalo webhook targets.
- Bound script process-tree cleanup after Windows termination failures and redact positional command and JWT environment secrets from diagnostics.
- Harden provider adapter authentication, target identity, credential redaction, and webhook lifecycle behavior.
- Harden release provenance retries, provider-native contract tests, cross-platform tooling, cleanup ordering, and channel setup coverage.
- Stop `serve` after closed-pipe output, withdraw readiness before shutdown, and retain ownership when server close fails.
- Harden serve shutdown ownership, manifest ingress validation, webhook paths, provider secrets, and fixture retry bounds.
- Harden core CLI lifecycle, manifest validation, retry bounds, error reporting, and suite isolation after unsettled provider cancellation.
- Pin and validate Slack Events API delivery targets across redirects while preserving native retries and installation authorization envelopes.
- Harden provider recorder durability and replacement recovery, JWT cache expiry refresh, and LocalMock webhook shutdown draining.
- Harden recorder append durability, Baileys shutdown draining, and provider-native HTTP, identity, profile, authentication, ingress, and redaction fidelity.
- Preserve OpenClaw thread and direct-recipient identity, persist recorder and directory metadata, and prevent stale smoke-lock release from fencing successors.
- Make WhatsApp Web inbound acceptance retry-safe across recorder persistence, Signal ratchets, one-time prekeys, and acknowledgements; bound identity mappings and tighten request and crypto fallback handling.
- Prevent pre-aborted WhatsApp listeners and preserve monotonic recorder progress across concurrent waits.
- Recover stale Baileys acknowledgements into bounded recent deduplication without duplicate delivery.
- Reject mismatched direct WhatsApp bridge identities while accepting matching device JIDs and distinct group senders.
- Advertise usable loopback endpoints for wildcard-bound servers, own buffered HTTP response framing, and enforce Signal JSON-RPC media types, UUIDs, and monotonic timestamps.

## 0.1.11 - 2026-07-13

- Contain Telegram response delivery failures when clients disconnect during request handling.
- Recover interrupted artifact and recorder writes, publish immutable readiness evidence, and harden private-directory and smoke-lock durability.

## 0.1.10 - 2026-07-13

- Emit nested OpenClaw streaming config from the Matrix and Mattermost provider bridges.
- Harden CLI secret ingress and numeric parsing, provider cancellation and script thread propagation, timer bounds, review fixtures, and dependency review coverage.
- Complete final provider remediation across authenticated webhook exposure, native callback decoding, interaction values, target identities, JWT boundaries, and bounded ingress shutdown.
- Fan out queued Signal events, tighten Matrix, Slack, Mattermost, Telegram, and Zalo protocol fidelity, and exercise DNS-pinned webhook delivery.
- Harden OpenClaw Matrix, Slack, Telegram, WhatsApp, Mattermost, and Zalo bridge identity and accepted-send contracts, make WhatsApp transport lifecycle cleanup failure-atomic, and declare the direct-only Baileys outbound subset.
- Harden secondary provider adapters with stable pagination, scoped native IDs, immutable diagnostics redaction, Slack edit normalization, and bounded WhatsApp ingress.
- Harden provider-core webhook hooks, recorder durability and cursor semantics, lazy adapter lifecycle and target parity, and signed-JWT key caching.
- Harden autoreview launchers and release automation, document trusted script manifests, and canonicalize WhatsApp Cloud targets.
- Reject unauthenticated public provider webhooks and tighten Discord, Feishu, Google Chat, Matrix, and Teams inbound protocol validation.
- Enforce native Matrix, Mattermost, Signal, and Slack outcomes, pagination, retries, state, JSON-RPC, WebSocket, HTTP response, and recorder privacy contracts.
- Harden OpenClaw artifact publication identity and cleanup, and align Mattermost, Matrix, Signal, Slack, Telegram, and WhatsApp bridge contracts.
- Bound fixture execution and script input, harden CLI pipe output and manifest parsing, and preserve watch cleanup and stateless inbound progress.
- Harden Telegram, WhatsApp, and Zalo webhook validation, delivery acknowledgement, identity correlation, media metadata, and accepted-send evidence.
- Bound signed-JWT key refreshes and authenticate, decode, or suppress Google Chat, Teams, Feishu, and Discord webhook ingress according to provider contracts.
- Bound recorder tail memory, harden shared provider cleanup and inbound matching, and reject non-global webhook targets.
- Recover backpressured Signal events without recording rejected RPC calls.
- Preserve bounded Matrix transaction replay and limited-sync state, and honor environment identity.
- Validate Mattermost roots, direct users, typing, and post ownership before mutation or delivery.
- Enforce safe Telegram identities while acknowledging valid unsupported updates.
- Align Slack callback, thread-history, and message-text behavior with its native protocol.
- Canonicalize WhatsApp identities and accepted-send evidence, publish webhook batches atomically with bounded retry deduplication, and preserve Zalo updates across disconnects and concurrent polls.
- Harden shared runtime cleanup, terminal and script diagnostics, smoke artifact rollback, test helpers, source maps, and stable release publication.
- Report Crabline provider readiness without claiming OpenClaw execution, require accepted exact-route recorder events for outbound delivery, pin production package exports and public types, and document canonical WhatsApp targets.
- Harden release, CI, config, CLI, package, and OpenClaw artifact and process-identity boundaries.
- Restore provider-native callbacks and authentication, preserve conversation targets and recorder progress, and harden local mock lifecycle and parsing.
- Preserve native server sync, webhook, request-validation, backpressure, and shutdown semantics across Matrix, Mattermost, Signal, Slack, Telegram, and Zalo.
- Bound WhatsApp WebSocket flow control, validate native auth and JID roles, and reject low-order X25519 peers.
- Preserve Zalo polling updates across disconnects and webhook changes, reject future Matrix sync tokens, normalize JSON media types, and bound Signal SSE clients and buffers.
- Authenticate configured Discord interactions, answer native PING requests, exclude outbound mock records from inbound matching, filter WhatsApp webhooks by phone number, and validate loopback pagination limits.
- Bound WhatsApp binary-node complexity and signal bundles, align encoder and decoder limits, preserve coherent X25519 fallback behavior, validate queue startup before listening, keep reconnect delivery FIFO, and accept bounded legacy group JIDs.
- Preserve primary watch and adapter-start failures, retain shutdown handlers through cleanup, validate smoke-lock tokens, enforce Zalo probe envelopes, and reject ambiguous config names and formats.
- Preserve provider-native WhatsApp message acknowledgements, legacy group JIDs, bounded inbound admission, WebSocket error isolation, and strict handshake varints.
- Authenticate built-in Telegram, Slack, and Zalo webhooks, bound recorder wait state, accept Slack user send targets, preserve canonical Telegram topics, and complete WhatsApp cleanup after close failures.
- Harden HTTP stream failure handling, bound Mattermost WebSocket delivery, move Slack rate-limit controls out of provider payloads, drain Slack callback bodies, and validate release dispatch and existing release state.
- Harden ready-file replacement and artifact cleanup, use linear-time inbound regex matching, reject blank channel selections, redact malformed JSON details, and preserve slash-containing QA thread targets.
- Hold serve ready-file ownership across startup and shutdown, preserve live manifests on failed replacement, and retain compound cleanup failures.
- Reject invalid matchers and provider/fixture mismatches before side effects, drain aborted provider work before cleanup, preserve frozen primary smoke failures, and recover stale smoke locks after PID reuse.
- Preserve Slack thread scope and validate Telegram command entities.
- Authenticate WhatsApp webhook verification and deliveries and reject malformed batches atomically.
- Cancel silent script watches and redact configured payload secrets from subprocess diagnostics.
- Bind release provenance to exact tag refs, pin the publish npm client, and align Node types with the Node 22 runtime floor.
- Sanitize malformed YAML diagnostics without exposing source lines.
- Bound disconnected inbound queues, expire unauthenticated Mattermost sockets, block mapped private Zalo targets, and enforce absolute webhook deadlines.
- Reject truncated WhatsApp GCM tags, invalid handshake wire types, and trailing binary-node data.
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
