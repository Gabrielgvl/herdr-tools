#!/usr/bin/env bash
# Isolated regression check for scripts/herdr-tools-autoupdate.sh.
# Uses a fake bare remote, a dirty "original" checkout, an installed linked
# worktree, and a stubbed npm. No real remote, credential, or package manager.
set -euo pipefail
cd "$(dirname "$0")/.."
SCRIPT=$PWD/scripts/herdr-tools-autoupdate.sh

ROOT=$(mktemp -d /tmp/herdr-tools-autoupdate-test.XXXXXX)
trap 'rm -rf "$ROOT"' EXIT

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export HERDR_TOOLS_UPDATE_DIR=$ROOT/installed
export HERDR_TOOLS_UPDATE_STATE_DIR=$ROOT/state
export STUB_NPM_LOG=$ROOT/npm.log STUB_NPM_FAIL=0

mkdir "$ROOT/bin"
cat >"$ROOT/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$STUB_NPM_LOG"
[ "$STUB_NPM_FAIL" = 1 ] && exit 1
case "${1:-} ${2:-}" in
	"ci ") mkdir -p node_modules ;;
	"run build:mcp") mkdir -p dist/src && echo '// stub build' >dist/src/mcp-server.js ;;
esac
EOF
chmod +x "$ROOT/bin/npm"
export PATH="$ROOT/bin:$PATH"
: >"$STUB_NPM_LOG"

fail() { echo "FAIL: $*" >&2; exit 1; }
eq() { [ "$1" = "$2" ] || fail "$3 (want '$2', got '$1')"; }
head_of() { git -C "$1" rev-parse HEAD; }
try() { out=$(bash "$SCRIPT" 2>&1) && rc=0 || rc=$?; }
receipt_head() { awk 'END {print $3}' "$ROOT/state/last-success" 2>/dev/null || true; }
prime_untouched() {
	eq "$(git -C "$ROOT/prime" symbolic-ref --short HEAD)" feature 'original checkout moved branch'
	eq "$(git -C "$ROOT/prime" status --porcelain)" ' M file.txt' 'original dirty worktree changed'
}

# Fixture: bare remote, upstream seed, dirty original checkout, installed worktree.
git init -q --bare -b main "$ROOT/remote.git"
git clone -q "$ROOT/remote.git" "$ROOT/upstream"
printf 'node_modules/\ndist/\nconfig.json\n' >"$ROOT/upstream/.gitignore"
echo '{}' >"$ROOT/upstream/package-lock.json"
echo v1 >"$ROOT/upstream/file.txt"
git -C "$ROOT/upstream" add -A
git -C "$ROOT/upstream" commit -qm v1
git -C "$ROOT/upstream" push -q origin main

git clone -q "$ROOT/remote.git" "$ROOT/prime"
git -C "$ROOT/prime" checkout -qb feature
echo dirty >>"$ROOT/prime/file.txt"
git -C "$ROOT/prime" worktree add -q "$ROOT/installed" main
printf '{"local":"fixture"}\n' >"$ROOT/installed/config.json"
eq "$(git -C "$ROOT/installed" status --porcelain)" '' 'local config blocked clean install'

push_commit() { # $1=label  $2='lock' to bump package-lock.json
	echo "$1" >>"$ROOT/upstream/file.txt"
	[ "${2:-}" = lock ] && echo "\"$1\":1" >>"$ROOT/upstream/package-lock.json" || true
	git -C "$ROOT/upstream" add -A
	git -C "$ROOT/upstream" commit -qm "$1"
	git -C "$ROOT/upstream" push -q origin main
}

echo '== bootstrap: up-to-date remote, missing dist still builds'
try; eq "$rc" 0 'bootstrap rc'
[ -s "$ROOT/installed/dist/src/mcp-server.js" ] || fail 'bootstrap produced no entry'
eq "$(receipt_head)" "$(head_of "$ROOT/installed")" 'receipt after bootstrap'
grep -q 'npm ci' "$STUB_NPM_LOG" || fail 'bootstrap skipped npm ci'
grep -q 'npm run build:mcp' "$STUB_NPM_LOG" || fail 'bootstrap skipped build'

echo '== no-op'
before=$(wc -l <"$STUB_NPM_LOG")
try; eq "$rc" 0 'no-op rc'
echo "$out" | grep -q 'up-to-date' || fail "no-op message: $out"
eq "$(wc -l <"$STUB_NPM_LOG")" "$before" 'no-op invoked npm'

echo '== restore missing dependencies at the same revision'
rm -rf "$ROOT/installed/node_modules"
try; eq "$rc" 0 'missing-dependencies retry rc'
[ -d "$ROOT/installed/node_modules" ] || fail 'missing dependencies were not restored'
[ "$(wc -l <"$STUB_NPM_LOG")" -gt "$before" ] || fail 'missing dependencies skipped npm ci'
eq "$(receipt_head)" "$(head_of "$ROOT/installed")" 'receipt after dependency recovery'

echo '== fast-forward with dependency change'
push_commit v2 lock
v2=$(head_of "$ROOT/upstream")
try; eq "$rc" 0 'ff rc'
eq "$(head_of "$ROOT/installed")" "$v2" 'installed did not fast-forward'
eq "$(receipt_head)" "$v2" 'receipt after ff'
[ "$(grep -c 'npm ci' "$STUB_NPM_LOG")" -ge 2 ] || fail 'ff skipped npm ci on dep change'
prime_untouched

echo '== dirty refusal'
echo x >>"$ROOT/installed/file.txt"
try; [ "$rc" -ne 0 ] || fail 'dirty run exited 0'
echo "$out" | grep -q 'dirty' || fail "dirty message: $out"
eq "$(head_of "$ROOT/installed")" "$v2" 'dirty run moved HEAD'
git -C "$ROOT/installed" checkout -q -- file.txt

echo '== divergent refusal, then manual recovery'
echo local >"$ROOT/installed/local.txt"
git -C "$ROOT/installed" add local.txt
git -C "$ROOT/installed" commit -qm local
local_sha=$(head_of "$ROOT/installed")
push_commit v3
v3=$(head_of "$ROOT/upstream")
try; [ "$rc" -ne 0 ] || fail 'divergent run exited 0'
echo "$out" | grep -q 'non-fast-forward' || fail "divergent message: $out"
eq "$(head_of "$ROOT/installed")" "$local_sha" 'divergent run moved HEAD'
git -C "$ROOT/installed" reset -q --hard "$v3"
try; eq "$rc" 0 'recovery rc'
eq "$(receipt_head)" "$v3" 'receipt after recovery'

echo '== build failure, then idempotent retry'
push_commit v4
v4=$(head_of "$ROOT/upstream")
export STUB_NPM_FAIL=1
try; [ "$rc" -ne 0 ] || fail 'failing build exited 0'
eq "$(head_of "$ROOT/installed")" "$v4" 'failed run did not keep merged HEAD'
eq "$(receipt_head)" "$v3" 'failed run wrote a receipt'
export STUB_NPM_FAIL=0
try; eq "$rc" 0 'retry rc'
eq "$(receipt_head)" "$v4" 'receipt after retry'
[ -s "$ROOT/installed/dist/src/mcp-server.js" ] || fail 'retry produced no entry'

prime_untouched
echo 'all autoupdate checks passed'
