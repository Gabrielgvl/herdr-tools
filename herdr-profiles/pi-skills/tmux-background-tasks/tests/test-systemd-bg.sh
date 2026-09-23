#!/usr/bin/env bash
# Bounded live checks for the opt-in PI_BG_BACKEND=systemd job backend.
# Disposable units only; every owned resource is cleaned up at exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BG="$ROOT/scripts/tmux-bg"
SBG="$ROOT/scripts/systemd-bg"
TMP="$(mktemp -d /tmp/systemd-bg-test.XXXXXX)"
export PI_BG_BACKEND=systemd
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PI_CODING_AGENT_DIR="$TMP/agent"

UNITS=()
cleanup() {
  for unit in "${UNITS[@]:-}"; do
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "expected [$1] to contain [$2]"; }
assert_fails() {
  local rc output
  set +e; output="$("$@" 2>&1)"; rc=$?; set -e
  (( rc != 0 )) || fail "expected failure: $*; output: $output"
}
wait_status() {
  local id="$1" want="$2" result i
  for ((i=0; i<300; i+=1)); do
    result="$($BG status "$id" 2>&1)" || true
    [[ "$result" == *"$want"* ]] && { printf '%s\n' "$result"; return; }
    sleep 0.1
  done
  fail "task $id never reached [$want] (last=$result)"
}
wait_file() {
  local path="$1" i
  for ((i=0; i<300; i+=1)); do [[ -f "$path" ]] && return; sleep 0.1; done
  fail "file was not written: $path"
}

chmod +x "$BG" "$SBG"
bash -n "$BG"
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1], "rb").read(), sys.argv[1])' "$SBG" || fail "systemd-bg does not compile"

# Explicit failure, never a tmux fallback, when the user manager is unreachable.
assert_fails env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR=/nonexistent-dir "$BG" list
assert_fails env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR=/nonexistent-dir "$BG" start t "$TMP" ':'

# Trust boundaries are validated before any native call.
assert_fails "$BG" start "" "$TMP" 'printf x'
assert_fails "$BG" start test "$TMP/missing" 'printf x'
assert_fails "$BG" status ../foreign
assert_fails "$BG" status pi-bg-bad
assert_fails "$BG" output ../foreign
assert_fails "$BG" output pi-bg-invalid 10001
assert_fails "$BG" kill ../foreign
assert_fails "$BG" status pi-bg-nonexistent-1-2-3

command -v systemd-run >/dev/null || fail "systemd-run required"
systemctl --user show-environment >/dev/null 2>&1 || fail "user manager required"

# A literally supplied PI_SESSION_ID=- is an invalid session id, not the
# unbound sentinel: it must fail validation before any job dir, outbox, or
# unit exists. Unset/empty PI_SESSION_ID stays the documented unbound mode.
assert_fails env PI_SESSION_ID=- "$BG" start sentinel "$TMP" ':'
[[ -z "$(ls -A "$PI_CODING_AGENT_DIR/tmux-bg/jobs" 2>/dev/null)" ]] || fail "PI_SESSION_ID=- created a job directory"
[[ ! -e "$PI_CODING_AGENT_DIR/tmux-bg/outbox/-" ]] || fail "PI_SESSION_ID=- created an outbox"

# --- main0 + main7 with surviving detached descendants ----------------------
for code in 0 7; do
  id="$(PI_SESSION_ID="live-$code" "$BG" start "live$code" "$TMP" \
        "setsid bash -c 'echo \$\$ > $TMP/desc-$code.pid; sleep 30' </dev/null >/dev/null 2>&1 & echo ready-$code; exit $code")"
  UNITS+=("$id.service")
  assert_contains "$id" "pi-bg-live$code-"
  # Workload descendants keep the job active even though main already exited.
  assert_contains "$(wait_status "$id" status=running)" "status=running"
  wait_file "$TMP/desc-$code.pid"
  kill -TERM "$(cat "$TMP/desc-$code.pid")" 2>/dev/null || true
  assert_contains "$(wait_status "$id" status=done)" "exit=$code"
  assert_contains "$(wait_status "$id" service=)" "service="
  if (( code == 7 )); then
    # A classifiable nonzero exit publishes one strict-v1 failed event.
    ev="$PI_CODING_AGENT_DIR/tmux-bg/outbox/live-$code/$id.json"
    wait_file "$ev"
    assert_contains "$(<"$ev")" '"outcome":"failed","exitCode":7,"signal":null'
    (( $(ls "$PI_CODING_AGENT_DIR/tmux-bg/outbox/live-$code" | wc -l) == 1 )) || fail "exit 7 published more than one event"
  fi
