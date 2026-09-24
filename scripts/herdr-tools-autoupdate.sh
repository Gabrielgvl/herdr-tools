#!/usr/bin/env bash
# herdr-tools-autoupdate: fast-forward the installed herdr-tools checkout to
# <remote>/<branch> and rebuild dist/src/mcp-server.js.
#
# Fail-closed: a dirty tree, a non-main branch, or a non-fast-forward exits
# nonzero after the fetch and changes nothing in the checkout. Idempotent:
# success is recorded in $STATE/last-success only after the compiled entry
# exists, so an interrupted run is retried by the next timer tick.
set -euo pipefail

DIR=${HERDR_TOOLS_UPDATE_DIR:-$HOME/.pi/agent/extensions/herdr-tools}
REMOTE=${HERDR_TOOLS_UPDATE_REMOTE:-origin}
BRANCH=${HERDR_TOOLS_UPDATE_BRANCH:-main}
STATE=${HERDR_TOOLS_UPDATE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tools-autoupdate}
ENTRY=${HERDR_TOOLS_UPDATE_ENTRY:-dist/src/mcp-server.js}

log() { printf 'herdr-tools-autoupdate: %s\n' "$*"; }
fail() { log "refusing: $*" >&2; exit 1; }

# This script lives inside the checkout it updates; run a snapshot so a
# mid-run checkout cannot corrupt bash's incremental read of the script.
if [ -z "${HERDR_TOOLS_UPDATE_REEXEC:-}" ]; then
	tmp=$(mktemp /tmp/herdr-tools-autoupdate.XXXXXX)
	cp -- "$0" "$tmp"
	HERDR_TOOLS_UPDATE_REEXEC=1 exec bash "$tmp" "$@"
fi
trap 'rm -f -- "$0"' EXIT

mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { log "another run holds the lock; skipping"; exit 0; }

git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 || fail "$DIR is not a git checkout"
cd "$DIR"

[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" = "$BRANCH" ] || fail "HEAD is not $BRANCH"
[ -z "$(git status --porcelain)" ] || fail "checkout is dirty"

git fetch --quiet "$REMOTE" "$BRANCH" || fail "fetch $REMOTE $BRANCH failed"
old=$(git rev-parse HEAD)
new=$(git rev-parse FETCH_HEAD)

built=$(awk 'END {print $3}' "$STATE/last-success" 2>/dev/null || true)
if [ "$old" = "$new" ] && [ "$built" = "$new" ] && [ -s "$ENTRY" ] && [ -d node_modules ]; then
	log "up-to-date at $old"
	exit 0
fi

depfiles=retry # old == new here means a previous run died post-merge; reconcile deps
if [ "$old" != "$new" ]; then
	git merge-base --is-ancestor "$old" "$new" || fail "non-fast-forward ($old -> $new)"
	depfiles=$(git diff --name-only "$old" "$new" -- package.json package-lock.json)
	git merge --ff-only --quiet "$new" || fail "merge --ff-only failed"
	log "fast-forwarded $old -> $new"
fi

if [ -n "$depfiles" ] || [ ! -d node_modules ]; then
	log "npm ci"
	npm ci
fi
log "npm run build:mcp"
npm run build:mcp
[ -s "$ENTRY" ] || fail "build did not produce $ENTRY"

printf '%s %s %s\n' "$(date -Is)" "$old" "$new" >>"$STATE/last-success"
log "updated to $new"
