# Spec: Large agent communications

**Status:** superseded in part — the `attachment` delivery route and tools-owned
attachment store were superseded and removed 2026-09-27 in the herdr-governor rewrite
(Phase 0), along with recipient grants and the recipient-capability registry. The
historical ADR-008 (`docs/decisions/008-tools-owned-large-message-attachments.md`)
preserves the superseded design. Every wrapped delivery is now `inline` over
`--stdin`, bounded by `MESSAGE_INLINE_MAX_BYTES` (16 KiB); a larger payload fails
rather than being published. This spec retains the still-current sections: the inline
transport, the envelope contract, and the tool contracts.

## Objective

Let one Herdr agent send a text message to another exact Herdr agent without
changing Herdr core, without truncating the payload, and without ever handing a
recipient a reference it cannot read.

Before this change, `herdr_communicate` (`prompt`/`steer`) and the `herdr_launch`
assignment embedded the whole v1 envelope in a single `herdr agent prompt` argv argument. That argument
is bounded by the operating system (Linux caps one argument at 128 KiB) and is visible
to any local process listing.

This slice delivers every wrapped text over the existing Herdr CLI through one
explicit route:

- `inline` — the complete v1 envelope is written to `herdr agent prompt --stdin`.

A payload larger than the inline bound fails with `PAYLOAD_TOO_LARGE_FOR_INLINE`
and sends nothing.

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
  every wrapped text delivery.
- There is no silent fallback to any other route: an oversized `inline` request
  fails and sends nothing.
- Both entry points are covered: `herdr_communicate` (`prompt` and `steer`) and
  `herdr_launch.assignment`. Named-key delivery is control input, is never
  wrapped, and gains nothing here.
- Mandatory v1 provenance is preserved. The envelope gains additive fields; the
  sentinel, version, `from`, `kind`, and `authority` lines keep their meaning and
  order. Callers still cannot suppress or forge provenance.
- No auto-acknowledgement. The extension sends exactly one message, never waits for
  completion, and the envelope explicitly tells the recipient not to acknowledge
  unless the sender's own text asks for it.
- Text-only, and a message body never enters a log, result, or diagnostic.

## Delivery

### Inline route

The existing v1 envelope, plus the `delivery: inline` header line, is written to
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
preflight with short polling before dispatch. Every sample
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
transaction drains provisional events before publishing exact coverage. Pane and
terminal continuity is not cryptographic attribution during
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

## Envelope contract

`delivery` is a mandatory v1 header line for every wrapped delivery and is always
`inline`. The sentinel stays `[HERDR AGENT MESSAGE v1]`.

```text
[HERDR AGENT MESSAGE v1]
from: coordinator (w1:p1)
kind: prompt
authority: agent; not user/owner
delivery: inline
payload: all text after this blank line is sender-authored

<caller-supplied payload>
```

Rules:

- Every header value is extension-generated from authoritative data. No caller
  text reaches a header line, so the existing single-line normalization guarantee
  against field injection is preserved.
- `kind` keeps its current meaning: `assignment` for `herdr_launch.assignment`,
  `prompt` or `steer` for `herdr_communicate`, plus `result` when a
  `herdr_communicate` caller explicitly sets `kind: "result"` on a `prompt` or
  `steer` text send (ADR-030 worker-reply contract).
- Callers cannot set, suppress, or reorder any header line.

## Tool contracts

### `herdr_communicate`

```text
{ target: TargetRef, operation: "prompt", text: string, kind?: "result" }
{ target: TargetRef, operation: "steer",  text: string, kind?: "result" }
{ target: TargetRef, operation: "keys",   keys: NamedKey[] }
```

- `keys` rejects `kind` as an unknown field.
- `kind` is optional on `prompt` and `steer` only; `"result"` is the sole accepted
  value (ADR-030). Omitting `kind` keeps the operation-derived `prompt`/`steer`
  envelope kind byte-identical; sending `kind: "result"` stamps that kind on the
  v1 envelope while the operation stays unchanged — a result sent over
  `steer` still reports `steer_direct`. The `cancel`/`interrupt` turn-control
  variants reject `kind` outright. These are schema rules, and the same checks
  are re-run inside `execute` for unvalidated callers: a stray `kind` on `keys`
  or a non-`"result"` value on a text send fails `INVALID_INPUT` before any
  preflight.
