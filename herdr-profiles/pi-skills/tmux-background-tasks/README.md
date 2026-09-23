# tmux-background-tasks — systemd + files backend

Status: **Reviewed and qualified.** The skill is globally available to Pi
after rollout; `PI_BG_BACKEND=systemd` remains an explicit per-invocation
opt-in and legacy tmux remains the default. Ported from the isolated pilot at
`/home/gabriel/workspace/pi-bg-files-pilot-20260922`, where the manager
independently verified the live backend suite, 16 notifier tests and seven
native Pi integration checks. The canonical live suite
(`tests/test-systemd-bg.sh`) and the legacy suite (`tests/test-tmux-bg.sh`)
were re-run here on systemd 255.4 and pass, apart from the legacy suite's
independently reproduced intermittent `exit=unknown` failure noted below.
Executor transport, other harnesses and global launchers remain unqualified.

## What this is

An opt-in alternative backend for the `tmux-bg` helper in which **systemd owns
process lifecycle** and **files retain results and output**. The backend is a
single Python-stdlib executable (`scripts/systemd-bg`). Bash runs command
payloads and the existing `tmux-bg __prepare`/`__publish` notification path,
reusing the unchanged secure outbox. There is no tmux involvement in this backend at all:
no pane, no terminal attachment, no foreground waiter, no environment relay
through a tmux server.

- `systemd-run --user` launches each job directly from the CLI caller, so the
  workload inherits the **current caller's exported environment** (forwarded by
  NAME via `--setenv=NAME`; values never enter argv or logs) and working
  directory. Shell-relative names and systemd lifecycle names (`EXIT_CODE`,
  `EXIT_STATUS`, `SERVICE_RESULT`, `MAINPID`, `INVOCATION_ID`, monitor,
  watchdog, notify, journal, and `LISTEN_*` socket-activation variables) are never forwarded, so an
  inherited copy cannot shadow the finalizer's authoritative metadata.
- Unit shape: `Type=exec`, `ExitType=cgroup`, `KillMode=control-group`,
  `TimeoutStopSec=5s` + `SendSIGKILL=yes` (bounded stop grace), `StandardInput=null`
  (noninteractive), `--collect`, no `Restart`.
- A job stays `active` while **any workload descendant** (double-forked,
  `setsid`) remains in the cgroup. `ExecStopPost` is the trusted finalizer: it
  records `EXIT_CODE`/`EXIT_STATUS`/`SERVICE_RESULT` into a private receipt and
  then publishes the unchanged strict-v1 completion event through `tmux-bg
  __publish` to the **origin session's** outbox for a clean exit 0 with
  `SERVICE_RESULT=success` (`succeeded`), for any classifiable nonzero exit
  (`failed`, `exitCode=N`), and for any classifiable signal death (`failed`,
  `signal=NAME`). Exit 0 paired with a non-success service result (e.g.
  `timeout`), an unclassifiable result, an unbound session, or an explicit
  cancellation is retained in the receipt but not published. Publication is pinned to
  the outbox chain identity captured at launch (kept in the unit environment
  and job metadata, which must agree), so replacing the inbox mid-run fails
  closed — same guarantee as the legacy in-memory capture.

## Opt-in

```sh
PI_BG_BACKEND=systemd tmux-bg start NAME CWD COMMAND
PI_BG_BACKEND=systemd tmux-bg {list|status|output|kill|clean}
```

The variable must be set on **every** backend invocation. Unset or empty keeps
the default legacy tmux behavior; any other nonempty value fails explicitly. `PI_BG_BACKEND=systemd` with an unreachable user manager is a hard
failure — there is no tmux fallback.

Requires: systemd >= 255 (qualified on 255.4), reachable user manager
(`systemctl --user`), python3. `XDG_RUNTIME_DIR` defaults to `/run/user/$UID`.

## Semantics and limits

- `start` prints a stable `pi-bg-*` id only after `systemd-run` acknowledges
  the launch. Failed/uncertain starts retain the job directory and report the
  exact id; the state stays `launching`.
