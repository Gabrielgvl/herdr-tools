# Spec: Large agent communications

## Objective

Let one Herdr agent send a large text message to another exact Herdr agent without
changing Herdr core, without truncating the payload, and without ever handing a
recipient a reference it cannot read.

Before this change, `herdr_communicate` (`prompt`/`steer`) and the `herdr_launch`
assignment embedded the whole v1 envelope in a single `herdr agent prompt` argv argument. That argument
is bounded by the operating system (Linux caps one argument at 128 KiB), is visible
to any local process listing, and offers no way to hand a recipient a plan, diff, or
review body that does not belong inline in a prompt.

This slice adds two explicit delivery routes over the existing Herdr CLI:

- `inline` — the complete v1 envelope is written to `herdr agent prompt --stdin`;
- `attachment` — the sender-authored text is published to a Herdr-Tools-owned local
  attachment store and the recipient receives a small v1 envelope containing an
  exact file reference plus mandatory retrieval instructions.

Both routes are named by the caller, reported in every result, and never substituted
for each other.

## Validated product decisions

- Herdr Core is not changed. No Rust work, no new CLI surface, no new Herdr API.
- `researcher-agy` is the research default and uses `gemini-3.8-flash-low` with
  fixed `--mode plan` and `--dangerously-skip-permissions`. `scout-agy` is the
  reconnaissance default, also uses `gemini-3.8-flash-low`, with `--mode plan` and chain `scout-agy -> scout-claude ->
  scout-devin -> scout-pi`; `worker-devin` is the implementation default and chains
  through `worker-pi` before `worker-claude`. Researcher's exact chain is
  `researcher-agy -> researcher-claude -> researcher-devin -> researcher-pi`.
  `worker-agy` remains directly selectable with fixed `--mode accept-edits` and
  `worker-agy -> worker-claude`. Primary
  model and bounded `addDirs` overrides never leak into fallbacks, and AGY mode is
  never launch-overrideable. Worker accept-edits plus the permission bypass can
  auto-approve mutations, so manager assignments must bound scope and tests.
- Inline text uses the existing `herdr agent prompt <TARGET> --stdin` transport for
  every wrapped text delivery, including the small attachment-reference envelope.
- Large text is stored by `herdr-tools` in a local attachment store it owns
  end-to-end. Herdr never sees, stores, or transports the attachment body.
- Recipient retrieval is bounded: the extension publishes an immutable UTF-8 text
  file with an exact byte count and SHA-256, and the recipient reads it with its own
  bounded read tool.
- Routes are explicit and visible. There is no silent fallback in either direction:
  an oversized `inline` request fails, and an `attachment` request to a recipient
  whose file-read capability is not known fails. Neither failure sends bytes.
- Both entry points are covered: `herdr_communicate` (`prompt` and `steer`) and
  `herdr_launch.assignment`. Named-key delivery is control input, is never
  wrapped, and gains nothing here.
- Mandatory v1 provenance is preserved. The envelope gains additive fields; the
  sentinel, version, `from`, `kind`, and `authority` lines keep their meaning and
  order. Callers still cannot suppress or forge provenance.
- No auto-acknowledgement. The extension sends exactly one message, never waits for
  completion, and the envelope explicitly tells the recipient not to acknowledge
  unless the sender's own text asks for it.
- First slice is text-only, atomic and owner-only on disk, recipient-scoped,
  quota- and expiry-bounded, and never logs a message body.
- Every bundled Pi, Claude, and AGY profile can read attachments. Pi profiles read the
  absolute path with the default `read` tool. Claude and AGY profile launches receive an
  extension-owned `--add-dir` for that recipient's own attachment directory. AGY is not
  registered for later recipient or attachment delivery until exact-session strengthening.
- Unprofiled or incapable targets fail visibly with a typed error instead of
  receiving an unusable reference.

## Delivery routes

### Route selection

`delivery` is an explicit caller field with the default `inline`:

| Request | Payload size | Result |
| --- | --- | --- |
| `inline` (or omitted) | ≤ 16 KiB | inline envelope over `--stdin` |
| `inline` (or omitted) | > 16 KiB | `PAYLOAD_TOO_LARGE_FOR_INLINE`; nothing sent |
| `attachment` | ≤ 1 MiB | attachment published, reference envelope over `--stdin` |
| `attachment` | > 1 MiB | `PAYLOAD_TOO_LARGE`; nothing published, nothing sent |

`attachment` is honoured for small payloads too, because the caller may deliberately
want the body out of the recipient's prompt. The extension never upgrades an
`inline` request to `attachment`, and never degrades an `attachment` request to
`inline`.

### Inline route

The existing v1 envelope, plus the new `delivery: inline` header line, is written to
the child process standard input exactly once:

```text
herdr agent prompt <TARGET> --stdin
```

