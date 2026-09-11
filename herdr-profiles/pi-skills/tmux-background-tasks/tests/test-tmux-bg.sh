#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BG="$ROOT/scripts/tmux-bg"
SOCKET="pi-tmux-bg-test-$$"
TMP="$(mktemp -d /tmp/tmux-bg-test.XXXXXX)"
export PI_TMUX_SOCKET="$SOCKET"

cleanup() {
  tmux -L "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "expected [$1] to contain [$2]"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "expected [$1] not to contain [$2]"; }
assert_fails() {
  local rc output
  set +e
  output="$("$@" 2>&1)"
  rc=$?
  set -e
  (( rc != 0 )) || fail "expected failure: $*; output: $output"
}
wait_done() {
  local id="$1" result i
  for ((i=0; i<200; i+=1)); do
    result="$($BG status "$id" 2>&1)" || true
    [[ "$result" == *"status=done"* && "$result" != *"exit=unknown"* ]] && { printf '%s\n' "$result"; return; }
    sleep 0.01
  done
  fail "task did not finish: $id (last=$result)"
}
wait_event() {
  local path="$1" i
  for ((i=0; i<300; i+=1)); do
    [[ -f "$path" ]] && return
    sleep 0.01
  done
  fail "event was not written: $path"
}
wait_done_socket() {
  local socket="$1" agent="$2" id="$3" result i
  for ((i=0; i<300; i+=1)); do
    result="$(PI_TMUX_SOCKET="$socket" PI_CODING_AGENT_DIR="$agent" "$BG" status "$id" 2>&1)" || true
    [[ "$result" == *"status=done"* && "$result" != *"exit=unknown"* ]] && { printf '%s\n' "$result"; return; }
    sleep 0.01
  done
  fail "isolated task did not finish: $id (last=$result)"
}
assert_no_event() {
  local path="$1" i
  for ((i=0; i<100; i+=1)); do
    [[ ! -e "$path" ]] || fail "unexpected event: $path"
    sleep 0.01
  done
}
assert_private_chain() {
  local agent="$1" session="$2" path mode
  for path in "$agent" "$agent/tmux-bg" "$agent/tmux-bg/outbox" "$agent/tmux-bg/outbox/$session"; do
    [[ -d "$path" && ! -L "$path" ]] || fail "outbox entry is not a real directory: $path"
    mode="$(stat -c '%a' "$path")"
    (( (8#$mode & 18) == 0 )) || fail "outbox entry is writable by group/other: $path ($mode)"
  done
  [[ "$(stat -c '%a' "$agent/tmux-bg/outbox/$session")" == 700 ]] || fail "session inbox is not mode 700"
}

command -v tmux >/dev/null || fail "tmux is required for tests"
chmod +x "$BG"
bash -n "$BG"

# Empty state succeeds even when no tmux server exists.
[[ -z "$($BG list)" ]] || fail "fresh task list was not empty"

# Validate the public trust boundaries before touching tmux.
assert_fails /usr/bin/env TMUX_BIN=/no/such/tmux "$BG" list
assert_fails "$BG" start "" "$TMP" "printf x"
assert_fails "$BG" start "!!!" "$TMP" "printf x"
assert_fails "$BG" start test "$TMP/missing" "printf x"
assert_fails "$BG" start test "$TMP" "   "
assert_fails "$BG" status ../foreign
assert_fails "$BG" output ../foreign
assert_fails "$BG" output pi-bg-invalid 0
assert_fails "$BG" output pi-bg-invalid abc
assert_fails "$BG" output pi-bg-invalid 10001
assert_fails "$BG" kill ../foreign

# Fast legacy success remains inspectable with output and the exact exit code.
id="$($BG start "Quick Success" "$TMP" "printf 'hello world\\n'")"
assert_contains "$id" "pi-bg-quick-success-"
assert_contains "$(wait_done "$id")" "exit=0"
assert_contains "$($BG output "$id")" "hello world"

notify_agent_dir="$TMP/pi-agent"
notify_session_file="$TMP/session.jsonl"
assert_event() {
  local event_path="$1" expected_task="$2" expected_session="$3" expected_outcome="$4" expected_exit="$5" expected_persisted="${6:-true}"
  node - "$event_path" "$expected_task" "$expected_session" "$expected_outcome" "$expected_exit" "$expected_persisted" <<'NODE'
const fs = require("node:fs");
const [path, expectedTask, expectedSession, expectedOutcome, expectedExit, expectedPersisted] = process.argv.slice(2);
const raw = fs.readFileSync(path, "utf8");
if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("event exceeds 8 KiB");
const event = JSON.parse(raw);
const keys = Object.keys(event).sort();
const expectedKeys = ["completedAtEpochSec", "eventId", "exitCode", "outcome", "outputRef", "piSessionId", "schemaVersion", "sessionPersisted", "signal", "taskId"].sort();
if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) throw new Error(`unexpected keys: ${keys}`);
if (event.schemaVersion !== 1 || event.eventId !== `tmux-bg:${expectedTask}` || event.piSessionId !== expectedSession || event.sessionPersisted !== (expectedPersisted === "true") || event.taskId !== expectedTask || event.outcome !== expectedOutcome || typeof event.completedAtEpochSec !== "number") throw new Error(`wrong event metadata: ${raw}`);
if (event.exitCode !== Number(expectedExit) || event.signal !== null) throw new Error(`wrong exit result: ${raw}`);
if (JSON.stringify(event.outputRef) !== JSON.stringify({ kind: "tmux-bg", taskId: expectedTask })) throw new Error(`wrong output reference: ${raw}`);
if (/secret-output|SECRET_VALUE|command|cwd|environment|session\.jsonl/.test(raw)) throw new Error(`event leaked private data: ${raw}`);
NODE
  [[ "$(stat -c '%a' "$event_path")" == 600 ]] || fail "event is not mode 600: $event_path"
}
assert_signal_event() {
  local event_path="$1" expected_task="$2" expected_session="$3" expected_signal="$4"
  node - "$event_path" "$expected_task" "$expected_session" "$expected_signal" <<'NODE'
const fs = require("node:fs");
const [path, expectedTask, expectedSession, expectedSignal] = process.argv.slice(2);
const event = JSON.parse(fs.readFileSync(path, "utf8"));
if (event.schemaVersion !== 1 || event.eventId !== `tmux-bg:${expectedTask}` || event.piSessionId !== expectedSession || event.sessionPersisted !== true || event.taskId !== expectedTask || event.outcome !== "failed" || event.exitCode !== null || event.signal !== expectedSignal) throw new Error(`wrong signal result: ${JSON.stringify(event)}`);
if (JSON.stringify(event.outputRef) !== JSON.stringify({ kind: "tmux-bg", taskId: expectedTask })) throw new Error("wrong output reference");
NODE
}

# Exit 0, exit 7, exact numeric range, and the inherited private environment.
notify_task0="$(PI_CODING_AGENT_DIR="$notify_agent_dir" PI_SESSION_ID=notify-session-0 PI_SESSION_FILE="$notify_session_file" SECRET_VALUE=not-for-event "$BG" start notify-zero "$TMP" "printf 'secret-output\\nSECRET_VALUE\\n'; test \"\$SECRET_VALUE\" = not-for-event; exit 0")"
assert_contains "$(wait_done "$notify_task0")" "exit=0"
notify_event0="$notify_agent_dir/tmux-bg/outbox/notify-session-0/$notify_task0.json"
wait_event "$notify_event0"
assert_event "$notify_event0" "$notify_task0" notify-session-0 succeeded 0
assert_private_chain "$notify_agent_dir" notify-session-0
for code in 7 128 193 255; do
  session="notify-session-$code"
  task="$(PI_CODING_AGENT_DIR="$notify_agent_dir" PI_SESSION_ID="$session" PI_SESSION_FILE="$notify_session_file" "$BG" start "notify-$code" "$TMP" "exit $code")"
  assert_contains "$(wait_done "$task")" "exit=$code"
  event="$notify_agent_dir/tmux-bg/outbox/$session/$task.json"
  wait_event "$event"
  assert_event "$event" "$task" "$session" failed "$code"
done

# A direct child signal becomes one signal event and a signal-derived retained status.
notify_signal="$(PI_CODING_AGENT_DIR="$notify_agent_dir" PI_SESSION_ID=notify-session-signal PI_SESSION_FILE="$notify_session_file" "$BG" start notify-signal "$TMP" 'kill -TERM $$')"
notify_signal_event="$notify_agent_dir/tmux-bg/outbox/notify-session-signal/$notify_signal.json"
wait_event "$notify_signal_event"
assert_signal_event "$notify_signal_event" "$notify_signal" notify-session-signal TERM
assert_contains "$(wait_done "$notify_signal")" "exit=143"

# Inferred fatal signals must agree across the event and retained status/list output.
for signal_case in KILL SEGV; do
  signal_number=9; expected_exit=137
  [[ "$signal_case" == SEGV ]] && signal_number=11 && expected_exit=139
  signal_session="notify-session-${signal_case,,}"
  signal_task="$(PI_CODING_AGENT_DIR="$notify_agent_dir" PI_SESSION_ID="$signal_session" PI_SESSION_FILE="$notify_session_file" "$BG" start "notify-$signal_case" "$TMP" "kill -$signal_case \$\$")"
  signal_event="$notify_agent_dir/tmux-bg/outbox/$signal_session/$signal_task.json"
  wait_event "$signal_event"
  assert_signal_event "$signal_event" "$signal_task" "$signal_session" "$signal_case"
  assert_contains "$(wait_done "$signal_task")" "exit=$expected_exit"
  assert_contains "$($BG list)" "id=$signal_task status=done exit=$expected_exit"
done

# The wrapper reports the original command exactly while running, including shell syntax.
special_command="sleep 2; printf '%s\\n' 'a|b \"quote\" \$() operators | backslash \\\\'; sleep 2"
special_task="$(PI_CODING_AGENT_DIR="$notify_agent_dir" PI_SESSION_ID=notify-session-special "$BG" start special "$TMP" "$special_command")"
special_status="$($BG status "$special_task")"
[[ "${special_status##*command=}" == "$special_command" ]] || fail "status did not preserve the original command: $special_status"
list_status="$($BG list)"
assert_contains "$list_status" "command=$special_command"
tmux -L "$SOCKET" show-options -p -v -t "$special_task" @pi_bg_wrapper | grep -qx 1 || fail "wrapper marker missing"
tmux -L "$SOCKET" show-options -v -t "$special_task" @pi_bg_pi_session_id | grep -qx notify-session-special || fail "origin session marker missing"
assert_not_contains "$(tmux -L "$SOCKET" show-options -v -t "$special_task" @pi_bg_pi_session_id)" "$special_command"
assert_contains "$($BG kill "$special_task")" "killed $special_task"
assert_fails "$BG" status "$special_task"

# Pane stdin stays attached to the direct command shell.
stdin_agent="$TMP/stdin-agent"
stdin_task="$(PI_CODING_AGENT_DIR="$stdin_agent" PI_SESSION_ID=notify-session-stdin "$BG" start stdin "$TMP" "printf 'READY\\n'; IFS= read -r line; printf 'got=%s\\n' \"\$line\"")"
for i in $(seq 1 100); do
  [[ "$($BG output "$stdin_task")" == *READY* ]] && break
  sleep .01
done
tmux -L "$SOCKET" send-keys -l -t "$stdin_task" -- 'line from stdin'; tmux -L "$SOCKET" send-keys -t "$stdin_task" Enter
assert_contains "$(wait_done "$stdin_task")" "exit=0"
assert_contains "$($BG output "$stdin_task")" "got=line from stdin"
wait_event "$stdin_agent/tmux-bg/outbox/notify-session-stdin/$stdin_task.json"

# Kill before the child completes suppresses the writer; completion-before-kill wins.
running_agent="$TMP/running-agent"
running_task="$(PI_CODING_AGENT_DIR="$running_agent" PI_SESSION_ID=notify-session-running "$BG" start running "$TMP" "printf READY; sleep 30")"
for i in $(seq 1 100); do [[ "$($BG output "$running_task")" == *READY* ]] && break; sleep .01; done
assert_contains "$($BG status "$running_task")" "status=running"
assert_contains "$($BG kill "$running_task")" "killed $running_task"
assert_no_event "$running_agent/tmux-bg/outbox/notify-session-running/$running_task.json"
completed_task="$(PI_CODING_AGENT_DIR="$notify_agent_dir" PI_SESSION_ID=notify-session-complete "$BG" start complete "$TMP" ':')"
completed_event="$notify_agent_dir/tmux-bg/outbox/notify-session-complete/$completed_task.json"
wait_event "$completed_event"
assert_contains "$($BG kill "$completed_task")" "killed $completed_task"
[[ -f "$completed_event" ]] || fail "kill removed a completed event"

# Event-write failure preserves the child's status and retained output.
write_fail_agent="$TMP/write-failure-agent"
write_fail_task="$(PI_CODING_AGENT_DIR="$write_fail_agent" PI_SESSION_ID=notify-session-write-failure PI_SESSION_FILE="$notify_session_file" "$BG" start write-failure "$TMP" "printf retained-output; sleep 0.2; chmod 500 $(printf '%q' "$write_fail_agent/tmux-bg/outbox/notify-session-write-failure"); exit 7")"
assert_contains "$(wait_done "$write_fail_task")" "exit=7"
assert_contains "$($BG output "$write_fail_task")" retained-output
assert_no_event "$write_fail_agent/tmux-bg/outbox/notify-session-write-failure/$write_fail_task.json"
chmod 700 "$write_fail_agent/tmux-bg/outbox/notify-session-write-failure"

# Every pre-rename publication failure removes its descriptor-relative temporary.
publication_fail_agent="$TMP/publication-failure-agent"; publication_fail_session=notify-session-publication-failure
mkdir -p "$publication_fail_agent/tmux-bg/outbox/$publication_fail_session"
chmod 700 "$publication_fail_agent" "$publication_fail_agent/tmux-bg" "$publication_fail_agent/tmux-bg/outbox" "$publication_fail_agent/tmux-bg/outbox/$publication_fail_session"
for fail_stage in write fsync readback seam rename; do
  fail_task="pi-bg-publication-$fail_stage-1-1-1"
  assert_fails /usr/bin/env PI_CODING_AGENT_DIR="$publication_fail_agent" PI_TMUX_BG_TEST_FAIL_STAGE="$fail_stage" "$BG" __complete "$fail_task" "$publication_fail_session" 0 7 ""
  [[ -z "$(find "$publication_fail_agent/tmux-bg/outbox/$publication_fail_session" -type f -name '.*.tmp' -print)" ]] || fail "temporary leaked at $fail_stage"
done
publication_ok_task=pi-bg-publication-success-1-1-1
/usr/bin/env PI_CODING_AGENT_DIR="$publication_fail_agent" "$BG" __complete "$publication_ok_task" "$publication_fail_session" 0 0 ""
wait_event "$publication_fail_agent/tmux-bg/outbox/$publication_fail_session/$publication_ok_task.json"

# Helper and cwd paths containing spaces remain data.
spaced_helper_dir="$TMP/helper path"; mkdir -p "$spaced_helper_dir"; cp --preserve=mode "$BG" "$spaced_helper_dir/tmux-bg"
spaced_agent_dir="$TMP/pi agent"
spaced_task="$(PI_CODING_AGENT_DIR="$spaced_agent_dir" PI_SESSION_ID=notify-session-spaces PI_SESSION_FILE="$notify_session_file" "$spaced_helper_dir/tmux-bg" start spaced "$TMP" ':')"
spaced_event="$spaced_agent_dir/tmux-bg/outbox/notify-session-spaces/$spaced_task.json"; wait_event "$spaced_event"; assert_event "$spaced_event" "$spaced_task" notify-session-spaces succeeded 0
mkdir -p "$TMP/dir with spaces"; cwd_task="$($BG start cwd "$TMP/dir with spaces" pwd)"; wait_done "$cwd_task" >/dev/null; assert_contains "$($BG output "$cwd_task")" "$TMP/dir with spaces"

# Legacy starts have no outbox or wrapper marker and retain the pane command fallback.
legacy_agent="$TMP/legacy-agent"
legacy_task="$(/usr/bin/env -u PI_SESSION_ID -u PI_SESSION_FILE PI_CODING_AGENT_DIR="$legacy_agent" "$BG" start legacy "$TMP" "printf legacy\\n")"
assert_contains "$(wait_done "$legacy_task")" "exit=0"
assert_contains "$($BG output "$legacy_task")" legacy
[[ ! -e "$legacy_agent/tmux-bg/outbox" ]] || fail "legacy start created an outbox"

# Setup validation rejects symlinked and group/world-writable chain entries before new-session.
symlink_agent="$TMP/symlink-agent"; symlink_target="$TMP/symlink-target"; mkdir -p "$symlink_target"; ln -s "$symlink_target" "$symlink_agent"
assert_fails /usr/bin/env PI_CODING_AGENT_DIR="$symlink_agent" PI_SESSION_ID=bad-symlink "$BG" start bad "$TMP" ':'
writable_agent="$TMP/writable-agent"; mkdir -p "$writable_agent"; chmod 770 "$writable_agent"
assert_fails /usr/bin/env PI_CODING_AGENT_DIR="$writable_agent" PI_SESSION_ID=bad-writable "$BG" start bad "$TMP" ':'
chain_agent="$TMP/chain-agent"; mkdir -p "$chain_agent/tmux-bg"; ln -s "$TMP/decoy" "$chain_agent/tmux-bg/outbox"
assert_fails /usr/bin/env PI_CODING_AGENT_DIR="$chain_agent" PI_SESSION_ID=bad-chain "$BG" start bad "$TMP" ':'

# Publication-time replacement fails closed and never writes into a decoy directory.
race_agent="$TMP/race-agent"; race_session=notify-session-race; mkdir -p "$race_agent/tmux-bg/outbox/$race_session"
chmod 700 "$race_agent" "$race_agent/tmux-bg" "$race_agent/tmux-bg/outbox" "$race_agent/tmux-bg/outbox/$race_session"
race_original="$race_agent/original-inbox"; race_decoy="$TMP/race-decoy"; mkdir -p "$race_decoy"; chmod 700 "$race_decoy"
race_command="mv $(printf '%q' "$race_agent/tmux-bg/outbox/$race_session") $(printf '%q' "$race_original"); mv $(printf '%q' "$race_decoy") $(printf '%q' "$race_agent/tmux-bg/outbox/$race_session"); exit 0"
race_task="$(PI_CODING_AGENT_DIR="$race_agent" PI_SESSION_ID="$race_session" "$BG" start race "$TMP" "$race_command")"
assert_contains "$(wait_done "$race_task")" "exit=0"
assert_no_event "$race_decoy/$race_task.json"
assert_no_event "$race_agent/tmux-bg/outbox/$race_session/$race_task.json"
[[ -z "$(find "$race_agent" -type f -name '.*.tmp' -print)" ]] || fail "temporary publication file leaked"

# Direct wrapper validation starts no child and leaves no event.
validation_marker="$TMP/direct-child-marker"
assert_fails "$BG" __run pi-bg-direct-1-2-3 direct 0 "$TMP/missing-agent" /bin/bash "touch $(printf '%q' "$validation_marker")"
[[ ! -e "$validation_marker" ]] || fail "direct wrapper validation started a child"

# Partial-session setup failure is cleaned up, and kill/clean never delete inbox records.
setup_fake="$TMP/setup-fake-tmux"; setup_log="$TMP/setup-fake.log"
cat >"$setup_fake" <<'EOF'
#!/usr/bin/env bash
if [[ " $* " == *" respawn-pane "* ]]; then : >"$SETUP_FAILURE_LOG"; exit 9; fi
exec /usr/bin/tmux "$@"
EOF
chmod +x "$setup_fake"
before="$(tmux -L "$SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep '^pi-bg-' || true)"
assert_fails /usr/bin/env TMUX_BIN="$setup_fake" SETUP_FAILURE_LOG="$setup_log" PI_CODING_AGENT_DIR="$TMP/setup-agent" PI_SESSION_ID=notify-session-setup "$BG" start setup "$TMP" 'sleep 30'
[[ -f "$setup_log" ]] || fail "setup failure injector was not reached"
after="$(tmux -L "$SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep '^pi-bg-' || true)"
[[ "$before" == "$after" ]] || fail "partial session leaked"
$BG clean >/dev/null
[[ -f "$completed_event" ]] || fail "clean removed an outbox record"

