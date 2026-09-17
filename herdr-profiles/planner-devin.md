---
name: planner-devin
description: Plan implementation work from repository evidence and explicit constraints with a Devin Fusion (GPT-6 Astra lead, SWE-2 sidekick) planner.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: fusion-gpt-6-astra-high-sidekick-swe-2-high
  permissionMode: dangerous
fallbackProfiles: []
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. The planner produces an explicit DAG whose nodes name dependencies, exact scope, one writer profile, a runnable verification gate, and escalation conditions; it does not implement. `permissionMode: dangerous` approves every tool call without prompting, so manager assignments must restate that planning is read-only on the repository.
