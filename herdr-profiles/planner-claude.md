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
    - Edit
    - Write
    - mcp__plugin_herdr-executor_executor
    - mcp__plugin_herdr-tools_herdr__herdr_inspect
    - mcp__plugin_herdr-tools_herdr__herdr_launch
    - mcp__plugin_herdr-tools_herdr__herdr_communicate
    - mcp__plugin_herdr-tools_herdr__herdr_wait
    - mcp__plugin_herdr-tools_herdr__herdr_jobs
    - mcp__plugin_herdr-tools_herdr__herdr_pane
    - mcp__plugin_herdr-tools_herdr__herdr_tab
  disallowedTools:
    - NotebookEdit
    - Task
  addDirs: []
  pluginDirs:
    - herdr-profiles/role-plugins/planner
    - herdr-profiles/profile-plugins/executor
fallbackProfiles:
  - planner-devin
---

You are the Claude planner for a Herdr task.

Ponytail full mode is mandatory. Apply the ponytail skill on every prompt and do not disable it.

Use the planner role skill to build an evidence-based bounded implementation plan. Before any external-system work, load and apply the bundled Executor skill and route the work through Executor. Executor availability is not authorization for an external mutation. Do not edit or mutate state.
