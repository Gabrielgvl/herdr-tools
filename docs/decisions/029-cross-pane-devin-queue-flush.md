# ADR-029: Cross-pane Devin composer queue flush

## Status

Accepted. Scope approved by the owner at the plan's safety gate (N0, resolved
to option C): implement the bounded observed-composer contract in this
package, with the durable conditional-drain primitive tracked upstream
against Herdr's Devin integration — not the Devin binary. Extends the Enter
exception ADR-027 recorded for own-pane wakes; ADR-024's exception wording
and `docs/specs/auto-child-supervision.md` §12 carry cross-references, not
rewrites.

## Context

ADR-027 gave the MCP host's own-pane Devin wake a bounded composer flush —
wait out the busy turn, prove the rendered composer still holds queued input
above an all-placeholder input line under the acknowledged identity, then
send one Enter — and scoped it as the single narrow exception to
ADR-013/024's "no path sends Enter" rule, justified in part by the target
being the server's own pane.

A `herdr_communicate` steer to a busy Devin pane hits the identical wall: the
write is acknowledged and lands in the composer's queued input, but that
queue does not drain when the turn ends, so the envelope sits unseen until a
human happens to press Enter. The acknowledged send already happened — Herdr
accepted the bytes — so completing it writes nothing new and is not a retry.
Two deployment facts force the machinery to change shape rather than move
verbatim: any supported host runtime (Pi extension or MCP stdio server, in
any checkout) can target the same Devin pane, so one process's promise tail
cannot serialize every proof and key; and communicate must remain
acknowledgement-based and non-blocking (ADR-024), so the flush runs as a
bounded background attempt that never reaches back into the tool result.

## Decision

The exception is extended, narrowly, to cross-pane `herdr_communicate`
prompt/steer deliveries on `devin` targets, and the flush machinery is
factored into one coordinator per host shared by the wake pipeline and
communicate — `src/messages/devin-queue-flush.ts` owning the ANSI composer
parser and the bounded/coalesced cycles, `src/pane-write-lock.ts` owning the
cross-process lock and spent-frame fence.

- **Eligibility is unchanged in kind and tightened in evidence.** A flush is
  scheduled only after a validated `agent_prompted` acknowledgement, only
  when `agentKind === "devin"` and the *last verified pre-send state* was
  `working` or `blocked` — never a post-send observation. Normal `prompt`
  still refuses `working`/`blocked` at every fresh check, so steer is the
  only reachable busy route today; the eligibility check runs for both text
  operations so a future gate change cannot silently bypass it.
