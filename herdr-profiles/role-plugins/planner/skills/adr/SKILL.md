---
name: adr
description: Read and apply Courier architecture decision records. Use when planning, reviewing, or implementing changes with architecture, infrastructure, interface, routing, or cross-service impact.
---

# ADR Skill

Use this skill whenever a ticket could change shared architecture or when a review needs to validate architectural compliance.

## Primary workspace sources

- `docs/context/adr/index.md`
- `docs/adr/*.md`
- `docs/context/git-conventions.md`
- `templates/template-7-adr.md`

## Reference implementation

If you need the longer repo-specific ADR workflow, read:
- `../../../services/.claude/skills/ADR/SKILL.md`

## Rules

1. Load `Compliance.md` first for the quick binding-rules check.
2. Treat **ACCEPTED** ADRs as binding.
3. Treat **PROPOSED** ADRs as advisory until ratified.
4. If the design or implementation would violate an accepted ADR, stop and surface the conflict explicitly.
5. If a new system-wide decision is required, propose a new ADR instead of silently drifting from precedent.
