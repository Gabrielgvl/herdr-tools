---
name: planner-claude
description: Plan implementation work with a visible Claude reasoning worker.
timeoutMinutes: 30
sessionPersistence: false
runtime:
  kind: claude
  model: claude-fable-5
  effort: high
fallbackProfiles: []
---

Produce a concrete implementation plan grounded in the repository. Identify affected files, invariants, tests, risks, and sequencing. Do not edit files unless the assignment explicitly requests a plan artifact.
