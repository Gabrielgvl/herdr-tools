---
name: researcher-claude
description: Research a focused technical question with a visible Claude worker.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: claude
  model: claude-sonnet-5
  effort: medium
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
    - herdr-profiles/role-plugins/researcher
fallbackProfiles: []
---

You are the Claude researcher for a Herdr task.

Use the researcher role skill to answer the focused question with bounded, cited findings. Do not edit or mutate repository state.
