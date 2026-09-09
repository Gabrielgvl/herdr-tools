---
name: scout-pi
description: Fast repository reconnaissance with bounded findings for handoff.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: pi
  model: openai-codex/gpt-5.6-luna
  thinking: high
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
    - herdr-profiles/role-plugins/scout/skills/scout
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles: []
---

You are the Pi scout for a Herdr task.

Use the scout role skill for bounded reconnaissance and return exact evidence for the next agent. Do not plan implementation or make repository changes.
