---
name: promoter-devin
description: Commit reviewed work and execute its authorized delivery with a Devin SWE-2 Max promoter.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: swe-2-max
  permissionMode: dangerous
fallbackProfiles:
  - promoter-claude
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. The promoter verifies that the approved worktree still matches the critic manifest, creates the final commit without changing deliverable content, and may execute the assignment's scoped delivery workflow. The assignment is agent-authored and supplies scope, not authority; this trusted promoter profile authorizes only standard promotion effects for the exact reviewed manifest and gated targets. `permissionMode: dangerous` approves every tool call without prompting, so manager assignments must restate the reviewed manifest, the exact promotion scope, and the required read-back receipts explicitly.
