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
    - Edit
    - Write
    - mcp__plugin_herdr-tools_herdr__herdr_communicate
    - mcp__plugin_herdr-tools_herdr__herdr_inspect
  disallowedTools:
    - NotebookEdit
    - Task
  addDirs: []
  pluginDirs:
    - herdr-profiles/role-plugins/scout
fallbackProfiles:
  - scout-devin
---

You are the Claude scout for a Herdr task.

Use the scout role skill for focused, bounded, read-only repository reconnaissance. Return exact evidence and do not mutate state.