No text delivery uses `--wait`, `--until`, or a synthesized Enter. For
`herdr_communicate`, the fresh snapshot agent record, `agent get`, and pane records
are the complete identity source: one strict join must establish the exact pane ID,
terminal ID, agent name/kind, and complete `agent_session`, while every supplied field
must agree and omitted/null fields remain absent. For a Pi or Claude
`herdr_launch.assignment`, real Herdr protocol 22 `agent_started` records may omit
identity fields. Launch therefore runs one bounded, read-only identity-readiness
preflight with short polling before dispatch or recipient registration. Every sample
freshly reads snapshot, `agent get`, and pane, and joins that one sample only with fields
actually supplied by `agent_started`. No missing component is carried from an earlier
sample. A complete start field may cover a fresh omission, but a missing start session
must be present in one sample. Contradiction, timeout, or caller abort fails closed with
bounded evidence. A pane, name, and kind match alone is insufficient.

AGY is the only exception. One coherent idle sample may lack native `agent_session`
when it proves pane, terminal, name, kind, sequence, and revision. The launch publishes
a live, non-cancellable provisional supervisor, submits the mandatory visible
self-contained assignment once, then requires the full native session and lifecycle
advancement within the existing five-second confirmation window. An observer-backed
transaction drains provisional events before publishing exact coverage. Recipient and
attachment capability registration happens only after strengthening and semantic
confirmation. Pane and terminal continuity is not cryptographic attribution during
this AGY-only reduced-assurance window, and Herdr Tools cannot eliminate that residual
risk without a Herdr Core change.

This is identity readiness, not a prompt retry. Stdin remains zero or one submission,
with no Enter, runtime hook, fallback after possible effect, cleanup, reservation
release, or duplicate bytes. Herdr's optional working-state observation can report
`agent_prompt_stalled` after accepting the bytes, and headless panes commonly return
`screen_detection_skipped:true` with an idle post-state. A successful
`cli:agent:prompt` / `agent_prompted` envelope must match the full captured Pi or Claude
identity, or the provisional AGY pane, terminal, name, and kind. It must also carry
interactivity proof — `interactive_ready:true` (managed), or a known live
`agent_status` when the flag is absent and `launch_pending` is absent or `false` (detection) —
and safe `revision`. This is the atomic submission acknowledgement.
It confirms acceptance, not turn progress or completion. The follow-up agent/pane reads are optional identity-bound
observation and report working, non-working, unknown, skipped, stale, or
unavailable without resubmitting the body; a replacement is never described as
the original target.

Pi's `pi.exec` helper spawns children with `stdio: ["ignore", "pipe", "pipe"]` and
has no input option, so the extension adds one narrow stdin-capable executor of its
own. It keeps every existing guarantee: explicit `herdr` executable, argv array,
`shell: false`, the same bounded timeout, and the same `AbortSignal` handling. A
timeout or abort sends `SIGTERM` and escalates to `SIGKILL` after a bounded grace
period (default 5 s), so a child that ignores termination cannot hang the tool call;
every timer and listener is cleared on the first settle. The executor records the
child's actual `exit` code/signal before resolving `close`, so an abort delivered in
the exit-to-close window cannot turn a successful code-0 acknowledgement into a
killed result.

Failure evidence for a stdin delivery is fixed and non-textual — exit code, killed
flag, per-stream presence, exact byte size, and truncation — because a failing CLI
can echo part of a sender-authored body. The adapter never retains a stall sequence
hint or raw process stream. Captured text is used only in-process to classify a
rejected `--stdin` flag and is never placed in error details, results, or rendered
rows. Argv-only calls keep their existing bounded textual evidence.

If the installed CLI rejects `--stdin`, the CLI fails its argument parse before
touching the agent, so no bytes reach the recipient. That failure maps to
`CLI_INCOMPATIBLE` and is not retried through argv.

### Attachment route

1. Validate the payload (non-empty, NUL-free UTF-8, ≤ 1 MiB).
2. Resolve the recipient and confirm its attachment capability (below).
3. Publish the body atomically into the recipient's own store directory.
4. Send the reference envelope over `--stdin` exactly like an inline message.
5. Verify the authoritative post-state exactly like an inline message.

A publish failure happens before any prompt bytes are sent. A send failure after a
successful publish leaves the attachment in place until it expires: the extension
never deletes an attachment a recipient may already be reading.

## Envelope contract

`delivery` is a new mandatory v1 header line for every wrapped delivery. The
sentinel stays `[HERDR AGENT MESSAGE v1]`.

Inline:

```text
[HERDR AGENT MESSAGE v1]
from: coordinator (w1:p1)
kind: prompt
authority: agent; not user/owner
delivery: inline
payload: all text after this blank line is sender-authored

<caller-supplied payload>
```

