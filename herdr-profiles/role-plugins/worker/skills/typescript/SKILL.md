---
name: typescript
description: Courier TypeScript standards for style, error handling, async work, imports, and tests. Use before writing or reviewing TypeScript in backend, services, or related repos.
---

# TypeScript Skill

Primary detailed reference:
- `../../../services/.claude/skills/TypeScript/SKILL.md`

Use that file when working deeply inside `services/`. For workspace-wide work, follow these baseline rules:

## Style

- Follow existing repo conventions before introducing new patterns.
- Prefer explicit types at exported boundaries.
- Avoid `any`; use `unknown` and narrow deliberately.
- Keep functions focused and small when practical.

## Error handling

- Validate user or external input at boundaries.
- Handle errors explicitly; do not swallow failures silently.
- Reuse the repo's existing error and logging patterns.

## Async / concurrency

- `await` intentional async work.
- Use `Promise.all()` only for genuinely independent operations.
- Preserve idempotency, ordering, and retry behavior in stream, queue, and job code.

## Testing

- Add or update tests for new behavior.
- Cover success, failure, and the main regression path.
- Do not reduce confidence in touched code paths.

## Imports and shared code

- Reuse shared libraries and existing helpers before introducing new abstractions.
- Respect repo boundaries and existing package import conventions.
