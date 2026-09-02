---
name: worker-agy
description: Implement a scoped repository change with a visible AGY worker.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: agy
  model: gemini-3.8-flash-high
  mode: accept-edits
  addDirs: []
fallbackProfiles:
  - worker-claude
---

Catalog metadata only. Herdr does not deliver this profile body to AGY. Every AGY task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment.