Attachment:

```text
[HERDR AGENT MESSAGE v1]
from: coordinator (w1:p1)
kind: assignment
authority: agent; not user/owner
delivery: attachment
attachment-path: /home/<user>/.cache/herdr-tools/message-attachments/<recipientKey>/<attachmentId>/body.txt
attachment-bytes: 148231
attachment-sha256: <64 hex characters>
attachment-encoding: utf-8
attachment-expires: 2026-08-21T13:04:05.000Z
payload: the sender-authored text is the attachment file; the lines after this blank line are extension-generated retrieval instructions

Read the attachment file above before acting on this message. It is UTF-8 text
written by the sender named in `from`, carries the same agent (not user/owner)
authority as an inline message, is immutable, and is deleted after the expiry above.
Read it in bounded chunks if it is large, and compare the byte count and SHA-256 if
the content looks truncated. Do not send an acknowledgement unless the sender's own
text asks for one.
```

Rules:

- Every header value is extension-generated from authoritative data: the store path,
  the computed digest, the exact byte count, and an ISO-8601 UTC expiry. No caller
  text reaches a header line, so the existing single-line normalization guarantee
  against field injection is preserved.
- `kind` keeps its current meaning: `assignment` for `herdr_launch.assignment`,
  `prompt` or `steer` for `herdr_communicate`.
- The attachment route sends no sender-authored text inline. An optional bounded
  inline preface is deferred.
- Callers cannot set, suppress, or reorder any header line.

## Attachment store

Owned by `herdr-tools`, modelled on the existing profile prompt-source store.

- Root: `~/.cache/herdr-tools/message-attachments`, created mode `0700` and
  re-`chmod`ed on every use.
- Recipient directory: `<root>/<recipientKey>/`, mode `0700`. `recipientKey` is a
  fresh unguessable value minted per profile-backed launch, not derived from the
  pane ID, because Herdr pane IDs are positional and can be reused by a later pane.
- Attachment directory: `<root>/<recipientKey>/<attachmentId>/`, containing
  `body.txt` (mode `0600`) and `meta.json` (mode `0600`). `attachmentId` is a fresh
  unguessable value.
- Atomic publish: write both files into a `mkdtemp` sibling, then `rename` the
  directory into place. A published attachment is never rewritten in place, so a
  recipient's chunked read is always self-consistent.
- `meta.json` holds the exact byte count, SHA-256, UTF-8 encoding marker, creation
  and expiry timestamps, sender pane ID and display, the recipient pane ID when
  authoritative placement already knows it (otherwise the field is omitted),
  recipient agent name, and the originating tool operation. It never holds the
  body.
- Bounds, all fixed constants in this slice:
  - `MESSAGE_INLINE_MAX_BYTES` = 16 KiB;
  - `ATTACHMENT_MAX_BYTES` = 1 MiB;
  - `ATTACHMENT_STORE_QUOTA_BYTES` = 64 MiB;
  - `ATTACHMENT_STORE_MAX_RECORDS` = 256;
  - `ATTACHMENT_RETENTION_HOURS` = 24.
- Cross-process serialization: publication takes an exclusive `<root>/.lock`
  directory (created non-recursively, so creation is the atomic test-and-set) and
  holds it across abandoned-staging purge, expiry sweep, quota check, staging, and
  rename. The lock is the quota reservation: two processes cannot both pass the
  boundary check. Acquisition retries a bounded number of attempts (default
  200 × 25 ms) and then fails with `ATTACHMENT_STORE_FAILED` and `operation: "lock"`.
  `.lock` is never scanned as a recipient.
- Lock ownership is an explicit lease, never an age guess. The holder writes
  `<root>/.lock/owner.json` with an unguessable token and an ISO `renewedAt`, renews it
  at each publish phase boundary, and **validates the token immediately before the
  commit rename** — a publication whose lease was reclaimed aborts with
  `operation: "lock_validate"` instead of racing the new owner. Release is
  ownership-checked: a holder deletes the lock only while its own token is present, so a
  slow owner can never delete a replacement owner's lock. A lock is reclaimable only
  when its lease has not been renewed for a full `DEFAULT_LOCK_LEASE_MS` (30 s) **and**
  the same token is still present on a confirming second read; a marker that is
  unreadable, malformed, or changing between reads is treated as unsafe to reclaim. A
  lock directory whose owner marker never appeared is reclaimed only once the directory
  itself has aged past the lease. A failed release is not fatal: the abandoned lease
  expires and the next publisher reclaims it under the same rules.
- Abandoned-staging purge, under the lock and before any quota decision: staging
  directories only ever exist while the lock is held, so every `.tmp-*` directory
  found at that point is a crash remnant and is deleted. An attachment directory
  whose `meta.json` is missing (`ENOENT`) is likewise an interrupted publication and
  is deleted; any other metadata read failure fails closed. Crash-left bodies
  therefore cannot evade expiry or inflate the quota basis.
