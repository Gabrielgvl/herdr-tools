# ADR-024: Use the protocol-22 prompt socket for local host qualification

## Status

Accepted for the local Pi-recipient-only hotfix gate. The Pi extension and
Claude MCP stdio entrypoints are both qualified with Pi recipients; Claude and
AGY recipients are explicitly blocked. The original full live integration and
the former Pi/Claude hotfix gate remain preserved but **NOTQUALIFIED**.

## Decision

Prompt and steer delivery, including a profile launch assignment, use the
protocol-22 native prompt endpoint selected by `HERDR_SOCKET_PATH`. The shared
`AgentPromptClient` sends one newline-delimited `agent.prompt` request and
validates its correlated acknowledgement. The Pi extension and the Claude MCP
stdio server use the same tool definitions and this same client. The old
literal `herdr agent prompt --stdin` construction is removed; it is not a
fallback, compatibility route, or silently retained legacy path.

The local release admits Pi, Claude, and Devin launch, prompt, and steer
recipients. A direct AGY recipient retains `AGY_UNQUALIFIED`. AGY fallback edges
are reported as refused attempts and removed before profile resources, grants,
attachments, topology, agent start, or prompt dispatch. Communication applies the
same refusal before attachment publication and on its final authoritative
identity re-read. Claude recipients cleared the provider-layer requalification
with exact recipient-generated body and identity evidence; qualification
objectives use operational phrasing rather than extraction-shaped phrasing.
Reads, waits, jobs, cancel, interrupt, and validated named keys remain unchanged.

The socket acknowledgement proves dispatch only. Exact pane, terminal, name,
kind, and complete `agent_session` identity remain mandatory before text is
sent. Launch still requires ADR-016's coherent readiness sample and ADR-015's
separate semantic-consumption confirmation. Communication remains
acknowledgement-based and non-blocking. No path sends Enter, retries, resends,
falls back, or cleans up after a dispatch whose effect is uncertain, preserving
the single-submit rules of ADR-013/015/016 and direct steering from ADR-004.
The one scoped exception is ADR-027's post-acknowledgement Devin composer
flush: after a validated `agent_prompted` ack leaves input queued on an
idle-or-done own pane, a single proven Enter completes that send. ADR-029
extends that exception to acknowledged busy `herdr_communicate` deliveries on
Devin targets under a shared cross-process lock and spent-frame fence; the
no-Enter rule otherwise stands.

Attachments remain Tools-owned. The recipient receives only the attachment
reference and must generate the exact complete body readback. Qualification
records the actual body-file bytes or SHA-256, joined recipient identity,
correlated native request ID, one socket request per logical delivery, and the
actual command exit. An acknowledgement alone is never recipient proof.

The separately named `HOTFIX_PI_ONLY` gate runs the exact Pi and MCP host files
in the fresh reserved `herdr-tools-pi-hotfix-readback` disposable session. It exercises the
seven-tool surface, Pi inline launch, normal prompt, steer against an
authoritative working target, and complete attachment-body readback; all five
mandatory receipts identify Pi recipients. The MCP receipt identifies detached
wait/job polling and the absence of Pi push/UI and explicit model-backed wait
review; it does not claim host behavior is identical. The old
`HOTFIX_PI_CLAUDE_ONLY` gate and the original full integration runner remain
preserved contracts, not Pi-only qualification evidence.

## Consequences

- Native prompt dispatch no longer depends on shell stdin or embeds prompt
  bodies in a CLI argument.
- Both supported host entrypoints exercise the shared implementation, while
  host-specific polling/reviewer limitations stay visible in receipts.
- Pi-only local qualification is a bounded hotfix gate, not Claude or AGY
  qualification, full migration, installation, reload, or remote delivery
  evidence.