printf 'PASS: tmux-bg lifecycle, wrapper, metadata, stdin, and outbox security\n'

if [[ "${TMUX_BG_STRESS:-0}" == 1 ]]; then
  stress_trace_root="${TMUX_BG_STRESS_TRACE_DIR:-$TMP/stress-evidence}"
  mkdir -p "$stress_trace_root"
  stress_summary="$stress_trace_root/summary-${TMUX_BG_STRESS_RUN:-one}.txt"
  : >"$stress_summary"

  stress_row() {
    local label="$1" count="$2" command="$3" session="$4"
    local socket="tmux-bg-stress-${TMUX_BG_STRESS_RUN:-one}-${label}-$$-$RANDOM" row agent trace bash_env bootstrap id event status i complete_count rename_count file_count
    row="$stress_trace_root/$label"; rm -rf "$row"; mkdir -p "$row"
    agent="$row/agent"; trace="$row/trace"; bash_env="$row/bash-env"; : >"$trace"
    cat >"$bash_env" <<EOF
exec 9>>$(printf '%q' "$trace")
export BASH_XTRACEFD=9
export PS4='+\${BASHPID}:\${FUNCNAME[0]-}:\${task_id:-none}: '
set -x
EOF
    # Keep a bootstrap pane so the fresh server's default shell can be selected before product tasks.
    BASH_ENV="$bash_env" PI_TMUX_BG_TRACE="$trace" tmux -L "$socket" new-session -d -s bootstrap sleep 2147483647 \; set-option -g default-shell /bin/bash
    tmux -L "$socket" set-environment -g PI_TMUX_BG_TRACE "$trace"
    for ((i=1; i<=count; i+=1)); do
      id="$(PI_TMUX_SOCKET="$socket" BASH_ENV="$bash_env" PI_CODING_AGENT_DIR="$agent" PI_SESSION_ID="$session-$i" PI_SESSION_FILE="$row/session" PI_TMUX_BG_TRACE="$trace" "$BG" start "$label-$i" "$row" "$command")"
      event="$agent/tmux-bg/outbox/$session-$i/$id.json"
      wait_event "$event"
      status="$(wait_done_socket "$socket" "$agent" "$id")"
      case "$label" in
        success) [[ "$status" == *"exit=0"* ]] || fail "$label $i: $status" ;;
        exit7) [[ "$status" == *"exit=7"* ]] || fail "$label $i: $status" ;;
        signal) [[ "$status" == *"exit=143"* ]] || fail "$label $i: $status" ;;
      esac
    done
    complete_count="$(grep -c '^complete_task task_id=' "$trace" || true)"
    rename_count="$(grep -c '^rename task_id=' "$trace" || true)"
    file_count="$(find "$agent" -type f -name '*.json' | wc -l)"
    printf 'row=%s iterations=%s complete=%s rename=%s files=%s\n' "$label" "$count" "$complete_count" "$rename_count" "$file_count" | tee -a "$stress_summary"
    [[ "$complete_count" -eq "$count" && "$rename_count" -eq "$count" && "$file_count" -eq "$count" ]] || fail "stress counter miss in $label"
    python3 - "$agent" "$count" "$label" <<'PY'
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
expected = int(sys.argv[2])
label = sys.argv[3]
files = list(root.glob("tmux-bg/outbox/*/*.json"))
if len(files) != expected:
    raise SystemExit(f"expected {expected} event files, got {len(files)}")
