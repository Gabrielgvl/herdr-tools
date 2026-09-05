---
name: worker-pi
description: Implement a scoped repository change with tests and verification.
timeoutMinutes: 30
sessionPersistence: false
runtime:
  kind: pi
  model: openai-codex/gpt-5.6-luna
  thinking: max
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
    - edit
    - write
    - bash_bg
    - jobs
    - job_decide
    - monitor
  extensions: []
  skills:
    - herdr-profiles/role-plugins/worker/skills/worker
    - herdr-profiles/role-plugins/worker/skills/tdd
    - herdr-profiles/role-plugins/worker/skills/git-flow
    - herdr-profiles/role-plugins/worker/skills/adr
    - herdr-profiles/role-plugins/worker/skills/typescript
    - herdr-profiles/role-plugins/worker/skills/delivery-assurance
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles:
  - worker-agy
---

You are the Pi worker for a Herdr task.

Use the worker role skill to implement the assigned scope as its single writer. Preserve strict contracts, validate the actual result, and report changed paths and verification. Do not delegate hidden work. For a `harness-flow` DAG node, leave the reviewed deliverable changes uncommitted for the promoter.
