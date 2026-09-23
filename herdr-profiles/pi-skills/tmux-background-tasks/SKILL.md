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

Every start uses a small wrapper that invokes tmux's effective default shell with the original command, requested cwd, inherited environment, and pane stdin/stdout/stderr. It preserves the submitted command and exact exit status in `status` and `list` output. Signals are forwarded to the direct command-shell child only; independently grouped or daemonized descendants are outside the guarantee. Because Bash exposes signal-derived waits as 128 plus the signal number, intentional exits 129 through 192 can be classified as signals; statuses 193 through 255 remain numeric failures.

Use the registered `tmux_bg_start` tool from Pi. It supplies Pi's actual session ID, starts this helper, and refreshes the session footer. Session-bound completion is delivered to that origin session through a private per-session outbox; no command, cwd, or output is copied into the notification. Calling this script directly without `PI_SESSION_ID` uses the same tmux wrapper and retained status but does not create notification records.

For a server or watcher, run the foreground form of the program. Do not add `&`, `nohup`, or another daemonization layer.

## Wait for external state

Never occupy an agent turn with Bash `sleep` or an inline polling loop. Start one bounded waiter with `tmux_bg_start`, then continue useful work or yield. The footer shows up to three waits owned by the current Pi session.

Wait4X is pinned at v3.7.1. If `$HOME/.local/bin/wait4x` is missing, stop and install that exact version. Do not silently use `@latest` or fall back to foreground polling.

```bash
mkdir -p "$HOME/.local/bin"
GOBIN="$HOME/.local/bin" go install wait4x.dev/v3/cmd/wait4x@v3.7.1
```

Pass each recipe as the `command` argument to `tmux_bg_start`. Replace uppercase placeholders with explicit identifiers. Identifiers are safe in the command, but credentials are not. Use inherited authentication instead of putting tokens in the command.

### Arbitrary command predicate

Wait4X retries until the command returns zero. Keep quiet mode and a nonzero timeout. Wrap compound shell predicates in `bash -c` because Wait4X's command parser accepts simple commands only.

```bash
"$HOME/.local/bin/wait4x" exec -q -i 10s -t 30m "bash -c 'COMMAND_THAT_RETURNS_ZERO_WHEN_READY'"
```

### GitHub PR checks

This first waits for at least one check to attach, then uses GitHub's native watcher. A changed head, closed PR, failed check, or cancelled check makes the task fail.

```bash
REPO=OWNER/REPO PR=123 EXPECTED_HEAD=FULL_SHA; export REPO PR EXPECTED_HEAD
"$HOME/.local/bin/wait4x" exec -q -i 10s -t 30m "bash -c '
  [ \"\$(gh pr view \"\$PR\" --repo \"\$REPO\" --json headRefOid --jq .headRefOid)\" != \"\$EXPECTED_HEAD\" ] ||
  [ \"\$(gh pr view \"\$PR\" --repo \"\$REPO\" --json state --jq .state)\" != OPEN ] ||
  [ \"\$(gh pr checks \"\$PR\" --repo \"\$REPO\" --json name --jq length)\" -gt 0 ]
'" &&
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$EXPECTED_HEAD" ] &&
[ "$(gh pr view "$PR" --repo "$REPO" --json state --jq .state)" = OPEN ] &&
gh pr checks "$PR" --repo "$REPO" --watch --fail-fast &&
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$EXPECTED_HEAD" ] &&
[ "$(gh pr view "$PR" --repo "$REPO" --json state --jq .state)" = OPEN ]
```

### GitHub workflow run

The predicate exits when the run is terminal or the optional PR head guard changes. The final reads decide success. Without a head guard, remove the head comparison and its `||` from the predicate, plus the final PR-head test.

```bash
REPO=OWNER/REPO RUN_ID=123 PR=456 EXPECTED_HEAD=FULL_SHA; export REPO RUN_ID PR EXPECTED_HEAD
"$HOME/.local/bin/wait4x" exec -q -i 15s -t 2h "bash -c '
  [ \"\$(gh pr view \"\$PR\" --repo \"\$REPO\" --json headRefOid --jq .headRefOid)\" != \"\$EXPECTED_HEAD\" ] ||
  [ \"\$(gh run view \"\$RUN_ID\" --repo \"\$REPO\" --json status --jq .status)\" = completed ]
'" &&
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$EXPECTED_HEAD" ] &&
[ "$(gh run view "$RUN_ID" --repo "$REPO" --json status --jq .status)" = completed ] &&
[ "$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq .conclusion)" = success ]
```

### GitHub review decision change

Compare the complete JSON object so empty and nonempty decisions remain distinct without special null handling.

```bash
REPO=OWNER/REPO PR=123; export REPO PR
BASELINE=$(gh pr view "$PR" --repo "$REPO" --json reviewDecision) || exit 1
export BASELINE
"$HOME/.local/bin/wait4x" exec -q -i 15s -t 2h "bash -c '
  current=\$(gh pr view \"\$PR\" --repo \"\$REPO\" --json reviewDecision) || exit 1
  [ \"\$current\" != \"\$BASELINE\" ]
'"
```

### HTTP, file, and process

```bash
# HTTP 200
"$HOME/.local/bin/wait4x" http -q -i 5s -t 20m --expect-status-code 200 https://example.test/health

# File appears
TARGET=/absolute/path; export TARGET
"$HOME/.local/bin/wait4x" exec -q -i 2s -t 30m 'test -e "$TARGET"'

# Existing Linux process exits
timeout 30m tail --pid=12345 -f /dev/null
```

### AWS

Prefer a service's native waiter and always pass an explicit region. Bound the whole command because AWS waiter defaults differ. Use Wait4X `exec` with the same timeout pattern when the AWS CLI has no native waiter.

```bash
timeout 45m aws cloudformation wait stack-update-complete --region us-east-1 --stack-name STACK
```

After notification, inspect bounded output with `tmux-bg output TASK_ID 200`, then query the provider again before merge, deploy, or any other mutation. Completion is a wake-up, not proof that the state is still valid.

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
