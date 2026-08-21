# ADR-005: Mandatory visible provenance for inter-agent text

## Status
Accepted

## Date
2026-08-07

## Context

Herdr currently delivers prompts by writing text and Enter into an agent TUI. The recipient sees an ordinary user-role message and cannot tell whether it was typed by a human or sent by another agent through the Herdr Pi tools. That ambiguity is unsafe for coordination and authority-sensitive work.

The extension controls two agent-to-agent text paths: `herdr_communicate` prompt/steer and `herdr_launch.initialPrompt`. Raw Herdr CLI/API input and named-key delivery are separate paths. Herdr and the supported agent TUIs do not expose an out-of-band authenticated sender channel.

## Decision

1. Every cross-pane `herdr_communicate` prompt/steer and every launch initial prompt receives a mandatory recipient-visible envelope:

   ```text
   [HERDR AGENT MESSAGE v1]
   from: coordinator (w1:p1)
   kind: steer
   authority: agent; not user/owner
   payload: all text after this blank line is sender-authored

   <caller-supplied payload>
   ```

2. The extension generates all metadata. Callers provide only payload and cannot override provenance, claim user authority, or opt out.
3. Delivery kinds are `assignment`, `prompt`, and `steer`.
4. Sender identity comes from the same fresh authoritative snapshot used to resolve the target. Display precedence is explicit agent name, pane label, agent kind, then pane ID only. The stable pane ID is always present.
5. If the fresh snapshot does not contain the caller pane, the operation fails before mutation with `SENDER_IDENTITY_UNAVAILABLE`.
6. `herdr_communicate` rejects self-targeting with `SELF_TARGET_REJECTED`.
7. Metadata is normalized to one line and bounded so labels cannot inject envelope fields. Payload bytes are preserved after the separating blank line.
8. Named keys remain raw lower-level control input and are not wrapped. The existing escape hatch, including `esc`, `escape`, and `ctrl+c`, is not routed through the verified cancel/interrupt semantic contract in `docs/decisions/014-explicit-turn-control.md` (ADR-014: Tools-only explicit turn control).
9. No automatic acknowledgement, message ID, or reply protocol is added. The sender pane ID is a deliberate reply target; tool success proves dispatch evidence, not comprehension.
10. The envelope is cooperative provenance, not cryptographic authentication. Raw terminal or CLI/API input can imitate the text. The implementation and documentation must not claim otherwise.

## Alternatives considered

### Label only `herdr_communicate`

Rejected. A launch initial prompt is also an assignment from one agent to another and must not appear user-originated.

### Allow caller-supplied sender or authority fields

Rejected. It permits identity spoofing and agent-to-user authority escalation.

### Permit opt-out

Rejected. A suppression flag destroys the recipient-side guarantee.

### Automatic acknowledgements or message IDs

Rejected for this slice. Acknowledgements create loops and can falsely imply understanding. The stable sender pane ID already supports deliberate replies.

### Cryptographically verified provenance

Deferred. Pi receives Herdr PTY input as ordinary interactive text, and other supported agent TUIs have different integration surfaces. Verified provenance requires receiver-side support across every agent kind or an upstream Herdr protocol and TUI integration. A Pi-only signature scheme would create inconsistent semantics.

## Consequences

- Cooperative recipients can immediately distinguish inter-agent coordination from user/owner instruction.
- Existing tool schemas stay simple; the original text field remains payload-only.
- Delivered text changes intentionally for all extension-mediated agent-to-agent paths.
- Self-steering through `herdr_communicate` is no longer allowed.
- Sender metadata is truthful to one fresh Herdr snapshot but is not atomically bound by Herdr to the subsequent PTY write.
- Raw Herdr CLI/API users remain responsible for their own provenance until upstream support exists.