for path in files:
    event = json.loads(path.read_text())
    if event["schemaVersion"] != 1 or event["taskId"] not in path.name:
        raise SystemExit(f"malformed result: {path}")
    if label == "signal":
        if event["exitCode"] is not None or event["signal"] not in ("TERM", "SIGTERM"):
            raise SystemExit(f"malformed signal result: {path}")
    elif event["signal"] is not None:
        raise SystemExit(f"unexpected signal result: {path}")
    if path.stat().st_mode & 0o777 != 0o600:
        raise SystemExit(f"wrong event mode: {path}")
PY
    tmux -L "$socket" kill-server 2>/dev/null || true
  }

  stress_stdin() {
    local socket="tmux-bg-stdin-${TMUX_BG_STRESS_RUN:-one}-$$-$RANDOM" row="$stress_trace_root/stdin" agent trace bash_env id event i status value
    row="$stress_trace_root/stdin"; rm -rf "$row"; mkdir -p "$row"; agent="$row/agent"; trace="$row/trace"; bash_env="$row/bash-env"; : >"$trace"
    cat >"$bash_env" <<EOF
exec 9>>$(printf '%q' "$trace")
export BASH_XTRACEFD=9
export PS4='+\${BASHPID}:\${FUNCNAME[0]-}:\${task_id:-none}: '
set -x
EOF
    BASH_ENV="$bash_env" PI_TMUX_BG_TRACE="$trace" tmux -L "$socket" new-session -d -s bootstrap sleep 2147483647 \; set-option -g default-shell /bin/bash
    tmux -L "$socket" set-environment -g PI_TMUX_BG_TRACE "$trace"
    for ((i=1; i<=50; i+=1)); do
      value="stdin-$i"
      id="$(PI_TMUX_SOCKET="$socket" PI_CODING_AGENT_DIR="$agent" PI_SESSION_ID="stdin-$i" PI_SESSION_FILE="$row/session" PI_TMUX_BG_TRACE="$trace" "$BG" start "stdin-$i" "$row" 'printf READY; IFS= read -r line; printf "got=%s\\n" "$line"')"
      for ((status=0; status<300; status+=1)); do [[ "$(PI_TMUX_SOCKET="$socket" "$BG" output "$id")" == *READY* ]] && break; sleep .01; done
      tmux -L "$socket" send-keys -l -t "$id" -- "$value"; tmux -L "$socket" send-keys -t "$id" Enter
      event="$agent/tmux-bg/outbox/stdin-$i/$id.json"; wait_event "$event"; wait_done_socket "$socket" "$agent" "$id" >/dev/null
      assert_contains "$(PI_TMUX_SOCKET="$socket" "$BG" output "$id")" "got=$value"
    done
    printf 'row=stdin iterations=50 complete=%s rename=%s files=%s\n' "$(grep -c '^complete_task task_id=' "$trace" || true)" "$(grep -c '^rename task_id=' "$trace" || true)" "$(find "$agent" -type f -name '*.json' | wc -l)" | tee -a "$stress_summary"
    [[ "$(grep -c '^complete_task task_id=' "$trace" || true)" -eq 50 && "$(grep -c '^rename task_id=' "$trace" || true)" -eq 50 ]] || fail "stdin stress counter miss"
    tmux -L "$socket" kill-server 2>/dev/null || true
  }

  stress_boundaries() {
    local socket="tmux-bg-boundary-${TMUX_BG_STRESS_RUN:-one}-$$-$RANDOM" row="$stress_trace_root/boundaries" agent trace gate release bash_env id event i status
    row="$stress_trace_root/boundaries"; rm -rf "$row"; mkdir -p "$row"; agent="$row/agent"; trace="$row/trace"; gate="$row/gate"; release="$row/release"; bash_env="$row/bash-env"
    : >"$trace"; mkfifo "$release"
    cat >"$bash_env" <<EOF
exec 9>>$(printf '%q' "$trace")
export BASH_XTRACEFD=9
export PS4='+\${BASHPID}:\${FUNCNAME[0]-}:\${task_id:-none}: '
set -x
EOF
    BASH_ENV="$bash_env" PI_TMUX_BG_TRACE="$trace" PI_TMUX_BG_TEST_SEAM=1 PI_TMUX_BG_RENAME_GATE="$gate" PI_TMUX_BG_RENAME_RELEASE="$release" tmux -L "$socket" new-session -d -s bootstrap sleep 2147483647 \; set-option -g default-shell /bin/bash
    tmux -L "$socket" set-environment -g PI_TMUX_BG_TRACE "$trace"
    tmux -L "$socket" set-environment -g PI_TMUX_BG_TEST_SEAM 1
    tmux -L "$socket" set-environment -g PI_TMUX_BG_RENAME_GATE "$gate"
    tmux -L "$socket" set-environment -g PI_TMUX_BG_RENAME_RELEASE "$release"
    for ((i=1; i<=20; i+=1)); do
      id="$(PI_TMUX_SOCKET="$socket" BASH_ENV="$bash_env" PI_CODING_AGENT_DIR="$agent" PI_SESSION_ID="commit-$i" PI_SESSION_FILE="$row/session" PI_TMUX_BG_TRACE="$trace" PI_TMUX_BG_TEST_SEAM=1 PI_TMUX_BG_RENAME_GATE="$gate" PI_TMUX_BG_RENAME_RELEASE="$release" "$BG" start "commit-$i" "$row" ':')"
      event="$agent/tmux-bg/outbox/commit-$i/$id.json"
      for ((status=0; status<300; status+=1)); do grep -q "completion_committed=1 task_id=$id" "$trace" && grep -q "rename-blocked $id" "$gate" 2>/dev/null && break; sleep .01; done
      grep -q "completion_committed=1 task_id=$id" "$trace" || fail "commit boundary not observed: $id"
      grep -q "rename-blocked $id" "$gate" || fail "rename block not observed: $id"
      PI_TMUX_SOCKET="$socket" "$BG" kill "$id" >/dev/null
      printf x >"$release"
      wait_event "$event"
      [[ "$(find "$agent/tmux-bg/outbox/commit-$i" -type f -name '*.json' | wc -l)" -eq 1 ]] || fail "committed kill did not publish exactly once"
    done
    printf 'row=pre-rename-committed-kill iterations=20 complete=%s rename=%s files=%s\n' "$(grep -c '^complete_task task_id=' "$trace" || true)" "$(grep -c '^rename task_id=' "$trace" || true)" "$(find "$agent" -type f -name '*.json' | wc -l)" | tee -a "$stress_summary"
    tmux -L "$socket" kill-server 2>/dev/null || true
    rm -f "$release"

    socket="tmux-bg-suppress-${TMUX_BG_STRESS_RUN:-one}-$$-$RANDOM"; row="$stress_trace_root/suppress"; rm -rf "$row"; mkdir -p "$row"; agent="$row/agent"; trace="$row/trace"; : >"$trace"
    BASH_ENV="$bash_env" PI_TMUX_BG_TRACE="$trace" tmux -L "$socket" new-session -d -s bootstrap sleep 2147483647 \; set-option -g default-shell /bin/bash
    tmux -L "$socket" set-environment -g PI_TMUX_BG_TRACE "$trace"
    for ((i=1; i<=50; i+=1)); do
      id="$(PI_TMUX_SOCKET="$socket" PI_CODING_AGENT_DIR="$agent" PI_SESSION_ID="suppress-$i" PI_SESSION_FILE="$row/session" PI_TMUX_BG_TRACE="$trace" "$BG" start "suppress-$i" "$row" 'printf READY; sleep 30')"
      for ((status=0; status<200; status+=1)); do [[ "$(PI_TMUX_SOCKET="$socket" "$BG" output "$id")" == *READY* ]] && break; sleep .01; done
      PI_TMUX_SOCKET="$socket" "$BG" kill "$id" >/dev/null
      assert_no_event "$agent/tmux-bg/outbox/suppress-$i/$id.json"
    done
    [[ "$(grep -c '^complete_task task_id=' "$trace" || true)" -eq 0 ]] || fail "suppressed kill wrote a completion"
    printf 'row=kill-suppression iterations=50 complete=0 rename=0 files=0\n' | tee -a "$stress_summary"
    tmux -L "$socket" kill-server 2>/dev/null || true

    socket="tmux-bg-completion-wins-${TMUX_BG_STRESS_RUN:-one}-$$-$RANDOM"; row="$stress_trace_root/completion-wins"; rm -rf "$row"; mkdir -p "$row"; agent="$row/agent"; trace="$row/trace"; : >"$trace"
    BASH_ENV="$bash_env" PI_TMUX_BG_TRACE="$trace" tmux -L "$socket" new-session -d -s bootstrap sleep 2147483647 \; set-option -g default-shell /bin/bash
    tmux -L "$socket" set-environment -g PI_TMUX_BG_TRACE "$trace"
    for ((i=1; i<=20; i+=1)); do
      id="$(PI_TMUX_SOCKET="$socket" PI_CODING_AGENT_DIR="$agent" PI_SESSION_ID="wins-$i" PI_SESSION_FILE="$row/session" PI_TMUX_BG_TRACE="$trace" "$BG" start "wins-$i" "$row" ':')"
      event="$agent/tmux-bg/outbox/wins-$i/$id.json"; wait_event "$event"; PI_TMUX_SOCKET="$socket" "$BG" kill "$id" >/dev/null; PI_TMUX_SOCKET="$socket" "$BG" clean >/dev/null; [[ -f "$event" ]] || fail "completion was lost after kill/clean"
    done
    printf 'row=completion-wins iterations=20 complete=%s rename=%s files=%s\n' "$(grep -c '^complete_task task_id=' "$trace" || true)" "$(grep -c '^rename task_id=' "$trace" || true)" "$(find "$agent" -type f -name '*.json' | wc -l)" | tee -a "$stress_summary"
    tmux -L "$socket" kill-server 2>/dev/null || true
  }

  stress_row success 500 ':' stress-success
  stress_row exit7 500 'exit 7' stress-exit7
  stress_row signal 500 'kill -TERM $$' stress-signal
  stress_row high-exit 100 'exit 255' stress-high-exit
  stress_stdin
  stress_boundaries
  printf 'PASS: complete zero-miss stress matrix %s\n' "${TMUX_BG_STRESS_RUN:-one}"
fi
