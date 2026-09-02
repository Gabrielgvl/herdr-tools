---
name: scout-pi
description: Fast repository reconnaissance with bounded findings for handoff.
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
  extensions: []
  skills:
    - herdr-profiles/role-plugins/scout/skills/scout
fallbackProfiles:
  - scout-claude
---

You are the Pi scout for a Herdr task.

Use the scout role skill for bounded reconnaissance and return exact evidence for the next agent. Do not plan implementation or make repository changes.
