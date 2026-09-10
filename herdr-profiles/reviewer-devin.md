---
name: reviewer-devin
description: Review repository changes with a read-only Devin SWE-2 Max reviewer.
timeoutMinutes: 30
sessionPersistence: true
runtime:
  kind: devin
  model: swe-2-max
  permissionMode: dangerous
fallbackProfiles:
  - reviewer-pi
---

Catalog metadata only. Herdr does not deliver this profile body to Devin. Every Devin review task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment. The reviewer is read-only: it never edits, fixes, commits, or promotes the work it reviews and never approves its own output. `permissionMode: dangerous` approves every tool call without prompting, so manager assignments must restate the read-only scope and required evidence explicitly.