done

# Receipt and strict v1 event both retained after unit GC.
list_out="$($BG list)"
id0="$(awk -F'[= ]' '/status=done/{print $2; exit}' <<<"$list_out")"
[[ -n "$id0" ]] || fail "no completed job in list"
wait_file "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$id0/result.json"
for i in $(seq 1 100); do
  [[ "$(systemctl --user show "$id0.service" -p LoadState --value 2>/dev/null)" == not-found ]] && break
  sleep 0.1
done
assert_contains "$($BG status "$id0")" "status=done"

# --- cancellation of a TERM-ignoring descendant; sibling unaffected ---------
victim="$(PI_SESSION_ID=cancel-victim "$BG" start victim "$TMP" \
          "bash -c 'trap \"\" TERM; echo \$\$ > $TMP/victim.pid; sleep 60' & sleep 60")"
sibling="$(PI_SESSION_ID=cancel-sib "$BG" start sib "$TMP" 'sleep 60')"
UNITS+=("$victim.service" "$sibling.service")
wait_status "$victim" status=running >/dev/null
wait_status "$sibling" status=running >/dev/null
assert_contains "$($BG kill "$victim")" "killed $victim"
wait_file "$TMP/victim.pid"
for i in $(seq 1 100); do kill -0 "$(cat "$TMP/victim.pid")" 2>/dev/null || break; sleep 0.1; done
kill -0 "$(cat "$TMP/victim.pid")" 2>/dev/null && fail "TERM-ignoring descendant survived cancel"
assert_contains "$(wait_status "$victim" status=done)" "cancelled=1"
assert_contains "$($BG status "$sibling")" "status=running"
[[ ! -e "$PI_CODING_AGENT_DIR/tmux-bg/outbox/cancel-victim/$victim.json" ]] || fail "cancel published a wake"
assert_contains "$($BG kill "$sibling")" "killed $sibling"

# --- outbox replacement between launch and finalize fails publication --------
race_session="race-origin"
race_decoy="$TMP/race-decoy"; mkdir -p "$race_decoy"; chmod 700 "$race_decoy"
race_inbox="$PI_CODING_AGENT_DIR/tmux-bg/outbox/$race_session"
race_task="$(PI_SESSION_ID="$race_session" "$BG" start race "$TMP" \
  "mv '$race_inbox' '$race_inbox.orig'; mv '$race_decoy' '$race_inbox'; exit 0")"
UNITS+=("$race_task.service")
assert_contains "$(wait_status "$race_task" status=done)" "exit=0"
wait_file "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$race_task/result.json"
[[ ! -e "$race_inbox/$race_task.json" ]] || fail "event published into a replaced inbox"
[[ ! -e "$race_inbox.orig/$race_task.json" ]] || fail "event landed in the displaced inbox"

# --- successive callers keep their own exported env + cwd --------------------
ida="$(PI_SENT_A=alpha "$BG" start enva "$TMP" 'printf "s=%s c=%s\n" "$PI_SENT_A" "$PWD"')"
idb="$(cd / && PI_SENT_B=beta "$BG" start envb / 'printf "s=%s c=%s\n" "$PI_SENT_B" "$PWD"')"
UNITS+=("$ida.service" "$idb.service")
wait_status "$ida" status=done >/dev/null; wait_status "$idb" status=done >/dev/null
assert_contains "$($BG output "$ida")" "s=alpha c=$TMP"
assert_contains "$($BG output "$idb")" "s=beta c=/"

