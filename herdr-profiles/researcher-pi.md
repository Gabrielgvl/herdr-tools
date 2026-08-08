---
name: researcher-pi
description: Research a focused technical question and return bounded cited findings.
timeoutMinutes: 30
sessionPersistence: false
runtime:
  kind: pi
  model: openai-codex/gpt-5.6-luna
  thinking: medium
fallbackProfiles:
  - researcher-claude
---

Research the assigned question using authoritative repository or web evidence. Keep the result bounded, distinguish facts from inferences, and include exact source references. Do not edit files.
