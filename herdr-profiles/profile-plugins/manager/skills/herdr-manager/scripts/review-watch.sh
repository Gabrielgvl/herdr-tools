#!/bin/bash
# Usage: PRS="10034 10030 10031" ./review-watch.sh > /tmp/review-watch.log 2>&1 &
# Watches reviews, threads, comments, and requests for space-separated Backend PRs every five minutes.
# Monitor tail pattern: one persistent Monitor running `tail -n0 -F /tmp/review-watch.log`.
prev=""
read -r -a prs <<< "${PRS:-10034 10030 10031}"
while true; do
  cur=""
  for n in "${prs[@]}"; do
    s=$(gh api graphql -f query="{ repository(owner:\"trycourier\", name:\"backend\") { pullRequest(number:$n) { reviewDecision reviews(last:20) { nodes { author { login } state submittedAt } } reviewThreads(first:50) { nodes { isResolved path line comments(first:1) { nodes { author { login } createdAt } } } } comments(last:10) { nodes { author { login } createdAt } } reviewRequests(first:10) { nodes { requestedReviewer { ... on User { login } } } } } } }" 2>/dev/null \
      | jq -r --arg n "$n" '.data.repository.pullRequest | "#\($n) rd=\(.reviewDecision) reviews=[\([.reviews.nodes[] | "\(.author.login):\(.state)"] | join(","))] threads_open=\([.reviewThreads.nodes[] | select(.isResolved==false)] | length) threads=[\([.reviewThreads.nodes[] | select(.isResolved==false) | "\(.comments.nodes[0].author.login)@\(.path):\(.line // "-")"] | join(","))] comments=\(.comments.nodes | length) last_comment=\(.comments.nodes[-1].author.login // "-") requested=[\([.reviewRequests.nodes[].requestedReviewer.login] | join(","))]"')
    cur+="$s"$'\n'
  done
  if [[ "$cur" != "$prev" ]]; then echo "[$(date -u +%FT%TZ)] REVIEW CHANGE"; echo "$cur"; prev="$cur"; fi
  sleep 300
done
