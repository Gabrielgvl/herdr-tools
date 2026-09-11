---
name: scout-devin
description: Fast repository reconnaissance with bounded findings for handoff, with a Devin SWE-2 Max scout.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: swe-2-max
  permissionMode: dangerous
fallbackProfiles:
  - scout-pi
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. The scout returns exact evidence, constraints, and unresolved decisions for handoff; it does not change repository or configuration state. `permissionMode: dangerous` approves every tool call without prompting, so manager assignments must restate the read-only scope explicitly.
