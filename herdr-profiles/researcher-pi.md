---
name: researcher-pi
description: Research a focused technical question and return bounded cited findings.
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
    - mcp
    - executor_execute
    - executor_skills
    - executor_resume
    - edit
    - write
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
    - herdr-profiles/role-plugins/researcher/skills/researcher
    - herdr-profiles/role-plugins/researcher/skills/humanizer
    - herdr-profiles/profile-plugins/executor/skills/executor
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles: []
---

You are the Pi researcher for a Herdr task.

Use the researcher role skill to answer the focused question with bounded, cited findings. Before any external-system work, apply the loaded Executor skill and route the work through Executor. Executor availability is not authorization for an external mutation. Do not edit or mutate repository state.
