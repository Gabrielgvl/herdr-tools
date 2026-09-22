import { Text, type Component } from "@earendil-works/pi-tui";
import type { MessageDelivery } from "./messages/limits.js";

export interface CompactResult {
  operation: string;
  outcome: "success" | "reconciled" | "error" | "partial" | "cancelled" | "interrupted" | "agent_exited";
  targetId?: string;
  delivery?: MessageDelivery;
  code?: string;
  postState?: { agent_status?: string };
}

export interface RenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

export function formatCall(tool: string, operation: string, target?: string): string {
  return [tool, operation, target].filter(Boolean).join(" · ");
}

export function formatResult(result: CompactResult): string {
  if (result.outcome === "error") return `error ${result.code ?? "UNKNOWN"}${result.delivery ? ` · ${result.delivery}` : ""}${result.targetId ? ` · ${result.targetId}` : ""}`;
  const verb = result.outcome === "success" ? (result.operation === "inspect" ? "inspected" : result.operation === "communicate" ? "sent" : result.operation) : result.outcome;
  const delivery = result.delivery ? ` · ${result.delivery}` : "";
  const state = result.postState?.agent_status ? ` · ${result.postState.agent_status}` : "";
  return `${verb}${delivery}${result.targetId ? ` · ${result.targetId}` : ""}${state}`;
}

function style(theme: unknown, tone: "accent" | "success" | "warning" | "error" | "muted", text: string): string {
  if (typeof theme === "object" && theme !== null && "fg" in theme && typeof theme.fg === "function") {
    return (theme.fg as (name: string, value: string) => string)(tone, text);
  }
  return text;
}

class BoundedText implements Component {
  private readonly text: Text;

  constructor(value: string) {
    this.text = new Text(value, 0, 0);
  }

