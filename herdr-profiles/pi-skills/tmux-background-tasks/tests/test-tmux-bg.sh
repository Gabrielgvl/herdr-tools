#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BG="$ROOT/scripts/tmux-bg"
SOCKET="pi-tmux-bg-test-$$"
TMP="$(mktemp -d)"
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
  for ((i=0; i<100; i++)); do
    result="$($BG status "$id")"
    [[ "$result" == *"status=done"* ]] && { printf '%s\n' "$result"; return; }
    sleep 0.05
  done
  fail "task did not finish: $id"
}

command -v tmux >/dev/null || fail "tmux is required for tests"
chmod +x "$BG"

# Empty state succeeds even when no tmux server exists.
[[ -z "$($BG list)" ]] || fail "fresh task list was not empty"

# Validate trust boundaries before tmux is touched.
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

# Fast success remains inspectable with its output and exact exit code.
id="$($BG start "Quick Success" "$TMP" "printf 'hello world\\n'")"
assert_contains "$id" "pi-bg-quick-success-"
assert_contains "$(wait_done "$id")" "exit=0"
assert_contains "$($BG output "$id")" "hello world"

# Shell quoting, expansion, operators, and nonzero exits are preserved.
id_quote="$($BG start quoting "$TMP" "printf '%s\\n' 'a b \$HOME \"quote\"'; exit 7")"
assert_contains "$(wait_done "$id_quote")" "exit=7"
quote_output="$($BG output "$id_quote")"
assert_contains "$quote_output" 'a b $HOME "quote"'

# Working directories with spaces are passed as data, not shell syntax.
mkdir -p "$TMP/dir with spaces"
id_cwd="$($BG start cwd "$TMP/dir with spaces" 'pwd')"
wait_done "$id_cwd" >/dev/null
assert_contains "$($BG output "$id_cwd")" "$TMP/dir with spaces"

# Output is tail-bounded and strips only trailing empty pane rows.
id_tail="$($BG start tail "$TMP" 'seq 1 100')"
wait_done "$id_tail" >/dev/null
tail_output="$($BG output "$id_tail" 5)"
[[ "$(printf '%s\n' "$tail_output" | wc -l)" -eq 5 ]] || fail "output was not limited to five lines"
assert_contains "$tail_output" "100"
assert_not_contains "$tail_output" $'1\n'

# Concurrent repeated names receive distinct IDs and appear in list.
id_run1="$($BG start same "$TMP" 'sleep 30')"
id_run2="$($BG start same "$TMP" 'sleep 30')"
[[ "$id_run1" != "$id_run2" ]] || fail "task IDs collided"
list="$($BG list)"
assert_contains "$list" "$id_run1"
assert_contains "$list" "$id_run2"
assert_contains "$($BG status "$id_run1")" "status=running"

# Clean removes completed managed sessions only, preserving running and unrelated sessions.
# The unrelated session deliberately looks like a generated ID but lacks the ownership marker.
unrelated_id="pi-bg-unrelated-111-222-333"
tmux -L "$SOCKET" new-session -d -s "$unrelated_id" 'sleep 30'
cleaned="$($BG clean)"
assert_contains "$cleaned" "completed task"
assert_contains "$($BG list)" "$id_run1"
assert_not_contains "$($BG list)" "$unrelated_id"
tmux -L "$SOCKET" has-session -t "$unrelated_id"
assert_fails "$BG" status "$id"
assert_fails "$BG" status "$unrelated_id"

# Kill accepts only an existing managed ID and does not touch unrelated tmux sessions.
assert_contains "$($BG kill "$id_run1")" "killed $id_run1"
assert_fails "$BG" status "$id_run1"
tmux -L "$SOCKET" has-session -t "$unrelated_id"
assert_fails "$BG" kill "$unrelated_id"
assert_fails "$BG" kill "$id_run1"
$BG kill "$id_run2" >/dev/null

# A setup failure removes the partially-created session.
real_tmux="$(command -v tmux)"
fake_tmux="$TMP/failing-tmux"
cat >"$fake_tmux" <<EOF
#!/usr/bin/env bash
if [[ " \$* " == *" set-option "* ]]; then exit 9; fi
exec "$real_tmux" "\$@"
EOF
chmod +x "$fake_tmux"
before="$(tmux -L "$SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep '^pi-bg-' || true)"
assert_fails /usr/bin/env TMUX_BIN="$fake_tmux" "$BG" start partial "$TMP" 'sleep 30'
after="$(tmux -L "$SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep '^pi-bg-' || true)"
[[ "$before" == "$after" ]] || fail "partial session leaked after setup failure"

printf 'PASS: tmux-bg lifecycle and edge cases\n'
