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
    - Edit
    - Write
    - mcp__plugin_herdr-executor_executor
    - mcp__plugin_herdr-tools_herdr__herdr_communicate
    - mcp__plugin_herdr-tools_herdr__herdr_inspect
  disallowedTools:
    - NotebookEdit
    - Task
  addDirs: []
  pluginDirs:
    - herdr-profiles/role-plugins/researcher
    - herdr-profiles/profile-plugins/executor
fallbackProfiles:
  - researcher-devin
---

You are the Claude researcher for a Herdr task.

Use the researcher role skill to answer the focused question with bounded, cited findings. Before any external-system work, load and apply the bundled Executor skill and route the work through Executor. Executor availability is not authorization for an external mutation. Do not edit or mutate repository state.