- **One bounded background attempt, never a deferred retry.** `schedule()` is
  fire-and-forget immediately after the ack validates, before optional
  post-observation can fail; communicate returns on its existing
  acknowledgement timeline and a flush outcome never converts an acknowledged
  delivery into a failed one. Each cycle keeps ADR-027's bounds — `agent
  wait` for `idle`/`done` at 110s strictly inside a 120s cycle budget that
  starts when the cycle starts, at most two Enters, the second earned only by
  an observed interior change — with no rescheduling on timeout, failure,
  draft, or repaint lag. A later independently acknowledged busy send
  schedules a fresh bounded cycle; per pane there is one active cycle and at
  most one pending cycle, which bursts coalesce into.
- **Cross-process exclusion around the short section only.** Cooperating
  processes serialize on a native `flock` holder — the holder primitive
  extracted from `launch-freeze.ts` — whose key hashes the canonicalized
  `HERDR_SOCKET_PATH` endpoint plus pane ID under an owner-only runtime
  directory, with hashed filenames so no message body or session value
  appears on disk. Acquisition is bounded (5s) and the lock is held only
  across the proof/key section, never across the turn wait; the lock inode is
  never unlinked or recreated while held, and untrusted ownership,
  permissions, or symlinks fail closed. Every participating Devin text write
  — the wake self-prompt, communicate's final verify+write, and launch's
  initial prompt — passes through the same write section, so a
  bracketed-paste submission cannot interleave between a flush's composer
  proof and its key. Launch's participation buys ordering only: no flush
  eligibility, and its readiness/semantic-confirmation contracts are
  unchanged.
- **A spent-frame fence suppresses duplicate keys across processes.** Beside
  each lock, a bounded file records sha256 digests of spent composer frames
  bound to the full prompt-target identity — never pane text — written under
  the lock *before* dispatch, so a crashed or uncertain send cannot invite a
  retry of that frame in this or any other host. A later holder refuses an
  identical frame even with a zero press count. Only a fresh, identity-bound,
  positively parsed non-queued composer rearms the fence — never elapsed
  time, a new ack, a parse failure, or a missing record — and a malformed,
  untrusted, or unwritable fence fails closed to no key.
- **The per-key proof order is fixed.** Under the held lease: candidate ANSI
  read proving queue evidence inside the composer box above an
  all-placeholder input; fresh `agent get`/`pane get` join proving the exact
  acknowledged occupant (missing fresh identity never borrows fields from the
  ack); fresh `idle`/`done` state; a non-queued candidate rearms the fence
  and stops; an interior identical to the frame this cycle just pressed is
  repaint lag; a final ANSI read must equal the candidate; spent-fence check;
  lock-holder liveness check; record the frame spent; `send-keys enter`. Any
  missing, truncated, or unparseable evidence stops the cycle, and a draft —
  styled or unstyled, wrapped or not — in the input area refuses the key.
- **Lifecycle is explicit.** `begin()` arms a session and aborts whatever an
  earlier session left pending; `shutdown()` aborts cycles before prompt
  transports close, and no new operation is dispatched after abort.
  Already-dispatched PTY bytes cannot be recalled, and no stronger
  cancellation is claimed.

## Limits — recorded, not hedged

- **External producers are out of coverage.** Raw `herdr agent prompt`,
  `pane send-text`, or `pane run` invoked by watcher scripts or operators
  bypass this package entirely: they never take the lock, so nothing here
  serializes their writes against a flush and nothing here flushes their
  queued sends. The durable fix — a conditional queue-drain or
  input-generation primitive at the component that owns composer submission —
  is tracked upstream against Herdr's Devin integration.
- **The write-lock decision uses the earlier verified kind.** The section is
  taken on the identity proven before the write boundary
  (`communicate.ts:252`, `launch.ts:1931`), so in a narrow occupant-swap
  corner — the kind changing between that verification and the write — a
  Devin-bound write can proceed unlocked, degrading to pre-feature behavior.
  Locking unconditionally was rejected to keep non-Devin sends independent of
  namespace resolvability.
- **The proof is a rendered frame, not composer state.** A draft landing
  between the final ANSI proof and the dispatched key is a residual
  read-to-key TOCTOU the socket API cannot close; the lock serializes
  participating processes only — never humans, never raw CLI clients. This is
  the approved best-effort contract, not an atomic draft-safety guarantee.
- **The fence is duplicate-key suppression, not a durable queue.** Repeated
  real queues can render identical placeholder-only interiors; with no
  drained frame observed since, those must be conservatively refused even
  though the queue is real. The ceiling is deliberate and `ponytail:`-marked
  in code rather than hidden by wider parsing heuristics.
- **No consumption claim.** A flush completes an acknowledged send; it is not
  exactly-once delivery, not proof the agent consumed the envelope, and not
  automatic recovery. A turn that outlives the bound leaves the envelope
  queued: wakes are recovered by `herdr_jobs` polling; a missed communicate
  flush is recovered by inspecting the recipient's visible queue and
  re-sending under human control — never a blind Enter, never an automatic
  resend.
- **Scope stays Devin-only.** Pi recipients steer the same write into the
  running turn and need no flush; Claude self-wakes remain Channels-only and
  Claude cross-pane communicate delivery is unchanged; `agy`/`unknown`
  remain fail-closed.

## Consequences

- A busy cross-pane steer to a Devin pane now drains without a manual Enter,
  matching what own-pane wakes already did; the acknowledgement contract is
  untouched — success still means accepted dispatch, never consumption.
- ADR-027's safety argument changes shape: "the target is the server's own
  pane" is no longer what makes the key defensible. The cross-pane guarantee
  rests on the shared lock, the exact-occupant join, the double ANSI proof,
  and the spent-frame fence — each fail-closed — inside the owner-approved
  best-effort boundary above.
- ADR-004's no-interrupt rule, ADR-013/015/016's single-submit rules, and
  ADR-024's non-blocking acknowledgement contract are preserved; the only new
  authority is that same bounded Enter applied to cross-pane Devin targets.
