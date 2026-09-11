---
name: manager-devin
description: Visible Herdr orchestration and evidence synthesis with a Devin SWE-2 Max manager.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: swe-2-max
  permissionMode: dangerous
fallbackProfiles: []
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. The manager coordinates profile-backed workers through the Herdr tools, never writes inside a worker's checkout, and verifies every gate itself before releasing dependent work. `permissionMode: dangerous` approves every tool call without prompting, so manager assignments must restate the orchestration scope and supervision rules explicitly.
