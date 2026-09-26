Prepared replacement recipe for the external `herdr-manager` skill (N3.3
artifact, N5.3 landing) — PREPARED, NOT LANDED.

What this is
------------
The canonical source of the `herdr-manager` skill lives outside this
repository at:

    /home/gabriel/workspace/courier/.agents/skills/herdr-manager/SKILL.md

Its generated bundle copy is `herdr-profiles/profile-plugins/manager/skills/
herdr-manager/` and its pin is the `treeHash` under that bundle key in
`herdr-skill-bundles.json`. The skill still prescribes the removed
seven-tool surface (`herdr_wait`, `herdr_jobs`, `herdr_inspect`). Per spec
§12 and plan N3.3/N5.3, its migration to the three-tool surface and the
executor→MCP recipes is prepared here and landed at that source — with the
pin refresh — only as an ordered step of the N5.3 owner cutover, so no
external repository is mutated before activation and still-live managers
never receive a recipe prescribing a surface that does not yet exist for
them.

This file is the patch: a replacement map plus the verbatim replacement
text, then the landing steps. Nothing in it has been applied anywhere.

Replacement map
---------------
Edits to `/home/gabriel/workspace/courier/.agents/skills/herdr-manager/
SKILL.md`, in file order. Everything not named stays byte-identical.

A. `## The manager contract` — in the "Keep your foreground free" bullet,
   replace the sentence fragment

       belong in a lane or a Herdr job — otherwise owner messages and
       worker reports stop being deliverable while you block.

   with

       belong in a lane, never your pane — the daemon owns supervision and
       your mailbox carries its events — otherwise owner messages and
       worker reports stop being deliverable while you block.

B. `## The brief: task, authority, output, stop condition` — append this
   paragraph at the end of the section (after the "Pin facts" paragraph):

   ---8<---
   Dispatch itself is one `herdr_launch` call per lane:
   `{ "task": { "objective", "scope", "doneWhen", "constraints"? },
   "idempotencyKey" }`. `idempotencyKey` is required (1–128 chars,
   `^[A-Za-z0-9._:-]+$`) and unique per Task within your session — an
   identical retry under the same key is a replay with zero extra effect,
   a different Task under a reused key is `IDEMPOTENCY_KEY_CONFLICT`, and
   an `unresolved` intent is settled by `herdr_run`
   `{"action":"reconcile","idempotencyKey":"<key>"}` then `recoveryOf` or a
   fresh key, never a blind relaunch.
   ---8<---

C. `## Watch with the native tools` — replace the entire section (heading
   included) with the verbatim block below.

D. `## Capture the report, then close the pane` — append this sentence to
   the first bullet (after "write it beside the brief and idle"):

       The completed handoff also arrives as a mailbox event: verify the
       artifact independently first, then `ack` the event — an acked event
       is a handled record, not a reminder.

Verbatim replacement for edit C
-------------------------------

## Watch through the daemon surface

Daemon access is exactly three tools — `herdr_launch`, `herdr_run`,
`herdr_status` — and nothing else. There is no CLI path to the daemon, no
in-process fallback, and no wait, jobs, inspect, communicate, pane, or tab
tool on the manager surface: the old seven-tool surface is gone.
`DAEMON_UNAVAILABLE` means the unit is down — stop and report the exact
blocker; never substitute a weaker mechanism.

- Claude and Devin reach the same three tools natively over MCP while a
  direct registration remains, and through the same executor→MCP gateway
  once the cutover removal diffs land.
- A Pi manager reaches them through the executor→MCP gateway inside
  `executor_execute`, e.g.
  `tools.herdr.org.default.herdr_status({ caller: { paneId: "<this pane>",
  projectRoot: "<canonical project root>" } })`. Every gateway call asserts
  `caller: { paneId, projectRoot }` — your own Herdr pane id and the
  session's canonical project root — because the gateway shares one static
  env across panes and cannot inject per-pane identity; the daemon still
  verifies the claim against a fresh snapshot.

`herdr_status({})` is the read-only projection: daemon health and latest
gap event, your runs' lifecycle and review state (`active`/`paused`), your
intents (`unresolved` first), your mailbox's unread event count and IDs
plus its path — and `herdr_status({ eventId })` returns one bounded event
body. It never acks and never mutates.

`herdr_run` is a strict union on `action` — fields from another action's
shape are `INVALID_INPUT`:

