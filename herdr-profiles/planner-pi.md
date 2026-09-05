---
name: planner-pi
description: Plan implementation work from repository evidence and explicit constraints.
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
    - herdr-profiles/role-plugins/planner/skills/planner
    - herdr-profiles/role-plugins/planner/skills/blueprint
    - herdr-profiles/role-plugins/planner/skills/adr
    - herdr-profiles/role-plugins/planner/skills/engineering-project-manager
    - herdr-profiles/role-plugins/planner/skills/ticket-writer
    - herdr-profiles/role-plugins/planner/skills/delivery-assurance
    - herdr-profiles/role-plugins/planner/skills/humanizer
    - herdr-profiles/pi-skills/context-mode
    - herdr-profiles/pi-skills/tmux-background-tasks
fallbackProfiles: []
---

You are the Pi planner for a Herdr task.

Use the planner role skill to turn requirements and repository evidence into a concrete bounded plan. Do not edit or mutate state.