- `text` must be non-empty and NUL-free; a NUL is `INVALID_INPUT`. A `text`
  larger than the inline bound fails `PAYLOAD_TOO_LARGE_FOR_INLINE` and sends
  nothing.
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
- `details` carries `submission` and `observation`.
  It never contains the body, and no existing field is removed.
- One body-free wrapper adds the route to
  every failure. A failure keeps its typed code and gains `phase`
  (`validate`, `resolve_target`, `caller_policy`, `pre_state`, `send`, or
  `post_state`), plus `route` once the operation is known. `SELF_TARGET_REJECTED`,
  `TARGET_BUSY`, `KEY_REJECTED`, and oversize refusals therefore all name the
  route.

### `herdr_launch`

```text
{ ..., assignment: { objective: string, scope: string, verification: string } }
```

- `assignment` is mandatory and carries exactly `objective`, `scope`, and
  `verification`, each a non-empty string without NUL; a missing, empty, extra, or
  legacy `initialPrompt`/`initialPromptDelivery` field is `INVALID_INPUT`. The three
  fields render in that fixed order, and the rendered payload's UTF-8 size is the
  single authority checked against the inline bound; an oversized assignment fails
  rather than being sent.
- Ordering matches ADR-006: resolve profile →
  create a Pi or Claude prompt source → build argv → create pane/tab → start agent → run runtime-specific
  readiness → send exactly one identity-bound envelope over `--stdin` → validate the
  typed acknowledgement → confirm semantics. AGY creates no profile-body prompt source,
  requires the same typed `assignment`, publishes provisional supervision before submission, and
  strengthens to the official native session before launch reports success. The fresh joined
  identity is mandatory for Pi and Claude on every launch;
  `agent_id` is diagnostic only.
  Working-state detection is not delivery confirmation:
  `interactive_ready`, `revision`, `state_change_seq`, and
  `screen_detection_skipped` are retained as bounded evidence, and idle/done/blocked,
  stale, or unavailable observation never triggers Enter or a duplicate prompt.
  A replacement post-read is retained only as bounded mismatch evidence; it is never
  returned as `postState` or rendered as success-row state.
- A launch failure still performs no cleanup: created panes and tabs remain and are
  reported. After any possible AGY
  prompt effect, launch also retains provisional supervision and never retries, falls
  back, or releases its reservation.
- `details` gains `initialPromptSubmission` and `initialPromptObservation`.
- Failure details keep the existing partial-launch codes (`LAUNCH_FAILED`,
  `READY_TIMEOUT`, `POSTSTATE_UNAVAILABLE`, `ABORTED`) and `created`/`causeCode`
  evidence, and add `phase`. Pre-topology refusals keep their own typed codes because
  nothing was mutated.

### `herdr_inspect`

Unchanged in this slice.

## Error taxonomy additions

- `PAYLOAD_TOO_LARGE_FOR_INLINE`: the payload exceeds the inline bound. No
  bytes sent. Details carry exact byte counts and the bound.
- `CLI_INCOMPATIBLE` is reused when the installed CLI does not accept `--stdin`.

Existing codes keep their meaning. No code substitutes a guessed route, a
truncated payload, or a fabricated success.

The superseded `PAYLOAD_TOO_LARGE`, `ATTACHMENT_TARGET_UNVERIFIED`, `ATTACHMENT_STORE_FAILED`, and `ATTACHMENT_QUOTA_EXCEEDED` codes were removed with the store and appear only in historical records.

## Security and safety boundaries

- The stdin executor is the only process-execution path that is not `pi.exec`. It
  keeps the same explicit-executable, argv-array, no-shell contract and exists only
  because `pi.exec` cannot write standard input. It is used for nothing but
  `herdr agent prompt --stdin`.
- Moving payloads from argv to stdin removes message bodies from
  `/proc/<pid>/cmdline` and from any local process listing.
- Message bodies never appear in tool content, `details`, error details, progress
  updates, TUI rows, or job notifications.
- A failing CLI may echo part of a delivered body, so stdin-delivery failures expose
  no process text at all — only exit code, killed flag, per-stream presence, byte
  size, and truncation.

