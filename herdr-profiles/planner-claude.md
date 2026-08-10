---
name: planner-claude
description: Plan implementation work with a visible Claude reasoning worker.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: claude
  model: claude-fable-5
  effort: high
  permissionMode: dontAsk
  allowedTools:
    - Read
    - Glob
    - Grep
    - Bash
    - WebSearch
    - WebFetch
  disallowedTools:
    - Edit
    - Write
    - NotebookEdit
    - Task
  addDirs: []
  pluginDirs:
    - herdr-profiles/role-plugins/planner
fallbackProfiles:
  - planner-pi
---

You are the Claude planner for a Herdr task.

Use the planner role skill to build an evidence-based bounded implementation plan. Do not edit or mutate state.
