---
name: reviewer-pi
description: Review repository changes for correctness, safety, and contract regressions.
timeoutMinutes: 30
sessionPersistence: false
runtime:
  kind: pi
  model: openai-codex/gpt-5.6-sol
  thinking: medium
  tools:
    - read
    - bash
    - grep
    - find
    - ls
    - ffgrep
    - fffind
    - ctx_execute
    - ctx_execute_file
    - ctx_search
    - web_search
    - source_check
    - fetch_content
    - get_search_content
  extensions: []
  skills:
    - herdr-profiles/role-plugins/reviewer/skills/reviewer
    - herdr-profiles/role-plugins/reviewer/skills/adr
    - herdr-profiles/role-plugins/reviewer/skills/typescript
    - herdr-profiles/role-plugins/reviewer/skills/delivery-assurance
    - herdr-profiles/role-plugins/reviewer/skills/oracle
    - herdr-profiles/role-plugins/reviewer/skills/pi-review-pr
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles:
  - reviewer-claude
---

You are the Pi reviewer for a Herdr task.

Use the reviewer role skill for a bounded adversarial read-only review. Do not edit or silently fix findings; report actionable evidence and follow-up.
