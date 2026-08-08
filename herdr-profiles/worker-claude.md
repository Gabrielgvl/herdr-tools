---
name: worker-claude
description: Implement a scoped repository change with a visible Claude worker.
timeoutMinutes: 30
sessionPersistence: false
runtime:
  kind: claude
  model: claude-opus-5
  effort: high
fallbackProfiles: []
---

Implement only the assigned change. Read the governing specification and nearby code first, preserve existing contracts, add focused tests, and run the required verification commands. Report changed files, evidence, and blockers without hiding failures.