- Expiry sweep runs only inside a publish call, never on a timer, and never from the
  extension factory. It removes attachment directories whose recorded expiry has
  passed, then removes empty recipient directories that no live launch grant claims.
  A sweep failure is a typed, body-free failure, not a silent success.
- A launch grant is an owned lease over a recipient directory, not a grace period. A
  profile-backed launch writes `<root>/<recipientKey>/.grant.json` with an unguessable
  token before the agent starts, renews it before delivering the prompt, and releases it
  when the launch finishes; the marker never counts as directory content. Sweeping skips
  a directory whose grant was renewed within `DEFAULT_GRANT_LEASE_MS` (5 minutes,
  comfortably longer than the 120 s agent-start window), and reclaims only abandoned or
  released grants. Renew and release are ownership-checked, so a superseded launch can
  neither refresh nor delete a newer launch's grant. This is what keeps a Claude
  `--add-dir` path alive while its agent is still starting.
- Quota is enforced after the purge and sweep, against the post-purge scan.
  Exceeding the byte quota or the record cap fails the publish with
  `ATTACHMENT_QUOTA_EXCEEDED`. Live attachments are never evicted to make room,
  because eviction could break a pending recipient read.
- Session shutdown does not delete attachments. Recipients outlive the sending Pi
  session, and expiry is the only deletion trigger.
- Recipient scoping is a contract and an access-narrowing measure, not an operating
  system boundary: every store file belongs to the same local user. The unguessable
  recipient key plus the per-recipient Claude `--add-dir` grant means one launched
  Claude agent cannot enumerate another recipient's attachments, and a reused pane ID
  cannot inherit a previous recipient's directory.

## Recipient capability

An attachment reference is only useful to a recipient that can read a local absolute
path. Capability is derived from the profile that launched the recipient, recorded in
a session-scoped in-memory registry, and rechecked against fresh authoritative state
before every attachment send.

- `attachmentCapability(profile, overrides)` returns capable/incapable plus a reason,
  evaluated against the **effective post-override runtime**, because a typed call
  override can remove the read tool the reference depends on:
  - `pi`: capable when the effective `tools` (override if present, else profile) is
    empty (the default tool set includes `read`) or explicitly includes `read`;
  - `claude`: capable when the effective `disallowedTools` excludes `Read` and the
    effective `allowedTools` is either empty or includes `Read`;
  - `agy`: capable because launch grants its recipient directory with fixed
    `--add-dir`; only `model` and scope-normalized `addDirs` may be overridden.
  Typed override validation runs first, so an incompatible-kind override still fails
  as `INVALID_PROFILE_OVERRIDE` rather than as a capability refusal.
- Every bundled Pi, Claude, and AGY profile satisfies this today. A user or project Pi
  or Claude profile that removes its read capability is reported incapable, not repaired.
- Profile-backed `herdr_launch` mints the recipient key, ensures the recipient
  directory, and records `paneId → { recipientKey, profileName, kind, capable,
  reason, terminalId, agentName, agentKind, agentSession, agentId }` in the registry
  on success. An AGY record is committed only after exact-session strengthening and
  semantic assignment confirmation. The pane, terminal, name, kind, and complete
  session object are the binding; `agentId` is optional diagnostic metadata only.
- Claude and AGY profile launches additionally receive an extension-owned
  `--add-dir <root>/<recipientKey>`. Profile `addDirs` cannot express this path because
  they are validated as relative to the profile scope root, so the grant belongs to
  the launch adapter, not to profile configuration.
- Launch is profile-only (ADR 008, profile-only launch and bounded fallback), so every
  launch produces a registry record. An attachment launch requires **every** profile in
  the resolved fallback chain to be capable, because any of them may be the one that
  actually starts and receives the reference; the first incapable profile refuses the
  launch with `ATTACHMENT_TARGET_UNVERIFIED` before any topology mutation. An inline
  launch records the chosen profile's capability as-is, capable or not.
- The registry follows the existing ownership rules: it lives in the current runtime
  only, is cleared on session start and shutdown, and is never reconstructed from
  session entries, labels, or Herdr metadata.
- Before an attachment send, `herdr_communicate` requires a registry record for the
  resolved pane whose recorded pane, terminal, name, kind, and complete session
  identity still match the fresh authoritative snapshot and the pre-send join. A
  provisional AGY supervisor never satisfies this requirement. A same-name/pane
  replacement therefore fails even when `agent_id` is absent or
  unchanged. A missing record, an incapable record, or an identity mismatch fails
  with `ATTACHMENT_TARGET_UNVERIFIED` and sends nothing.
