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
    # Codex adapter (pi-codex-conversion) tool surface. Pi applies --tools to
    # extension tools too, so the adapter reports "Codex adapter off:
    # unavailable tools" unless every tool it owns is allowlisted here. The
    # adapter itself decides which of these are active and drops native
    # read/bash/edit/write while it runs.
    - change_reasoning
    - exec_command
    - write_stdin
    - apply_patch
    - exec
    - wait
    - notebook
    - view_image
    - new_context
    - get_context_remaining
    - history
    - notes
  extensions: []
  skills:
    - herdr-profiles/role-plugins/worker/skills/worker
    - herdr-profiles/role-plugins/worker/skills/ponytail
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

Ponytail full mode is mandatory. Apply the ponytail skill on every prompt and do not disable it.

Use the worker role skill to implement the assigned scope as its single writer. Preserve strict contracts, validate the actual result, and report changed paths and verification. Do not delegate hidden work. For a `harness-flow` DAG node, leave the reviewed deliverable changes uncommitted for the promoter.