# Transient path properties and ExecStopPost arguments remain literal.
percent_cwd="$TMP/cwd%literal"; mkdir "$percent_cwd"
percent_id="$($BG start percent "$percent_cwd" 'printf "cwd=%s\n" "$PWD"')"
UNITS+=("$percent_id.service")
wait_status "$percent_id" status=done >/dev/null
assert_contains "$($BG output "$percent_id")" "cwd=$percent_cwd"

# Exit 0 with a non-success service result is retained but never published.
timeout_session="timeout-origin"
timeout_identity="$($BG __prepare "$timeout_session")"
timeout_id=pi-bg-timeout-1-2-3
timeout_dir="$PI_CODING_AGENT_DIR/tmux-bg/jobs/$timeout_id"
mkdir -p "$timeout_dir"; chmod 700 "$timeout_dir"
printf '%s\n' "{\"schemaVersion\":1,\"taskId\":\"$timeout_id\",\"name\":\"timeout\",\"cwd\":\"$TMP\",\"command\":\":\",\"unit\":\"$timeout_id.service\",\"piSessionId\":\"$timeout_session\",\"sessionPersisted\":false,\"startedAtEpochSec\":1,\"outboxChainIdentity\":\"$timeout_identity\"}" >"$timeout_dir/meta.json"
chmod 600 "$timeout_dir/meta.json"
EXIT_CODE=exited EXIT_STATUS=0 SERVICE_RESULT=timeout PI_BG_OUTBOX_CHAIN="$timeout_identity" \
  "$SBG" __finalize "$timeout_id" "$timeout_session" 0
assert_contains "$(<"$timeout_dir/result.json")" '"serviceResult":"timeout"'
[[ ! -e "$PI_CODING_AGENT_DIR/tmux-bg/outbox/$timeout_session/$timeout_id.json" ]] || fail "timeout published a success wake"

# A non-cancelled classifiable signal death publishes one failed event with a null exitCode.
signal_session="signal-origin"
signal_identity="$($BG __prepare "$signal_session")"
signal_id=pi-bg-signal-1-2-3
signal_dir="$PI_CODING_AGENT_DIR/tmux-bg/jobs/$signal_id"
mkdir -p "$signal_dir"; chmod 700 "$signal_dir"
printf '%s\n' "{\"schemaVersion\":1,\"taskId\":\"$signal_id\",\"name\":\"signal\",\"cwd\":\"$TMP\",\"command\":\":\",\"unit\":\"$signal_id.service\",\"piSessionId\":\"$signal_session\",\"sessionPersisted\":false,\"startedAtEpochSec\":1,\"outboxChainIdentity\":\"$signal_identity\"}" >"$signal_dir/meta.json"
chmod 600 "$signal_dir/meta.json"
EXIT_CODE=killed EXIT_STATUS=KILL SERVICE_RESULT=signal PI_BG_OUTBOX_CHAIN="$signal_identity" \
  "$SBG" __finalize "$signal_id" "$signal_session" 0
assert_contains "$(<"$signal_dir/result.json")" '"mainExit":null,"mainSignal":"SIGKILL"'
signal_ev="$PI_CODING_AGENT_DIR/tmux-bg/outbox/$signal_session/$signal_id.json"
[[ -f "$signal_ev" ]] || fail "signal death did not publish a failed event"
assert_contains "$(<"$signal_ev")" '"outcome":"failed","exitCode":null,"signal":"KILL"'
(( $(ls "$PI_CODING_AGENT_DIR/tmux-bg/outbox/$signal_session" | wc -l) == 1 )) || fail "signal death published more than one event"

