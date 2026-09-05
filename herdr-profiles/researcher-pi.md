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
    - edit
    - write
  extensions: []
  skills:
    - herdr-profiles/role-plugins/researcher/skills/researcher
    - herdr-profiles/role-plugins/researcher/skills/humanizer
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles: []
---

You are the Pi researcher for a Herdr task.

Use the researcher role skill to answer the focused question with bounded, cited findings. Do not edit or mutate repository state.
