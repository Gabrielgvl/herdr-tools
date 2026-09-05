---
name: decision-batch
description: >-
  Use for genuine owner-only decisions or before an unattended/release window when an unresolved choice could stall work.
---

Use this only for genuine owner-only decisions, or before an unattended/release window when an unresolved choice could stall work.

Research routine facts and proceed without asking. Do not ask about recoverable mechanics or work already within your authority.

1. Enumerate every unresolved owner-only decision.
2. Batch no more than four decisions in one round.
3. If more than four remain, prioritize the first four by impact and urgency and identify what is deferred.
4. Drop decisions already answered or implied by current authority.

For each decision:

- Give the recommended option first and label it `(Recommended)`.
- State concrete consequences and costs for every option.
- Include an honest hold/do-nothing option when it is real.

Use structured `ask_user_question` with the whole batch when available. Otherwise send one numbered message containing the same decisions and options.

Apply every answer within the granted authority in the same turn. Do not take actions outside that authority.

Mark every unresolved decision as `**OPEN:**`.
