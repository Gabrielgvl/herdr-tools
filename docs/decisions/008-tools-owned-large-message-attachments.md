# ADR-008: Deliver large agent messages through a tools-owned attachment store

## Status

Accepted

## Date

2026-08-20

## Context

`herdr_communicate` and `herdr_launch.initialPrompt` embed the whole mandatory v1
provenance envelope in one `herdr agent prompt` argv argument. Linux caps a single
argument at 128 KiB, so a large plan, diff, or review body cannot be delivered at
all, and every delivered body is visible in local process listings. Even below that
cap, pushing a large body inline forces it into the recipient's context whether or
not the recipient needs all of it.

Herdr core already exposes `herdr agent prompt <TARGET> --stdin`, and a later Herdr
slice is planned to add structured turn results and durable result references
(ADR-006). Waiting for that runtime work would block a capability the current
extension can deliver on its own, but taking it now must not create a second
delegation surface, weaken provenance, or hand a recipient a reference it cannot
read.

Two facts constrain the design. First, Pi's `pi.exec` helper spawns children with
`stdio: ["ignore", "pipe", "pipe"]` and exposes no input option, so `--stdin` is
unreachable through the existing CLI adapter. Second, profile `addDirs` are validated
as relative to the profile scope root, so a profile file cannot grant a Claude agent
read access to a cache directory outside the extension tree.

## Decision

Add two explicit delivery routes to the existing tools, owned entirely by
`herdr-tools`, with no Herdr core change.

Route `inline` writes the complete v1 envelope to `herdr agent prompt --stdin`. Every
wrapped text delivery uses stdin, including the small attachment-reference envelope,
so no message body is ever passed through argv again. The extension adds one narrow
stdin-capable `spawn` executor that keeps the existing explicit-executable, argv
array, `shell: false`, bounded-timeout, and abort guarantees, and that is used for
nothing else. A CLI that rejects `--stdin` fails its argument parse before reaching
the agent; that maps to `CLI_INCOMPATIBLE` and is never retried through argv.

Route `attachment` publishes the sender-authored text into a Herdr-Tools-owned local
store at `~/.cache/herdr-tools/message-attachments`, then sends a small v1 envelope
carrying the exact path, byte count, SHA-256, encoding, and expiry, plus
extension-generated retrieval instructions. Publishing is atomic (`mkdtemp` plus
directory `rename`), owner-only (`0700` directories, `0600` files), immutable once
published, text-only, and bounded: 16 KiB inline maximum, 1 MiB per attachment,
64 MiB and 256 records per store, 24-hour retention. The expiry sweep runs only
inside a publish call, quota exhaustion fails visibly, and a live attachment is never
evicted or deleted on shutdown.

Store mutation is serialized by an exclusive `<root>/.lock` directory held across
abandoned-staging purge, expiry sweep, quota check, staging, and rename, so the lock
is also the quota reservation and two concurrent processes cannot both cross the
boundary. Because staging only happens under that lock, any `.tmp-*` directory or
metadata-less attachment directory present at acquisition is a crash remnant and is
purged before the quota basis is computed.

Lock ownership is a lease, not an age heuristic. The holder writes an unguessable token
with a renewal timestamp into `.lock/owner.json`, renews it at each publish phase
boundary, validates the token immediately before the commit rename, and releases the
lock only while its own token is present. A competitor may reclaim only a lease that has
gone unrenewed for a full lease interval and whose token is unchanged across a confirming
second read; unreadable, malformed, or changing markers are treated as unsafe to reclaim.
A publication whose lease was reclaimed anyway aborts at validation instead of racing the
new owner, and an ownership-checked release means a slow owner can never delete a
replacement owner's lock.

In-progress launch grants use the same ownership model. A profile-backed launch writes a
token-bearing `.grant.json` into its recipient directory before the agent starts, renews
it before delivering the prompt, and releases it when the launch ends. Sweeping skips
directories with a live grant and reclaims only abandoned or released ones, so a Claude
`--add-dir` path cannot be swept away during the 120-second start window — the failure
mode a fixed grace period left open.