# A core-dumping signal death (EXIT_CODE=dumped, SERVICE_RESULT=core-dump) is
# the same classifiable signal: receipt carries mainSignal and exactly one
# strict-v1 failed event publishes with a null exitCode.
dump_session="dump-origin"
dump_identity="$($BG __prepare "$dump_session")"
dump_id=pi-bg-dump-1-2-3
dump_dir="$PI_CODING_AGENT_DIR/tmux-bg/jobs/$dump_id"
mkdir -p "$dump_dir"; chmod 700 "$dump_dir"
printf '%s\n' "{\"schemaVersion\":1,\"taskId\":\"$dump_id\",\"name\":\"dump\",\"cwd\":\"$TMP\",\"command\":\":\",\"unit\":\"$dump_id.service\",\"piSessionId\":\"$dump_session\",\"sessionPersisted\":false,\"startedAtEpochSec\":1,\"outboxChainIdentity\":\"$dump_identity\"}" >"$dump_dir/meta.json"
chmod 600 "$dump_dir/meta.json"
EXIT_CODE=dumped EXIT_STATUS=ABRT SERVICE_RESULT=core-dump PI_BG_OUTBOX_CHAIN="$dump_identity" \
  "$SBG" __finalize "$dump_id" "$dump_session" 0
assert_contains "$(<"$dump_dir/result.json")" '"mainExit":null,"mainSignal":"SIGABRT"'
dump_ev="$PI_CODING_AGENT_DIR/tmux-bg/outbox/$dump_session/$dump_id.json"
[[ -f "$dump_ev" ]] || fail "core-dump signal death did not publish a failed event"
assert_contains "$(<"$dump_ev")" '"outcome":"failed","exitCode":null,"signal":"ABRT"'
(( $(ls "$PI_CODING_AGENT_DIR/tmux-bg/outbox/$dump_session" | wc -l) == 1 )) || fail "core-dump published more than one event"

# --- mocked boundary: failed stop/list-jobs can never print killed -----------
mock="$TMP/mock-bin"; mkdir -p "$mock"
cat >"$mock/systemctl" <<'EOF'
#!/bin/bash
case "$1" in --version) echo "systemd 255 (mock)"; exit 0 ;; esac
case "$2" in
  show-environment) exit 0 ;;
  show) [[ "${MOCK_SHOW_RC:-0}" != 0 ]] && exit "$MOCK_SHOW_RC"
        printf 'LoadState=%s\nActiveState=%s\nSubState=%s\nMainPID=0\n' \
          "${MOCK_LOAD_STATE:-not-found}" "${MOCK_ACTIVE_STATE:-inactive}" "${MOCK_SUB_STATE:-dead}"; exit 0 ;;
  list-jobs) exit "${MOCK_LISTJOBS_RC:-42}" ;;
  stop|reset-failed) exit "${MOCK_STOP_RC:-42}" ;;
  *) exit 42 ;;
esac
EOF
chmod 700 "$mock/systemctl"
fake=pi-bg-mockjob-1-2-3
mkdir -p "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake"; chmod 700 "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake"
printf 'running\n' >"$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake/state"
set +e; out="$(PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake" 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "kill reported success while stop and list-jobs failed"
[[ "$out" != *killed* ]] || fail "kill printed killed during unverifiable termination"
[[ "$out" == *unconfirmed* ]] || fail "kill failure was not reported as unconfirmed: $out"
[[ ! -e "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake/cancel" ]] || fail "unconfirmed cancel left a stale marker"

# Uncertain (unacknowledged) start can never confirm cancel.
fake2=pi-bg-uncertain-1-2-3
mkdir -p "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake2"; chmod 700 "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake2"
printf 'launching\n' >"$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake2/state"
set +e; out="$(PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake2" 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "uncertain start cancel reported success"
[[ "$out" == *unconfirmed* ]] || fail "uncertain cancel not reported unconfirmed: $out"
[[ ! -e "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake2/cancel" ]] || fail "uncertain cancel retained a marker"
set +e; out="$(MOCK_LOAD_STATE=loaded MOCK_ACTIVE_STATE=active MOCK_STOP_RC=0 MOCK_LISTJOBS_RC=0 PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake2" 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "loaded but unacknowledged start confirmed cancel"
[[ "$out" == *unconfirmed* ]] || fail "loaded uncertain cancel not reported unconfirmed: $out"
[[ ! -e "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake2/cancel" ]] || fail "loaded uncertain cancel retained a marker"

