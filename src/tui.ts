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

export function resultForRender(
  operation: string,
  result: { details?: unknown; isError?: boolean },
  options: RenderOptions = {},
  targetId?: string,
): { text: string; tone: "success" | "warning" | "error" | "muted" } {
  if (options.isPartial) return { text: `partial · ${operation}`, tone: "warning" };
  const details = result.details as { outcome?: unknown; operation_phase?: unknown; wait_result?: unknown; reason?: unknown; code?: unknown; delivery?: unknown; postState?: { agent_status?: string }; finalState?: { agent_status?: string }; paneId?: string; tabId?: string; jobId?: string } | undefined;
  if (operation === "wait" && details?.operation_phase === "accepted") return { text: `accepted${typeof details.jobId === "string" ? ` · ${details.jobId}` : ""}`, tone: "muted" };
  if (operation === "wait" && details?.operation_phase === "running") return { text: `running${typeof details.jobId === "string" ? ` · ${details.jobId}` : ""}`, tone: "muted" };
  if (operation === "wait" && details?.operation_phase === "cancel_requested") return { text: `cancel_requested${typeof details.jobId === "string" ? ` · ${details.jobId}` : ""}`, tone: "warning" };
  if (operation === "wait" && details?.operation_phase === "settled") {
    const waitResult = typeof details.wait_result === "string" ? details.wait_result : "unknown";
    const tone = waitResult === "failed" ? "error" : waitResult === "manager_judgment_required" || waitResult === "cancelled" || waitResult === "unknown" ? "warning" : "muted";
    return { text: `settled · ${waitResult}${targetId ? ` · ${targetId}` : ""}`, tone };
  }
  if (details?.outcome === "partial") return { text: `partial${targetId ? ` · ${targetId}` : ""}`, tone: "warning" };
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
