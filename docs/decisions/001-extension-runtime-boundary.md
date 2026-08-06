# ADR-001: Keep the Herdr extension runtime narrow and session-scoped

## Status

Accepted

## Context

Pi extensions are global code with process execution and model access. Herdr already owns the CLI protocol, pane lifecycle, agent integration state, and server resources. The extension must add a small tool surface without becoming a second authority or leaving behind hidden state.

## Decision

- Registration is gated by `HERDR_ENV=1`; disabled mode does no registration, CLI work, timers, sockets, or UI work.
- All Herdr access goes through the installed `herdr` executable via `pi.exec` with explicit argv and the caller's abort signal. The extension does not construct socket requests, infer IDs, or accept arbitrary executable fields.
- Ownership is a memory-only ledger for the current extension runtime. Launch, pane creation, and tab creation record authoritative opaque IDs through a narrow registry dependency. Session shutdown and replacement reset that ledger, but never close or delete Herdr resources.
- The extension-owned `config.json` is sampled for each wait. Reviewer calls use the injected Pi model registry, are in-process and tool-less, and use the configured model with fixed low thinking. Reviewers cannot mutate Herdr state.
- The model reviewer is a supervision boundary, not a Herdr pane or agent. Its bounded metadata/transcript input may classify progress, stalled, blocked, risk, completed, or unknown; it cannot satisfy the authoritative wait condition.

## Consequences

The extension remains inert outside Herdr and cannot silently redirect a caller to focused UI state. Reloads and session changes deliberately lose ownership authority, so resources remain visible for explicit manual handling. CLI or reviewer incompatibility fails closed instead of using guessed IDs, fallback models, or generic success.