`delivery` is an explicit caller field defaulting to `inline`, mirrored by
`initialPromptDelivery` on `herdr_launch`. The chosen route appears in the envelope,
the structured result, and the rendered row. There is no fallback in either
direction: an oversized inline request and an unverified attachment recipient both
fail with typed errors before any bytes are sent.

Attachment recipients are scoped and capability-gated. Each profile-backed launch
mints an unguessable recipient key, creates `<root>/<recipientKey>/`, and records the
recipient's pane ID, profile, agent identity, and derived capability in a
session-scoped in-memory registry that follows the existing ownership rules and is
never reconstructed. Capability is derived from the effective post-override runtime,
not from the profile file alone, because a typed call override can remove the read
tool the reference depends on. Claude profile launches receive an extension-owned
`--add-dir <root>/<recipientKey>` from the launch adapter, because profile
configuration cannot express that path; no bundled profile file changes, and every
bundled Pi and Claude profile is capable as written. An attachment send requires a
capable registry record whose recorded agent identity still matches the fresh
authoritative snapshot; a raw-kind launch, a missing record, an incapable profile, or
an identity mismatch fails with `ATTACHMENT_TARGET_UNVERIFIED`.

The `delivery` header line is additive within v1. The sentinel, `from`, `kind`,
`authority`, and payload-marker semantics are unchanged, callers still cannot forge
or suppress provenance, the attachment envelope restates agent (not user/owner)
authority, and the extension still sends exactly one message and never acknowledges.

## Alternatives considered

### Wait for Herdr core result/transcript references

Rejected for this slice. The planned runtime work (ADR-006 slice 2) is a larger
cross-repository change, and the constraint for this work is explicitly no Herdr core
change. The store here is a message-delivery artifact, not a competing result store.

### Keep argv and chunk the payload into several prompts

Rejected because multi-part prompts create ordering, interleaving, and partial
delivery failure modes for the recipient, multiply the provenance envelope, and still
expose bodies in process listings.

### Automatically switch to an attachment when the payload is too large

Rejected because a silent route change hides a real cost from the caller: an
attachment reaches the recipient as a reference it must choose to read, which is a
different interaction from an inline prompt. The caller names the route; the tool
reports it.

### Infer recipient capability from the agent kind

Rejected because a kind does not imply a readable path: a Claude agent needs a
directory grant, and a Pi profile can restrict its tool set. Guessing here produces
exactly the failure the owner ruled out — a recipient holding an unusable reference.

### Let callers assert recipient capability, or declare it in profile files

Rejected. A caller assertion is unverifiable, and profile `addDirs` cannot name a
path outside the profile scope root. The launch adapter is the only place that knows
both the runtime kind and the extension-owned store path.

### Content-address attachments like profile prompt sources

Rejected. Content addressing is useful for reusable profile bodies but leaks content
equality between messages and makes a reference guessable to anyone who knows the
text. Message attachments use unguessable identifiers instead.

### Evict the oldest live attachments when the store quota is reached

Rejected because eviction can delete a body a recipient is still reading. Quota
exhaustion is a visible failure.

### Serialize the store with an in-process mutex

Rejected because several Pi sessions and their launched agents run as separate
processes against one shared cache directory. An in-process guard would leave the
quota check, staging, and rename interleaved across processes. A filesystem lock
directory is the smallest primitive that actually covers that case, and it needs no
new dependency.

### Reclaim a lock purely by its age

Rejected after review. Age alone cannot distinguish a crashed publisher from a slow one,
so an age-only rule lets a competitor delete a live owner's lock and then lets the
original owner delete the replacement on release. Leases with ownership tokens,
per-phase renewal, pre-commit validation, and ownership-checked release remove both
failure modes; the age check survives only for a lock directory whose owner marker never
appeared.

