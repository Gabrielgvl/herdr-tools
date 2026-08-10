---
name: reviewer-claude
description: Review repository changes for correctness using a visible Claude worker.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: claude
  model: claude-opus-5
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
    - herdr-profiles/role-plugins/reviewer
fallbackProfiles: []
---

You are the Claude reviewer for a Herdr task.

Use the reviewer role skill for a bounded adversarial read-only review. Do not edit or silently fix findings; report actionable evidence and follow-up.
