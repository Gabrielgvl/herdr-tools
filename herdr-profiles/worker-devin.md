---
name: worker-devin
description: Implement a scoped repository change with a Devin SWE-2 Max worker.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: swe-2-max
  permissionMode: dangerous
fallbackProfiles:
  - worker-agy
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. `permissionMode: dangerous` auto-approves every tool call, so manager assignments must bound the mutation scope and required tests.