  render(width: number): string[] {
    return this.text.render(Math.max(1, width)).map((line) => line.replace(/\s+$/u, ""));
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

export function textComponent(text: string, theme?: unknown, tone?: "accent" | "success" | "warning" | "error" | "muted"): Component {
  return new BoundedText(tone ? style(theme, tone, text) : text);
}

interface ResultDetails {
  outcome?: unknown;
  operation_phase?: unknown;
  wait_result?: unknown;
  reason?: unknown;
  code?: unknown;
  delivery?: unknown;
  promptConsumption?: unknown;
  assignmentState?: unknown;
  agentStarted?: unknown;
  promptSubmitted?: unknown;
  recipientRegistered?: unknown;
  postState?: { agent_status?: string };
  finalState?: { agent_status?: string };
  paneId?: string;
  supervisorJobId?: unknown;
  supervision?: unknown;
  tabId?: string;
  jobId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 256 || value.trim() !== value) return false;
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/**
 * The launch recovery handles, for every failure the assignment-unconfirmed
 * window can produce: the whole window from the moment the prompt is built
 * until consumption is proven, not only the `PROMPT_UNCONFIRMED` verdict. A
 * pre-acknowledgement transport failure and a bounded transport failure carry
 * the same unrecoverable state — a supervised child that may already hold the
 * assignment — so the row must name the same pane and supervisor. Anything that
 * is not an internally consistent unconfirmed shape falls back to the generic
 * error row rather than inventing a handle.
 *
 * The prefix is fixed: `LAUNCH_FAILED` is the classified outcome of the whole
 * launch window, and any `details.code` a transport puts underneath it is a
 * cause, not the outcome. Deriving the prefix from that field made an untrusted
 * or unexpected code drop the pane and supervisor handles the operator needs, so
 * the field is not consulted here at all.
 */
function assignmentUnconfirmedRow(details: ResultDetails | undefined): string | undefined {
  if (details?.assignmentState !== "unconfirmed"
    || details.agentStarted !== true
    || typeof details.promptSubmitted !== "boolean"
    || details.recipientRegistered !== false
    || (details.promptConsumption !== undefined && details.promptConsumption !== "unconfirmed")
    || !compactIdentifier(details.paneId)
    || !record(details.supervision)) return undefined;
  const supervision = details.supervision;
  if (supervision.state !== "active") return undefined;
  if (!compactIdentifier(supervision.jobId)) return undefined;
  const child = supervision.child;
  if (!record(child) || child.paneId !== details.paneId) return undefined;
  if (details.supervisorJobId !== undefined && details.supervisorJobId !== supervision.jobId) return undefined;
  return `error LAUNCH_FAILED · assignment unconfirmed · ${details.paneId} · supervisor ${supervision.jobId}`;
}

export function resultForRender(
  operation: string,
  result: { details?: unknown; isError?: boolean },
  options: RenderOptions = {},
  targetId?: string,
): { text: string; tone: "success" | "warning" | "error" | "muted" } {
  if (options.isPartial) return { text: `partial · ${operation}`, tone: "warning" };
  const details = result.details as ResultDetails | undefined;
  if (operation === "wait" && details?.operation_phase === "accepted") return { text: `accepted${typeof details.jobId === "string" ? ` · ${details.jobId}` : ""}`, tone: "muted" };
  if (operation === "wait" && details?.operation_phase === "running") return { text: `running${typeof details.jobId === "string" ? ` · ${details.jobId}` : ""}`, tone: "muted" };
  if (operation === "wait" && details?.operation_phase === "cancel_requested") return { text: `cancel_requested${typeof details.jobId === "string" ? ` · ${details.jobId}` : ""}`, tone: "warning" };
  if (operation === "wait" && details?.operation_phase === "settled") {
    const waitResult = typeof details.wait_result === "string" ? details.wait_result : "unknown";
    const tone = waitResult === "failed" ? "error" : waitResult === "manager_judgment_required" || waitResult === "cancelled" || waitResult === "unknown" ? "warning" : "muted";
    return { text: `settled · ${waitResult}${targetId ? ` · ${targetId}` : ""}`, tone };
  }
  if (details?.outcome === "partial") return { text: `partial${targetId ? ` · ${targetId}` : ""}`, tone: "warning" };
  // The uniform launch result reports abstained and failed without throwing;
  // they must not fall through to the success row.
  if (details?.outcome === "abstained") return { text: `abstained${targetId ? ` · ${targetId}` : ""}`, tone: "warning" };
  if (details?.outcome === "failed") return { text: `failed${targetId ? ` · ${targetId}` : ""}`, tone: "error" };
  if (result.isError && operation === "launch") {
    const row = assignmentUnconfirmedRow(details);
    if (row !== undefined) return { text: row, tone: "error" };
  }
  if (result.isError) {
    const code = typeof details?.code === "string" ? details.code : "UNKNOWN";
    const delivery = details?.delivery === "inline" || details?.delivery === "attachment" ? details.delivery : undefined;
    return { text: formatResult({ operation, outcome: "error", code, delivery, targetId }), tone: "error" };
  }
  if (!details || typeof details.outcome !== "string") return { text: formatResult({ operation, outcome: "error", code: "UNKNOWN", targetId }), tone: "error" };
  if (details.outcome === "cancelled" || details.outcome === "interrupted" || details.outcome === "agent_exited") {
    return { text: formatResult({ operation, outcome: details.outcome, targetId, postState: details.postState ?? details.finalState }), tone: details.outcome === "agent_exited" ? "warning" : "success" };
  }
  const delivery = details.delivery === "inline" || details.delivery === "attachment" ? details.delivery : undefined;
  return { text: formatResult({ operation, outcome: "success", delivery, targetId, postState: details.postState }), tone: "success" };
}

export function renderResultComponent(
  operation: string,
  result: { details?: unknown; isError?: boolean },
  options: RenderOptions = {},
  theme?: unknown,
  targetId?: string,
): Component {
  const rendered = resultForRender(operation, result, options, targetId);
  return textComponent(rendered.text, theme, rendered.tone);
}