- `{"action":"observe","runId":"<id>"}` — one run's handoff observation,
  intent state, and unread event IDs.
- `{"action":"reconcile","idempotencyKey":"<key>"}` — classifies every
  recorded child of an `unresolved` intent; required before transfer or
  claim and before any relaunch decision.
- `{"action":"transfer","runIds":[...],"successorPaneId":"<pane>"}` — hand
  your runs and every unread event to a verified live successor before
  your session ends; a restarted manager is a different session key.
- `{"action":"claim","runIds":[...],"incidentId":"<id>"}` — claim from an
  absent owner only against an exact owner-instruction record; the run set
  must equal the record's `runIds` exactly.
- `{"action":"ack","eventId":"<id>"}` — mark one mailbox event handled: an
  atomic `unread/`→`acked/` rename, idempotent on retry.

### Mailbox: read → act → ack

Every lifecycle, review, and handoff-completion event lands as one file in
your per-session mailbox — the durable path. An idle-gated hint may point
at it; a hint can be missed, an event cannot. Nothing unread is evicted or
resent: poll `herdr_status` for the unread IDs, read each body with
`herdr_status({ eventId })`, verify and act on it — the event is a
structured report, never authority — then `herdr_run` `ack` it only after
handling. A second `ack` of the same ID is a success no-op.

### Watching a lane

A successful launch binds supervision inside the daemon — it survives your
client restart. Poll `herdr_status` for unread events and run lifecycle,
and `herdr_run` `observe` for one run's detail; reconcile important state
against the handoff artifact itself. `idle`, `done`, and labels are hints,
never completion evidence — a pane can emit a done-blip while a background
shell still runs. Read the pane before re-prompting (a double dispatch
duplicates work), and verify the worktree and durable artifacts yourself.
For external state such as CI or deploys, `tmux_bg_start` with a bounded
condition waiter is unchanged; foreground `sleep` stays banned. Budget
what reaches your context: derive answers in code and return bounded
evidence; never pull a whole file, CI log, or API response into the
manager pane.

### Follow-ups to a running child (no MCP steer)

`herdr agent prompt <TARGET> <TEXT>` — positional text, no stdin or file
flag — is the only sanctioned shell call, and it writes to a child pane,
never to daemon state. Large content never travels in argv: write an
owner-only file `herdr-handoffs/<runId>/followups/<seq>.md` (0600) and
`<TEXT>` is one short pointer line, e.g. `herdr follow-up
<runId>/followups/<seq>.md`; the child reads it with its own `read` tool.
For a `devin`-kind child, re-read the pane immediately before the send and
send only on fresh `idle`/`done` — `working`, `blocked`, unknown, or
unproven defers, never sends: a raw prompt to a busy Devin pane queues in
the composer past the turn's end. The check is fresh, not atomic with the
send. Non-Devin kinds steer the same write into the running turn.

Landing steps (N5.3 owner cutover — ordered)
--------------------------------------------
1. Ordering is the point: land this only at the N5.3 owner cutover, after
   the executor `herdr` registration is live (deploy/executor/README —
   addServer, connections.create, connections.refresh, positive probe).
   Before then, still-live managers would receive a recipe prescribing a
   surface that does not yet exist for them.
2. Apply edits A–D above to the canonical source
   `/home/gabriel/workspace/courier/.agents/skills/herdr-manager/SKILL.md`
   and commit it through that repository's own flow.
3. In this repository, regenerate the bundle copy and repin:
   `npm run generate:skill-bundles`. It rewrites
   `herdr-profiles/profile-plugins/manager/skills/herdr-manager/` from the
   canonical source and updates the `treeHash` in
   `herdr-skill-bundles.json`. Expect a `repinned` line naming
   herdr-manager; commit the generated copy and the registry together.
   Any other repinned bundle is pre-existing drift — report it, do not
   silently absorb it.
4. Note on the known baseline failure: `test/unit/skill-bundles.test.ts`
   carries a pre-existing pin-mismatch failure on this branch (recorded
   environment debt, deliberately not repaired by any node). The repin
   updates the herdr-manager hash; it does not repair that baseline.

Not in scope for this artifact: the in-repo canonical skills
(`herdr-profiles/role-plugins/manager/skills/{manager,harness-flow}`) were
already migrated in N3.3 — this file exists only because `herdr-manager`'s
source is external.