- Recovery for an unverified target is explicit: send `inline`, or relaunch the
  recipient from a profile in the current runtime. The extension never guesses.

## Tool contracts

### `herdr_communicate`

```text
{ target: TargetRef, operation: "prompt", text: string, delivery?: "inline" | "attachment" }
{ target: TargetRef, operation: "steer",  text: string, delivery?: "inline" | "attachment" }
{ target: TargetRef, operation: "keys",   keys: NamedKey[] }
```

- `delivery` defaults to `inline`. `keys` rejects `delivery` as an unknown field.
- `text` must be non-empty and NUL-free; a NUL is `INVALID_INPUT`.
- Existing behaviour is otherwise unchanged: sequential execution, fresh snapshot,
  sender resolution, self-target rejection, `TARGET_BUSY` for a working `prompt`,
  direct prompt/steer submission without wait flags, and body-free submission plus
  optional-observation evidence. A complete identity-bound `agent_prompted`
  acknowledgement is required; a missing, malformed, contradictory, or mismatched
  identity/acknowledgement sends no second submission. Paired agent/pane reads may
  report working, non-working, unknown, skipped, stale, or unavailable after the
  acknowledgement without changing its confirmed status. `postState` and the
  success-row state are emitted only when the full identity still matches; a
  replacement is omitted from authoritative fields and appears only as bounded
  mismatch evidence. Named keys remain a separate lower-level raw dispatch
  escape hatch, including `esc`, `escape`, and `ctrl+c`; they do not claim the
  verified cancel/interrupt semantic or causal contract and are not routed
  through it.
- Order for an attachment send: preflight → snapshot → sender → target →
  capability recheck → pre-state → publish → prompt over `--stdin` → post-state.
- `details` gains `delivery`, `envelope.delivery`, `submission`, `observation`, and
  for the attachment route `attachment: { attachmentId, path, bytes, sha256, expiresAt,
  recipientPaneId }`. It never contains the body, and no existing field is removed.
- The route is established before any precondition, and one body-free wrapper adds it to
  every failure. A failure keeps its typed code and gains `delivery` and `phase`
  (`validate`, `resolve_target`, `verify_recipient`, `pre_state`, `publish`, `send`, or
  `post_state`), plus `route` once the operation is known. `SELF_TARGET_REJECTED`,
  `TARGET_BUSY`, `KEY_REJECTED`, `ATTACHMENT_TARGET_UNVERIFIED`, and oversize refusals
  therefore all name the requested route. When the attachment was already published, the
  failure also gains `attachmentRetained: true` and the same body-free `attachment`
  block, because the file stays on disk until it expires.

### `herdr_launch`

```text
{ ..., assignment: { objective: string, scope: string, verification: string }, assignmentDelivery?: "inline" | "attachment" }
```

- `assignment` is mandatory and carries exactly `objective`, `scope`, and
  `verification`, each a non-empty string without NUL; a missing, empty, extra, or
  legacy `initialPrompt`/`initialPromptDelivery` field is `INVALID_INPUT`. The three
  fields render in that fixed order, and the rendered payload's UTF-8 size is the
  single authority for the selected delivery bound.
- `assignmentDelivery` defaults to `inline`.
- `assignmentDelivery: "attachment"` requires every profile in the resolved
  fallback chain to be attachment-capable. An incapable profile fails with
  `ATTACHMENT_TARGET_UNVERIFIED` while the profile is resolved, before any topology
  mutation.
- Storage happens before topology mutation, matching ADR-006: resolve profile →
  check capability → create a Pi or Claude prompt source → mint recipient key and
  directory → publish attachment → build argv with the runtime's recipient
  `--add-dir` grant where required → create pane/tab → start agent → run runtime-specific
  readiness → send exactly one identity-bound envelope over `--stdin` → validate the
  typed acknowledgement → confirm semantics. AGY creates no profile-body prompt source,
  requires the same typed `assignment`, publishes provisional supervision before submission, and
  strengthens to the official native session before recipient registration or later
  attachment delivery. The fresh joined
  identity is mandatory for Pi and Claude on every launch, and the same full
  pane/terminal/name/kind/session binding is persisted in the recipient registry;
  `agent_id` is diagnostic only. Building profile argv therefore moves after the
  recipient key is minted. A newly-created pane has no authoritative pane ID before
  placement, so its pre-placement attachment metadata omits `recipientPaneId`; final
  launch details and the in-memory recipient record bind the key to the authoritative
  pane and agent identity. Existing-pane placements include the known pane ID in
  metadata. Working-state detection is not delivery confirmation:
  `interactive_ready`, `revision`, `state_change_seq`, and
  `screen_detection_skipped` are retained as bounded evidence, and idle/done/blocked,
  stale, or unavailable observation never triggers Enter or a duplicate prompt.
  A replacement post-read is retained only as bounded mismatch evidence; it is never
  returned as `postState`, rendered as success-row state, or used for registration.
