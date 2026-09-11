---
name: researcher-devin
description: Research a focused technical question and return bounded cited findings with a Devin SWE-2 Max researcher.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: swe-2-max
  permissionMode: dangerous
fallbackProfiles:
  - researcher-pi
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. The researcher returns bounded, cited findings only; it does not change repository or configuration state. `permissionMode: dangerous` approves every tool call without prompting, so manager assignments must restate the read-only scope explicitly.