## Tech stack

- TypeScript 5.9, TypeBox, Pi extension APIs, Herdr CLI JSON contracts.
- `node:child_process` `spawn`, `node:crypto` `createHash`/`randomUUID`, and
  `node:fs/promises` for the stdin executor. No new dependency.
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
src/messages/limits.ts          inline bound and message-text validation
src/messages/failure.ts         body-free delivery failure evidence
src/provenance.ts               v1 envelope construction
src/schemas.ts                  herdr_communicate operation schemas
src/launch-schema.ts            assignment field
src/tools/communicate.ts        identity join, send, post-state
src/tools/launch.ts             identity-bound single submission
src/tui.ts                      call/result rows
index.ts                        wiring, session reset
test/unit/                      envelope, limits, tool tests
test/integration/               disposable-session inline delivery
```

## Code style

Strict data, fail closed, no silent route change:

```ts
function assertInlineSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MESSAGE_INLINE_MAX_BYTES) {
    throw Object.assign(new Error("Payload exceeds the inline message bound"), {
      code: "PAYLOAD_TOO_LARGE_FOR_INLINE",
      details: { bytes, limit: MESSAGE_INLINE_MAX_BYTES }
    });
  }
}
```

Reject unknown fields, NUL bytes, and oversized payloads. Never trim a payload or
echo a body.

## Testing strategy

Unit tests with injected IO and a fake executor:

- envelope: the `delivery: inline` line,
  header injection resistance, preserved sentinel and authority lines;
- stdin transport: argv array and `shell: false`, input written and stream closed,
  timeout and abort parity with `pi.exec`, `SIGTERM`-to-`SIGKILL` escalation for a
  child that ignores termination (mocked and real), timer/listener cleanup on every
  settle path, EPIPE and non-zero exit mapping, and no process text or payload
  fragment in stdin-delivery failure evidence, including partial echoes;
- `herdr_communicate`: the inline route, oversized inline rejection, `keys`
  rejecting extra fields, unchanged busy/steer/post-state behaviour;
- `herdr_launch`: identity-bound single submission, retained resources and bounded
  evidence on failure;
- failure evidence: typed code preserved with `route`, `phase`, and
  body-free metadata for send and post-read failures;
- rendering: success and error rows that never print a body.

Integration runs in a disposable named session where every extension call, including
stdin deliveries, is routed through that session: a session-bound stdin executor is
injected exactly like `pi.exec`, and stdin payloads are captured separately from argv.
The suite asserts inline delivery over `--stdin`, including a regression check that
no payload text reaches argv, and that a post-delivery failure still fails the run.
The run never mutates or closes the active user workspace.

## Boundaries

### Always

- Deliver over `agent prompt --stdin` exactly once per send.
- Keep bodies out of every log, result, and diagnostic.
- Preserve mandatory v1 provenance and the no-auto-ack contract.

### Ask first

- Raising the inline bound.
- Adding a second delivery route, non-text payloads, compression, or chunked
  multi-part messages.
- Any change that would require Herdr core work.

### Never

- Truncate a payload or send a reference a recipient cannot read.
- Put a message body in argv, an error detail, a notification, or a rendered row.
- Add a shell, a second executable, or a Herdr socket implementation.

## Slice success criteria

- [ ] A ≤ 16 KiB `prompt` or `steer` is delivered over `--stdin` with the
      `delivery: inline` envelope line and unchanged state semantics.
- [ ] A > 16 KiB `inline` request fails with `PAYLOAD_TOO_LARGE_FOR_INLINE` and
      sends nothing.
- [ ] No test, result, notification, or rendered row contains a message body.
- [ ] Unit, typecheck, lint, build, and integration gates are green.

## Assumptions and open questions

- The installed CLI's own maximum inline prompt size is unknown; the 16 KiB inline
  bound is chosen to stay well under any plausible Herdr-side cap and to keep large
  bodies out of recipient context by default.
- CLI `--stdin` support is detected by attempting the documented flag and mapping an
  argument-parse failure to `CLI_INCOMPATIBLE`, rather than by parsing the reported
  client version, because version strings are not a reliable capability contract.
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