- A launch failure still performs no cleanup: created panes and tabs remain and are
  reported, and a published attachment remains until expiry. After any possible AGY
  prompt effect, launch also retains provisional supervision and never retries, falls
  back, releases its reservation, or registers the recipient.
- `details` gains `initialPromptDelivery`, `initialPromptSubmission`,
  `initialPromptObservation`, the same `attachment` block, and the recipient record
  identity. Streamed progress gains an `attachment_publish` phase before `placement`.
- Failure details keep the existing partial-launch codes (`LAUNCH_FAILED`,
  `READY_TIMEOUT`, `POSTSTATE_UNAVAILABLE`, `ABORTED`) and `created`/`causeCode`
  evidence, and add `phase`, `delivery`, `initialPromptDelivery`, and, once the
  attachment is published, `attachmentRetained: true` plus the body-free `attachment`
  block. Pre-topology refusals keep their own typed codes because nothing was mutated,
  and still carry the route: an incapable profile reports
  `ATTACHMENT_TARGET_UNVERIFIED` with `phase: "resolve_profile"`, and a store failure reports
  `ATTACHMENT_STORE_FAILED`/`ATTACHMENT_QUOTA_EXCEEDED` with
  `phase: "attachment_publish"`. Post-publication argv construction runs inside the same
  guarded block, so an argv failure also reports the retained attachment.

### `herdr_inspect`

Unchanged in this slice. An attachment-metadata inspect mode is deferred.

## Error taxonomy additions

- `PAYLOAD_TOO_LARGE_FOR_INLINE`: inline route payload exceeds the inline bound. No
  bytes sent, nothing published. Details carry exact byte counts and the bound.
- `PAYLOAD_TOO_LARGE`: attachment route payload exceeds the attachment bound.
- `ATTACHMENT_TARGET_UNVERIFIED`: no capable, identity-matched recipient record in
  this runtime. Nothing published, nothing sent.
- `ATTACHMENT_STORE_FAILED`: store root, recipient directory, lock, purge, sweep,
  publish, or metadata read/write failed. Details carry the failing operation
  (`ensure_root`, `ensure_recipient`, `lock`, `purge_staging`, `purge_incomplete`,
  `sweep`, `list_recipients`, `list_attachments`, `read_metadata`, `publish`,
  `validate_recipient`) and a bounded path, never the body.
- `ATTACHMENT_QUOTA_EXCEEDED`: store byte quota or record cap reached after the
  abandoned-staging purge and expiry sweep.
- `CLI_INCOMPATIBLE` is reused when the installed CLI does not accept `--stdin`.

Existing codes keep their meaning. No new code substitutes a guessed route, a
truncated payload, or a fabricated success.

## Security and safety boundaries

- The stdin executor is the only process-execution path that is not `pi.exec`. It
  keeps the same explicit-executable, argv-array, no-shell contract and exists only
  because `pi.exec` cannot write standard input. It is used for nothing but
  `herdr agent prompt --stdin`.
- Moving payloads from argv to stdin removes message bodies from
  `/proc/<pid>/cmdline` and from any local process listing.
- Message bodies never appear in tool content, `details`, error details, progress
  updates, TUI rows, job notifications, or store diagnostics. Only identifiers,
  paths, byte counts, digests, and timestamps are reported.
- Store files are owner-only (`0700` directories, `0600` files) and atomically
  published under an exclusive store lock. The store holds sender-authored text, so it
  is exactly as sensitive as the messages themselves and is bounded and expired
  accordingly.
- A failing CLI may echo part of a delivered body, so stdin-delivery failures expose
  no process text at all — only exit code, killed flag, per-stream presence, byte
  size, and truncation.
- The attachment envelope restates agent (not user/owner) authority, so a recipient
  cannot be tricked into treating attached text as owner instruction.
- Recipient capability is never inferred from an agent kind alone, and never asserted
  by the caller.

## Tech stack

- TypeScript 5.9, TypeBox, Pi extension APIs, Herdr CLI JSON contracts.
- `node:child_process` `spawn`, `node:crypto` `createHash`/`randomUUID`, and
  `node:fs/promises` for the stdin executor and the store. No new dependency.
- Herdr 0.8 CLI as installed: `herdr agent prompt <TARGET> --stdin`.

