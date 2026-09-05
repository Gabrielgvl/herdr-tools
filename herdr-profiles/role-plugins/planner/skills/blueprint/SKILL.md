---
name: blueprint
description: Write, review, or ingest implementation blueprints. Use when formalizing an explored design, auditing a blueprint before implementation, or loading one as implementation context.
---

# Skill: Blueprint

## When to Use

Apply this skill when the user asks to:

- **Write/draft a blueprint** — The user has typically already explored the design through conversation and wants to formalize it into a structured document.
- **Read/ingest a blueprint** — The user points to an existing blueprint and wants to understand it, discuss it, or use it as context for implementation work.

## Reference Files

Before writing, read these two files for the canonical structure and conventions:

- `./blueprint_template.md` — The required section structure. Every blueprint must include all sections from this template.
- `./blueprint_guideline.md` — Principles for what makes a good blueprint: high-level focus, technology decision rationale, conciseness.

These files are the source of truth. If anything in this skill conflicts with them, defer to the reference files.

## Before Writing

1. Read both reference files above.
2. Review the current conversation for design decisions, trade-offs discussed, and the preferred approach.
3. If a Linear ticket is referenced, read it for additional context.
4. Identify gaps — particularly around failure modes, SLIs/SLOs, cost implications, and rollout strategy. Ask the user before guessing.
5. Confirm the blueprint name/title and output path if not obvious.

## Before Reading/Ingesting

1. Read both reference files above to understand the expected structure and conventions.
2. Read the blueprint file the user has pointed to.
3. Parse it against the template structure — note which sections are present, which are missing or thin, and any deviations from the guideline conventions.
4. Summarize the blueprint's design proposal, key decisions, and trade-offs concisely for the user.
5. If the user's goal is implementation, identify the concrete technical decisions (technology choices, dependencies, failure handling, SLOs) that will drive the work.

## Output

- Write a single markdown file to `docs/blueprints/<kebab-case-name>.md` (or as specified by the user).
- Produce a complete first draft covering all sections from the template, then ask for feedback.

## Behavioral Rules

### Scope
- This is a high-level architectural document. Do NOT include:
  - Database table schemas or column definitions
  - Full API request/response specs
  - Implementation-level code snippets
  - Detailed class/module design
- If an API is part of the solution, acknowledge it exists and note that the spec will be documented separately.

### Style
- Be clear, direct, and concise. No filler phrases.
- Favor bullet points, tables, and clear headings over long paragraphs.
- Technology choices must include rationale. These decisions are expensive to reverse — document the "why," not just the "what."

### Requirements Section
- Do NOT copy-paste from a PRD. Reinterpret requirements through an engineering lens, focusing on those that drive technology choices.

### Design Proposal
- Present the single preferred approach with rationale, benefits, and drawbacks.
- If alternatives were discussed, summarize them under a "### Alternatives Considered" subsection with brief reasoning for why each was rejected.

### Failure Modes, SLIs, and Cost Analysis
- Use tables for structured data in these sections.
- Be concrete and specific — no generic failure scenarios or hand-wavy cost estimates.
- For SLIs/SLOs, note how each metric will be measured.

### Current System Overview
- If greenfield, note "N/A — greenfield" and move on.
- Include a diagram (mermaid or ASCII) if it clarifies the current state.