- `status` reads retained files plus live unit state: `running` (workload
  descendants may still be alive after main exit), `finalizing` (receipt
  written, unit still executing `ExecStopPost` — the receipt never claims the
  unit is already inactive), `done exit=N service=R [cancelled=1]`,
  `failed-start`, `unknown`. A retained result with unverifiable native state
  includes `native=unknown`; it does not establish that the unit is inactive.
- Main exit, service outcome, and cancellation intent are distinct fields in
  `result.json` and are never merged. A cancelled TERM-ignoring descendant can
  legitimately produce `exit=0 service=timeout`, which is never published as
  success.
- `kill` writes a `cancel` intent marker only after an acknowledged launch and
  loaded unit are verified, then requests `systemctl stop` and reports `killed`
  only after termination is confirmed. It never treats not-found, unreadable
  state, a failed `stop`, or a failed `list-jobs` as proof; cancel of an
  unacknowledged (`launching`) start is reported **unconfirmed**, as is any
  unverifiable queue state. Unconfirmed stops remove their marker.
- Explicit cancellation **suppresses** the completion wake (documented
  behavior, same as legacy). `result.json` remains the durable record.
- `output` is a bounded tail of the job log (default 200 lines, max 10000
  lines / 4 MiB read window). The log file itself is **not** size-capped —
  this is a known limit of `StandardOutput=append:`.
- `clean` removes only exact owned job directories with a retained terminal
  receipt and a non-active unit; it refuses active/unknown jobs and never
  touches other units (`reset-failed` is scoped to the job's own unit).
- Job storage lives under `$PI_CODING_AGENT_DIR/tmux-bg/jobs/<id>` with
  component-wise no-follow validation (dirs mode 700, files 600, atomic
  tmp+rename writes, descriptor-relative reads). Results/logs survive caller
  exit and unit GC; they are removed only by `clean`.
- No restart/replay after caller exit or reboot; no scheduler, retries,
  event bus, registry, or watcher was added.
- `/bg` command and the footer widget only display tmux jobs; file-backed
  backend jobs are not shown there (documented limitation).

## Rollback

Stop using the opt-in. `PI_BG_BACKEND=systemd tmux-bg clean` removes retained
job directories after jobs terminate; `systemctl --user stop pi-bg-<id>`
handles any still-running unit. The legacy helper path is unchanged except
for internal `__prepare`/`__publish` verbs and the explicit dispatch.

## Checks

`tests/test-systemd-bg.sh` — bounded live checks: main0/exit7 with surviving
detached descendants (exit 7 publishes exactly one strict-v1 `failed` event
with `exitCode:7`; exit 0 + `timeout` publishes nothing),
TERM-ignoring cancellation with unaffected sibling,
successive-caller env/cwd, retained status/output after unit GC, invalid
ids/paths/symlinks, a literal `PI_SESSION_ID=-` rejected before any job,
outbox, or unit effect, mocked `EXIT_CODE=killed`/`dumped` finalizers
publishing `failed` with a signal and null exit code, mocked stop/list-jobs
failure (never prints `killed`),
uncertain-start cancel unconfirmed, exact clean. Requires a reachable user
manager (`XDG_RUNTIME_DIR`); without one the live sections fail their
prerequisite check.

## Remaining gaps (honest)

- Log file growth is unbounded; only reads are bounded.
- An `EXIT_CODE` outside `exited`/`killed`/`dumped`, or a signal death whose
  `EXIT_STATUS` cannot be classified, retains raw values in the receipt but
  does not publish a completion event (the strict-v1 schema cannot express it).
- A cancel marker landing between the workload's final descendant exit and
  the finalizer's marker check can suppress a completion that raced the
  cancel; the receipt stays truthful.
- Native SDK/notifier integration passed in the pilot with deterministic
  local responses, no inference and no tmux. This does not test actual
  interactive UI commands, reboot recovery, Executor transport or other
  harnesses.
- The default legacy tmux suite has an independently reproduced intermittent
  `exit=unknown` failure. It was not fixed or concealed by this backend.

Manager evidence: `docs/research/evidence/systemd-files/` in
`/home/gabriel/workspace/herdr-tools-executor-discovery-20260922T143203Z`.