## Commands

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration
```

## Project structure

```text
src/exec-stdin.ts               stdin-capable spawn executor (argv array, no shell)
src/cli.ts                      optional stdin executor injection and error mapping
src/messages/limits.ts          inline/attachment/quota/retention constants
src/messages/store.ts           locked atomic store: purge, sweep, quota, publish
src/messages/recipients.ts      session-scoped recipient capability registry
src/messages/failure.ts         body-free delivery failure evidence
src/profiles/capability.ts      attachmentCapability(profile, overrides)
src/profiles/adapters.ts        extension-owned Claude --add-dir grant
src/provenance.ts               v1 delivery and attachment header lines
src/schemas.ts                  herdr_communicate delivery field
src/launch-schema.ts            assignment and assignmentDelivery fields
src/tools/communicate.ts        route selection, capability recheck, publish, send
src/tools/launch.ts             pre-mutation publish ordering and argv grant
src/tui.ts                      delivery-aware call/result rows
index.ts                        store and recipient registry wiring, session reset
test/unit/                      store, recipients, capability, envelope, tool tests
test/integration/               disposable-session inline and attachment delivery
```

## Code style

Strict discriminated data, fail closed, no silent route change:

```ts
type MessageDelivery = "inline" | "attachment";

type PreparedDelivery =
  | { delivery: "inline"; envelope: string }
  | { delivery: "attachment"; envelope: string; attachment: PublishedAttachment };

function assertInlineSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MESSAGE_INLINE_MAX_BYTES) {
    throw Object.assign(new Error("Payload exceeds the inline message bound"), {
      code: "PAYLOAD_TOO_LARGE_FOR_INLINE",
      details: { bytes, limit: MESSAGE_INLINE_MAX_BYTES, delivery: "inline" }
    });
  }
}
```

Reject unknown fields, NUL bytes, oversized payloads, unverified recipients, and
store failures. Never infer a route, never trim a payload, never echo a body.

## Testing strategy

Unit tests with injected IO and a fake executor:

- store, over a real temporary filesystem with targeted failure injection: owner-only
  modes, atomic publish, immutability, exact digest and byte count, metadata shape
  without a body, expiry sweep, quota and record-cap rejection, abandoned `.tmp-*` and
  metadata-less record purge, every typed store failure operation;
- store locking: a live publisher that keeps renewing past the lease interval while two
  competitors attempt acquisition (both refused, owner token unchanged), abandoned-lease
  reclaim, unreadable/malformed/changing owner markers treated as unsafe to reclaim,
  orphan lock directory aged out, lease loss aborting a staged publication with the
  replacement lock intact, ownership-checked release, release failure, concurrent
  publication at the record cap in one process, and concurrent publication at the record
  cap across two operating-system processes (exactly one publication admitted in both);
- launch grants: a grant surviving a sweep 90 s into a launch and again after a renewal
  past the full lease, an abandoned grant reclaimed, a released grant leaving nothing
  behind, and a superseded grant unable to renew or delete the newer one;
- recipients: capability derivation for every bundled profile, incapable Pi and
  Claude tool restrictions, capability-removing and capability-restoring typed
  overrides, registry record and reset on session start/shutdown, identity-mismatch
  rejection, missing-record rejection;
- envelope: additive `delivery` line for both routes, attachment header values,
  header injection resistance, preserved sentinel and authority lines;
- stdin transport: argv array and `shell: false`, input written and stream closed,
  timeout and abort parity with `pi.exec`, `SIGTERM`-to-`SIGKILL` escalation for a
  child that ignores termination (mocked and real), timer/listener cleanup on every
  settle path, EPIPE and non-zero exit mapping, and no process text or payload
  fragment in stdin-delivery failure evidence, including partial echoes;
- `herdr_communicate`: default inline route, oversized inline rejection, explicit
  attachment route ordering, unverified target rejection with nothing sent, `keys`
  rejecting `delivery`, unchanged busy/steer/post-state behaviour;
- `herdr_launch`: pre-mutation publish ordering, Claude and AGY `--add-dir` grants,
  incapable fallback-chain rejection before mutation, capability-removing override rejection before
  storage or mutation, registry record on success, retained resources and retained
  attachment evidence on failure;
- failure evidence: typed code preserved with `delivery`, `route`, `phase`, and
  body-free retained attachment metadata for publish, send, and post-read failures;
- rendering: delivery-aware success and error rows that never print a body.

Integration runs in a disposable named session where every extension call, including
stdin deliveries, is routed through that session: a session-bound stdin executor is
injected exactly like `pi.exec`, and stdin payloads are captured separately from argv.
The suite separates gating acceptance from non-gating evidence.

**Gating acceptance — recipient readback.** One test per bundled runtime requires both a
*confirmed* delivery and evidence only the recipient could produce: the attachment body
carries a fresh token that appears nowhere in the envelope or argv and instructs the
agent to write it to an exact marker path, and the test polls for that marker. A
launched bundled Pi, Claude, and strengthened AGY profile agents must each read their
own attachment. Claude and AGY use their granted `--add-dir` directories.
Host-side reads of the published file are transport evidence and never substitute for
recipient evidence. If a delivery cannot be confirmed, the acceptance test records a
bounded failure with the exact code and phase and fails; it never converts the missing
acknowledgement into a skipped or passing readback claim.

**Non-gating transport smoke.** A separate test records confirmed delivery, or records
bounded failure evidence before rethrowing it, and asserts route and artifact
invariants: inline delivery over `--stdin`, a regression check that no payload text
reaches argv, and the published attachment's exact bytes, digest, and `0600` mode taken
from success or from retained-attachment failure evidence. It makes no claim about what
any recipient read, but a post-feature delivery failure still fails the run.

Environment-independent behaviour stays strict: `ATTACHMENT_TARGET_UNVERIFIED` refusals
for an unregistered recipient pane and for an incapable profile must carry the
route and phase and send nothing. The run removes the recipient directories it created
and never mutates or closes the active user workspace.

## Boundaries

### Always

- Name the route in the request, the envelope, the result, and the TUI row.
- Verify recipient capability against fresh authoritative state before publishing.
- Publish atomically with owner-only permissions before sending any prompt bytes.
- Keep bodies out of every log, result, and diagnostic.
- Preserve mandatory v1 provenance and the no-auto-ack contract.

### Ask first

- Raising any inline, attachment, quota, or retention bound.
- Adding non-text attachments, compression, or chunked multi-part messages.
- Persisting recipient capability across Pi sessions.
- Any change that would require Herdr core work.

### Never

- Fall back between routes, truncate a payload, or send a reference a recipient
  cannot read.
- Infer capability from an agent kind, a pane label, or a caller assertion.
- Delete a live attachment to satisfy a quota, or delete attachments on shutdown.
- Put a message body in argv, an error detail, a notification, or a rendered row.
- Add a shell, a second executable, or a Herdr socket implementation.

## Slice success criteria

- [ ] A ≤ 16 KiB `prompt` or `steer` is delivered over `--stdin` with the additive
      `delivery: inline` envelope line and unchanged state semantics.
- [ ] A > 16 KiB `inline` request fails with `PAYLOAD_TOO_LARGE_FOR_INLINE` and
      sends nothing.
- [ ] A 1 MiB `attachment` request publishes an owner-only atomic attachment and
      delivers a reference envelope whose digest and byte count match the file.
- [ ] Launched bundled Pi, Claude, and strengthened AGY profile agents each read their
      own attachment in a disposable session, proven by recipient-produced evidence.
      An unconfirmed delivery leaves that criterion explicitly blocked rather than
      satisfied.
- [ ] An unregistered or incapable target fails with `ATTACHMENT_TARGET_UNVERIFIED`
      before any publish or send, naming the requested route and phase.
- [ ] Expired attachments are swept, quota exhaustion fails visibly, and no live
      attachment is evicted.
- [ ] A live publisher's lock is never reclaimed while its lease is renewed, and a
      publication whose lease is lost aborts instead of committing.
- [ ] A launch grant keeps its recipient directory for the whole start window.
- [ ] No test, result, notification, or rendered row contains a message body.
- [ ] Unit, typecheck, lint, build, and integration gates are green.

## Assumptions and open questions

- "Bounded recipient retrieval" is implemented as a bounded published artifact plus
  the recipient's own bounded read tool, because Claude recipients cannot call this
  Pi extension's tools. A `herdr_inspect` attachment-metadata mode is deferred.
- The installed CLI's own maximum inline prompt size is unknown; the 16 KiB inline
  bound is chosen to stay well under any plausible Herdr-side cap and to keep large
  bodies out of recipient context by default.
- CLI `--stdin` support is detected by attempting the documented flag and mapping an
  argument-parse failure to `CLI_INCOMPATIBLE`, rather than by parsing the reported
  client version, because version strings are not a reliable capability contract.
- Attachment expiry is wall-clock based on the recorded ISO timestamp; a large clock
  change can retain or expire an attachment early. Deletion is never destructive to
  repository content.
- Cross-session attachment sends are deliberately impossible in this slice. Whether
  durable capability records are worth their reconciliation cost is deferred.
- Known environment behavior, outside this repository: an agent in a **headless named
  Herdr session** may accept a prompt while its optional working-state observation is
  skipped. The direct command can return `agent_prompted` with `agent_status: idle`,
  `screen_detection_skipped: true`, and a revision that is unchanged while the TUI
  later renders and processes the assignment. The disposable integration covers this
  as confirmed submission plus explicit observation evidence; it does not claim a
  working transition or completion.
- Prompt delivery never uses a keystroke recovery. The atomic acknowledgement is the
  only acceptance claim; malformed, killed, or mismatched responses fail closed, and
  a stale/unavailable follow-up read is reported as observation without retrying or
  exposing stdin process text.
