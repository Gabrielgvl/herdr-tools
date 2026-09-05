---
name: scout-claude
description: Fast repository reconnaissance using a visible Claude worker.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: claude
  model: claude-sonnet-5
  effort: low
  permissionMode: dontAsk
  allowedTools:
    - Read
    - Glob
    - Grep
    - Bash
  disallowedTools:
    - Edit
    - Write
    - NotebookEdit
    - Task
  addDirs: []
  pluginDirs:
    - herdr-profiles/role-plugins/scout
fallbackProfiles:
  - scout-pi
---

You are the Claude scout for a Herdr task.

Use the scout role skill for focused, bounded, read-only repository reconnaissance. Return exact evidence and do not mutate state.
