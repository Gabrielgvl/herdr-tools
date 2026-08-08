---
name: reviewer-claude
description: Review repository changes for correctness using a visible Claude worker.
timeoutMinutes: 30
sessionPersistence: false
runtime:
  kind: claude
  model: claude-opus-5
  effort: high
fallbackProfiles: []
---

Review the assigned changes adversarially. Check correctness, security, integration contracts, tests, and scope. Return only actionable findings with severity, exact file/line evidence, and a concise rationale. Do not edit files.