# Missing or unrecognized launch state cannot confirm cancel via not-found,
# even when the job queue is verifiably empty.
fake3=pi-bg-nostate-1-2-3
mkdir -p "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake3"; chmod 700 "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake3"
set +e; out="$(MOCK_LISTJOBS_RC=0 PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake3" 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "missing launch state confirmed cancel"
[[ "$out" == *unconfirmed* ]] || fail "missing launch state not unconfirmed: $out"
printf 'garbage-state\n' >"$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake3/state"
set +e; out="$(MOCK_LISTJOBS_RC=0 PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake3" 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "unrecognized launch state confirmed cancel"
[[ "$out" == *unconfirmed* ]] || fail "unrecognized launch state not unconfirmed: $out"
# The acknowledged path with a verifiably empty queue does confirm.
printf 'running\n' >"$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake3/state"
out="$(MOCK_LISTJOBS_RC=0 PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake3" 2>&1)"
assert_contains "$out" "killed $fake3"

# A validated receipt preserves the result while native state stays unknown.
fake4=pi-bg-receipt-1-2-3
mkdir -p "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake4"; chmod 700 "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake4"
printf '%s\n' "{\"schemaVersion\":1,\"taskId\":\"$fake4\",\"exitCode\":\"exited\",\"exitStatus\":\"0\",\"serviceResult\":\"success\",\"mainExit\":0,\"mainSignal\":null,\"cancelled\":false,\"finishedAtEpochSec\":1}" \
  >"$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake4/result.json"
chmod 600 "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake4/result.json"
st="$(MOCK_SHOW_RC=42 PATH="$mock:/usr/bin:/bin" "$BG" status "$fake4")"
assert_contains "$st" "status=done"
assert_contains "$st" "native=unknown"
assert_contains "$(MOCK_LOAD_STATE=loaded MOCK_ACTIVE_STATE=active PATH="$mock:/usr/bin:/bin" "$BG" status "$fake4")" "status=finalizing"
assert_contains "$(PATH="$mock:/usr/bin:/bin" "$BG" status "$fake2")" "status=failed-start"
set +e; out="$(MOCK_SHOW_RC=42 PATH="$mock:/usr/bin:/bin" "$BG" kill "$fake4" 2>&1)"; rc=$?; set -e
(( rc != 0 )) || fail "receipt with unverifiable native state confirmed cancel"
[[ "$out" == *unconfirmed* ]] || fail "unverifiable native state not unconfirmed: $out"

# --- symlinked storage is rejected -------------------------------------------
ln -sfn "$TMP" "$PI_CODING_AGENT_DIR/tmux-bg/jobs/pi-bg-evil-1-2-3"
assert_fails "$BG" status pi-bg-evil-1-2-3
assert_fails "$BG" output pi-bg-evil-1-2-3
rm "$PI_CODING_AGENT_DIR/tmux-bg/jobs/pi-bg-evil-1-2-3"

# --- clean removes only exact terminal jobs ----------------------------------
clean_out="$($BG clean)"
assert_contains "$clean_out" "cleaned"
[[ -d "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake" ]] || fail "clean removed a non-terminal job"
[[ -d "$PI_CODING_AGENT_DIR/tmux-bg/jobs/$fake2" ]] || fail "clean removed an uncertain-start job"
assert_fails "$BG" status "$victim"  # exact owned dir is gone after clean

printf 'PASS: systemd-bg lifecycle, descendants, failed-exit event, cancel, env, retention, and boundaries\n'
