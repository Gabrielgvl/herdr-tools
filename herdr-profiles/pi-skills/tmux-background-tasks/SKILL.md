---
name: tmux-background-tasks
description: Run and manage long-lived shell commands outside Pi with tmux. Use for builds, tests, servers, watchers, deploys, or local processes that must continue while Pi works or survive Pi reloads and crashes.
compatibility: Requires bash and tmux 3.2 or newer.
---

# Tmux Background Tasks

Use tmux rather than background-process extensions, `command &`, or `nohup`. Tmux owns the process lifecycle, so tasks survive Pi session replacement, reload, and crashes.

Helper:

```bash
TMUX_BG="$HOME/.pi/agent/skills/tmux-background-tasks/scripts/tmux-bg"
```

## Choose foreground or background

Keep short commands in the normal foreground `bash` tool. Use this skill only when the command is expected to take long enough that Pi should continue other work, must survive Pi, or needs later output inspection.

Do not background a fixed `sleep`. To wait for a real condition, run a command that exits when the condition is satisfied.

## Start

Pass the shell command as one quoted argument:

```bash
"$TMUX_BG" start build "$PWD" 'npm test'
```

Save the printed task ID. Use a descriptive name. The helper adds a unique suffix, so repeated names and concurrent starts do not collide.

Commands run through tmux's configured shell. Shell operators, pipelines, environment expansion, and redirection work inside the quoted command. Do not put secrets directly in the command because the command is visible in process and tmux metadata.

Only Pi-origin starts use the notification wrapper. The wrapper invokes tmux's effective default shell with the original command, requested cwd, inherited environment, and pane stdin/stdout/stderr. It preserves the submitted command in running `status` and `list` output. Signals are forwarded to the direct command-shell child only; independently grouped or daemonized descendants are outside the guarantee. Because Bash exposes signal-derived waits as 128 plus the signal number, intentional exits 129 through 192 can be classified as signals; statuses 193 through 255 remain numeric failures.

When `start` runs from Pi's shell tool, the task is bound to that origin Pi session. Completion is delivered there automatically through a private per-session outbox; no command, cwd, or output is copied into the notification. Outside Pi, or without `PI_SESSION_ID`, the helper keeps its legacy behavior and does not create notification records.

For a server or watcher, run the foreground form of the program. Do not add `&`, `nohup`, or another daemonization layer.

## Inspect

```bash
"$TMUX_BG" list
"$TMUX_BG" status TASK_ID
"$TMUX_BG" output TASK_ID
"$TMUX_BG" output TASK_ID 500
```

`status` reports `running` or `done` with the exact exit code. `output` returns only the requested tail and accepts 1 through 10000 lines. Tmux keeps at most 5000 history lines for each task.

Check status at natural work boundaries. Do not busy-poll while useful work remains. If completion is the only remaining blocker, use a bounded local poll that exits on `status=done`; do not use a fixed sleep as the result.

## Stop and clean

```bash
"$TMUX_BG" kill TASK_ID
"$TMUX_BG" clean
```

`kill` only accepts IDs created by this helper. Before the wrapper's parent pre-writer commitment, killing a task suppresses completion. After commitment, kill is deferred until the uncancelled writer finishes, even if the atomic rename has not happened yet. `clean` removes completed managed sessions and leaves running tasks, unrelated tmux sessions, and outbox records untouched.

Completed panes remain available until cleaned. Running tasks survive Pi exit. A machine reboot or tmux server shutdown ends them. A command that daemonizes its own descendants may escape tmux cleanup, so do not daemonize inside a managed task.

## Pi session binding

- `PI_SESSION_ID` selects the origin inbox; `/reload` and resume of the same session recover unacknowledged completions.
- `/new` and `/fork` use different Pi session IDs and intentionally do not inherit the origin task's notifications.
- Ephemeral Pi sessions still receive live origin-bound notifications, but their event records are marked non-persisted because `PI_SESSION_FILE` is absent.
- Delivery remains origin-session-bound and retryable at-least-once intent with same-runtime duplicate suppression. It is not exactly-once, and there is no bounded-time or concurrent-same-session guarantee.
- `/reload` and resume recover unacknowledged records. `/new` and `/fork` use different Pi session IDs and do not inherit them.
- The output reference points to retained tmux history. After `clean`, that output reference expires.

Rollback must leave the hidden completion action compatible: notification-enabled tasks already started must still be able to write their completion records, while new tasks may fall back to legacy behavior when notification support is removed.

## Failure handling

- Missing tmux, an empty command, or a missing working directory fails before launch.
- A malformed or unknown task ID fails without touching any tmux session.
- If setup fails after session creation, the partial session is removed.
- If a task exits quickly, `remain-on-exit` preserves its output and exit code.
- If `list` runs with no tmux server or no managed tasks, it returns no tasks successfully.
