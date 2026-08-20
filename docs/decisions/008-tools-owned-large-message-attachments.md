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

`delivery` is an explicit caller field defaulting to `inline`, mirrored by
`initialPromptDelivery` on `herdr_launch`. The chosen route appears in the envelope,
the structured result, and the rendered row. There is no fallback in either
direction: an oversized inline request and an unverified attachment recipient both
fail with typed errors before any bytes are sent.

Attachment recipients are scoped and capability-gated. Each profile-backed launch
mints an unguessable recipient key, creates `<root>/<recipientKey>/`, and records the
recipient's pane ID, profile, agent identity, and derived capability in a
session-scoped in-memory registry that follows the existing ownership rules and is
never reconstructed. Claude profile launches receive an extension-owned
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
  the exception is scoped to `herdr agent prompt --stdin`.
- Recipient scoping is an access-narrowing contract, not an operating system
  boundary: all store files belong to the same local user, and the unguessable
  recipient key plus per-recipient Claude grant is what prevents cross-recipient
  enumeration and pane-ID reuse inheritance.
- Attachment delivery is deliberately impossible after a Pi session boundary, because
  capability records are runtime-scoped. Operators recover by sending inline or
  relaunching the recipient from a profile.
- Profile argv construction moves after the recipient key is minted, so the launch
  ordering test changes even though the launch contract does not.
