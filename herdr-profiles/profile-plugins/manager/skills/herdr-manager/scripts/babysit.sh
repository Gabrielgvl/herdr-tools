#!/bin/bash
# Usage: PRS="10030 10034 10082" ./babysit.sh > /tmp/babysit.log 2>&1 &
# Watches space-separated Backend PRs from $PRS, defaulting to the list above, every five minutes.
# Monitor tail pattern: one persistent Monitor running `tail -n0 -F /tmp/babysit.log`.
export GH_PAGER=cat
prev=""
read -r -a prs <<< "${PRS:-10030 10034 10082}"
while true; do
  cur=""
  for n in "${prs[@]}"; do
    s=$(gh pr view "$n" -R trycourier/backend --json state,mergedAt,isDraft,mergeStateStatus,headRefOid,autoMergeRequest,reviewDecision \
      --jq '"\(.state)|\(.isDraft)|\(.mergeStateStatus)|\(.headRefOid[0:8])|am=\(.autoMergeRequest!=null)|rd=\(.reviewDecision)|merged=\(.mergedAt // "-")"' 2>&1 | tr '\n' ' ')
    cur+="#$n $s"$'\n'
  done
  if [[ "$cur" != "$prev" ]]; then
    echo "[$(date -u +%FT%TZ)] STATE CHANGE"; echo "$cur"
    grep -E "MERGED|BEHIND|DIRTY|am=false" <<<"$cur" | sed 's/^/  FLAG: /'
    prev="$cur"
  fi
  sleep 300
done
