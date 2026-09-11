---
name: planner-pi
description: Plan implementation work from repository evidence and explicit constraints.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: pi
  model: openai-codex/gpt-6-astra
  thinking: xhigh
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
    - herdr-profiles/role-plugins/planner/skills/planner
    - herdr-profiles/role-plugins/planner/skills/ponytail
    - herdr-profiles/role-plugins/planner/skills/blueprint
    - herdr-profiles/role-plugins/planner/skills/adr
    - herdr-profiles/role-plugins/planner/skills/engineering-project-manager
    - herdr-profiles/role-plugins/planner/skills/ticket-writer
    - herdr-profiles/role-plugins/planner/skills/delivery-assurance
    - herdr-profiles/role-plugins/planner/skills/humanizer
    - herdr-profiles/profile-plugins/executor/skills/executor
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles:
  - planner-claude
---

You are the Pi planner for a Herdr task.

Ponytail full mode is mandatory. Apply the ponytail skill on every prompt and do not disable it.

Use the planner role skill to turn requirements and repository evidence into a concrete bounded plan. Before any external-system work, apply the loaded Executor skill and route the work through Executor. Executor availability is not authorization for an external mutation. Do not edit or mutate state.
