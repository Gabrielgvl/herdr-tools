# ADR-018: Make `herdr_wait` detached-only

## Status

Accepted; supersedes ADR-012 and the synchronous execution portion of ADR-002.

## Date

2026-08-30

## Context

`herdr_wait` previously exposed two public execution modes. A caller could keep
its tool turn occupied with a synchronous wait or register a session-scoped
background job. That split duplicated the public contract around settlement,
progress, cancellation, and rendering, while all wait lifecycle state already
belonged in the job registry.

The wait engine still needs to retain authoritative target polling, reviewer
cadence, bounded progress, terminal evidence, Pi notifications, active-wait UI,
and MCP job polling. The public API should make that lifecycle explicit rather
than allowing a caller to accidentally hold a tool turn open.

## Decision

- `WaitParamsSchema` contains no execution-mode field. Any execution-mode field,
  including both boolean spellings used by earlier revisions, is rejected as an
  unknown field along with every other unknown field. No compatibility parser or
  fallback is provided.
- Every `herdr_wait` call first validates parameters, loads extension-owned
  settings, resolves the live caller context and exact targets, and rejects
  duplicate resolved resources. These preflight failures use the initiating
  signal and create no job.
- After successful preflight, every call registers one session-scoped job with
  copied request/settings/target evidence, a fresh per-job cancellation signal,
  and the existing prepared wait engine. The tool returns the bounded detached
  acknowledgement immediately. Operation phase and terminal wait result,
  reviewer findings, progress, and cancellation evidence are observed through
  `herdr_jobs`.
- The public job vocabulary is deliberately narrow: operation phase is one of
  `accepted`, `running`, `cancel_requested`, or `settled`; `wait_result` is
  absent before settlement and then is one of `condition_met`, `timed_out`,
  `manager_judgment_required`, `failed`, `cancelled`, or `unknown`.
- The prepared wait engine remains internal to detached jobs. It retains the
  authoritative native/composite observation and reviewer-cadence behavior,
  and sends bounded state and reviewer progress to the registry. The initiating
  `onUpdate` callback is never used after registration, and no foreground result
  shape is exposed.
- The wait tool keeps only its compact call renderer and detached
  acknowledgement/error result renderer. Foreground execution-specific result
  and progress rendering paths are removed. Pi terminal notifications and the
  active-wait footer/widget remain unchanged; the MCP host remains polling-only.
- `manager-pi` receives `herdr_jobs` because inspecting or cancelling a wait is
  mandatory for every public wait call.

## Alternatives considered

### Retain an explicit synchronous opt-out

Rejected: an opt-out would preserve the split lifecycle and keep callers
responsible for choosing between a tool-turn result and a job result. The job
registry is already the single owner of wait settlement and cancellation.

### Silently accept an obsolete execution-mode field

Rejected: accepting an obsolete field would be a compatibility layer and would
hide a caller contract error. Strict schema and runtime rejection make the new
API unambiguous.

### Remove reviewer, progress, or Pi UI behavior with foreground execution

Rejected: those behaviors belong to the detached job lifecycle, not to the
removed synchronous call mode. Long waits still use the configured reviewer
cadence, registry progress remains inspectable, and Pi retains notifications and
active-wait visibility.

### Add a second detached implementation

Rejected: the prepared wait engine is retained and used by every registered job.
A second implementation would risk drift in timeout precedence, authoritative
reads, reviewer handling, and terminal evidence.

## Consequences

Every caller receives a job ID and must use `herdr_jobs` for settlement and
cancellation. Short waits detach just like long waits, so MCP clients no longer
need a tool-call timeout for wait execution and Pi callers cannot receive a
synchronous wait result. Preflight remains fail-closed and does not allocate a
job when validation, settings, context, or target resolution fails. Historical
`target_evidence` is explicitly marked `currency: "historical_non_current"`
and cannot be used as current target truth.

The registry, notification, active-wait UI, and bounded evidence tests remain
the authoritative wait observability gates. Existing ADR-002 and ADR-012 files
remain in the decision log as historical records; this ADR is the current public
contract.