### Use an established file-locking dependency

Considered, and rejected for this store. A library would bypass the injected IO seam the
store is built and tested on, which is exactly where the required concurrency, reclaim,
and lease-loss cases are exercised, and it would add a runtime dependency to reimplement
the same lease semantics in about the same amount of code.

### Give launch grants a fixed grace period instead of a lease

Rejected. A fixed grace has to be guessed against an agent-start window that Herdr caps
at 120 seconds, and the review found the 60-second grace could delete a Claude
`--add-dir` path mid-launch. A renewable lease is bounded by the launch itself.

### Age out crash-left staging directories instead of purging them

Rejected. Staging exists only while the lock is held, so a staging directory seen at
acquisition is already known to be abandoned; an age heuristic would let orphaned
bodies count toward the quota and evade expiry for as long as the grace lasted.

### Expose bounded CLI text for failed stdin deliveries

Rejected. Exact-string redaction of the payload cannot remove a partial echo of it,
so any textual stdout/stderr in a stdin failure risks leaking a fragment of a
sender-authored body. The evidence is reduced to non-textual status, size, and
truncation, and the text is used only in-process to classify a rejected `--stdin`.

### Use `pi.exec` and accept argv delivery

Rejected because it caps a message at the operating system argument limit, publishes
bodies to local process listings, and cannot use the `--stdin` transport the owner
approved. The narrow stdin executor is the smaller compromise, and it preserves every
other execution guarantee.

## Consequences

- `herdr_communicate` and `herdr_launch` gain one explicit delivery field each, and
  their results gain delivery and attachment evidence. No existing field changes
  meaning.
- The v1 envelope gains a mandatory `delivery` line and, on the attachment route,
  extension-generated reference headers. Envelope tests and any external reader that
  asserts an exact header list must be updated.
- The extension takes on local storage responsibility: owner-only permissions, atomic
  publish, expiry, quota, and the guarantee that no body reaches a log, result,
  notification, or rendered row.
- One process-execution path is no longer `pi.exec`. The security boundary now reads
  "explicit executable and argv arrays, no shell" rather than "always `pi.exec`", and
  the exception is scoped to `herdr agent prompt --stdin`. That executor owns its own
  termination behaviour: `SIGTERM` on timeout or abort, escalating to `SIGKILL` after
  a bounded grace so an unresponsive child cannot hang a tool call.
- Failure evidence gains a delivery shape. The route is established before any
  precondition and one body-free wrapper adds it to every failure, so self-target,
  busy-target, raw-kind, incapable-profile, and store failures all name the requested
  route and phase; once published, they also carry `attachmentRetained` plus body-free
  attachment metadata, so an operator can find or clean up a retained attachment after a
  failed send.
- Integration separates a gating recipient-readback acceptance test — which requires a
  confirmed delivery plus evidence only the recipient could produce, and reports itself
  blocked and skipped otherwise — from a non-gating transport smoke that records
  unconfirmed deliveries. Host-side reads of a published attachment are transport
  evidence and never a readback claim.
- Any test or harness that drives the extension must inject a session-bound stdin
  executor alongside `pi.exec`. Injecting only `pi.exec` silently sends real prompts
  to the default Herdr session.
- Recipient scoping is an access-narrowing contract, not an operating system
  boundary: all store files belong to the same local user, and the unguessable
  recipient key plus per-recipient Claude grant is what prevents cross-recipient
  enumeration and pane-ID reuse inheritance.
- Attachment delivery is deliberately impossible after a Pi session boundary, because
  capability records are runtime-scoped. Operators recover by sending inline or
  relaunching the recipient from a profile.
- Profile argv construction moves after the recipient key is minted, so the launch
  ordering test changes even though the launch contract does not.
- A pre-placement attachment for a newly-created launch cannot truthfully record a
  pane ID that Herdr has not assigned yet. Its immutable metadata omits that field;
  the successful post-state and runtime-only recipient record complete the binding.
